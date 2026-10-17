import { and, desc, eq, inArray, like, lte, type SQL } from "drizzle-orm";
import { z } from "zod";
import { STUCK_AFTER_SECONDS } from "../approval/gate.js";
import { impressaoDe } from "../approval/impressao.js";
import type { EsquemaJson } from "../config/referencias.js";
import { propostoPorDe, type PropostoPor } from "../config/types.js";
import { recusarSeArquivada } from "../db/arquivada.js";
import { db as defaultDb, schema } from "../db/index.js";
import { buildGate } from "../executor/build.js";
import { PREFIXO_DA_TROCA_POR_LIMITE } from "./limites-service.js";

type Db = typeof defaultDb;

/** Quem edita: a pessoa na tela, ou a conversa de um run (o id dele). */
export type OrigemDaEdicao = "pessoa" | { conversa: string };

export type ApprovalRow = typeof schema.approvals.$inferSelect;

/** Pendencia com o passo e o agent que a criaram, que e o que a inbox mostra. */
export interface ApprovalSummary extends ApprovalRow {
  stepKey: string;
  stepName: string;
  agentId: string;
  agentName: string;
  agentVersion: number;
  /** "feito com <modelo> por limite do <provedor>", quando um passo do run trocou de modelo por limite. */
  trocaPorLimite: string | null;
  /** Quem propôs o passo avulso de onde vem a pendência. Nulo quando o passo é do fluxo. */
  propostoPor: PropostoPor | null;
  /** A impressão do payload: quem decide manda de volta a do que viu, e a decisão só vale se o payload é o mesmo. */
  hash: string;
}

/**
 * Leitura da fila de aprovacao. Linha de comando, servidor MCP e interface
 * listam por aqui.
 *
 * A decisao continua na ApprovalGate de proposito: ela e a unica porta de
 * saida, e um servico de consulta que tambem soubesse aprovar abriria um
 * segundo caminho de publicacao. Ver ADR 0002.
 */
export class ApprovalService {
  constructor(
    private readonly db: Db = defaultDb,
    /** O esquema dos campos editáveis da ação, perguntado ao handler dela. */
    private readonly esquemaDosCampos: (kind: string) => EsquemaJson | undefined = (kind) => buildGate().camposEditaveis(kind),
  ) {}

  async listPending(): Promise<ApprovalSummary[]> {
    return this.query(eq(schema.approvals.status, "pending"));
  }

  /**
   * Pendências que começaram a publicar e não terminaram: o app caiu no meio.
   * Não voltam para a fila sozinhas, porque a mensagem pode ter saído, e ficam
   * aqui até alguém conferir e dizer o que aconteceu.
   */
  async listStuck(): Promise<ApprovalSummary[]> {
    const limite = Math.floor(Date.now() / 1000) - STUCK_AFTER_SECONDS;
    return this.query(and(eq(schema.approvals.status, "publishing"), lte(schema.approvals.decidedAt, limite))!);
  }

  async get(approvalId: string): Promise<ApprovalSummary | undefined> {
    const [row] = await this.query(eq(schema.approvals.id, approvalId));
    return row;
  }

  /** O esquema dos campos que a pendência desta ação aceita editar (`ActionHandler.camposEditaveis`). */
  camposEditaveisDe(kind: string): EsquemaJson | undefined {
    return this.esquemaDosCampos(kind);
  }

  /**
   * Grava o que vai sair, antes de sair.
   *
   * Editar não é publicar: o texto revisado fica na pendência e continua
   * esperando. Só a ApprovalGate publica, e só depois do clique.
   *
   * Só os campos que o handler da ação declara em `camposEditaveis` mudam, cada
   * um validado pelo esquema dele. O resto do payload (dono, repositório, pull
   * request, conversa) é o que o executor gravou: um payload inteiro vindo da
   * janela poderia redirecionar a publicação enquanto a tela mostra o de sempre,
   * e a pessoa aprovaria achando que é o que está vendo.
   *
   * Pendência já resolvida não aceita edição. Sem essa trava, alterar o payload
   * depois do envio mudaria o registro do que foi publicado, e o histórico
   * passaria a mentir sobre o que saiu.
   *
   * Pela conversa (`origem.conversa` é o run dela) vale mais: a pendência tem de
   * ser desse run e a automação não pode estar arquivada, conferido na mesma
   * transação que grava. A edição fica marcada em `alteradaPelaConversaEm`.
   */
  async editarCampos(approvalId: string, campos: Record<string, unknown>, origem: OrigemDaEdicao): Promise<ApprovalSummary> {
    this.db.transaction((tx) => {
      const atual = tx
        .select({ approval: schema.approvals, agentId: schema.agentVersions.agentId })
        .from(schema.approvals)
        .innerJoin(schema.runs, eq(schema.approvals.runId, schema.runs.id))
        .innerJoin(schema.agentVersions, eq(schema.runs.agentVersionId, schema.agentVersions.id))
        .where(eq(schema.approvals.id, approvalId))
        .get();
      if (!atual) throw new Error(`aprovação ${approvalId} não encontrada`);
      const { approval } = atual;
      if (origem !== "pessoa") {
        if (approval.runId !== origem.conversa) throw new Error(`aprovação ${approvalId} é de outro run, e a conversa só edita as do run dela`);
        recusarSeArquivada(tx, atual.agentId);
      }
      if (approval.status !== "pending") throw new Error(`aprovação ${approvalId} já resolvida: ${approval.status}`);

      const editaveis = this.camposEditaveisDe(approval.kind)?.properties ?? {};
      const novos: Record<string, unknown> = {};
      for (const [campo, valor] of Object.entries(campos)) {
        const esquema = editaveis[campo];
        if (esquema === undefined) throw new Error(`a ação ${approval.kind} não aceita edição de ${campo}`);
        const lido = z.fromJSONSchema(esquema as never).safeParse(valor);
        if (!lido.success) throw new Error(`${campo} fora do formato: ${z.prettifyError(lido.error)}`);
        novos[campo] = lido.data;
      }

      const escrita = tx
        .update(schema.approvals)
        .set({
          payload: { ...(approval.payload as object), ...novos },
          ...(origem === "pessoa" ? {} : { alteradaPelaConversaEm: Math.floor(Date.now() / 1000) }),
        })
        .where(and(eq(schema.approvals.id, approvalId), eq(schema.approvals.status, "pending")))
        .run();
      // A decisão pode ter começado a publicar entre a leitura e aqui; gravar
      // por cima faria o histórico mostrar um texto diferente do que saiu.
      if (escrita.changes !== 1) throw new Error(`aprovação ${approvalId} já resolvida`);
    });
    return (await this.get(approvalId))!;
  }

  /** A edição da pessoa na tela de revisão: achados, e veredito e resumo quando vêm. Ausente fica o que estava. */
  updateFindings(approvalId: string, findings: unknown, verdict?: unknown, summary?: unknown): Promise<ApprovalSummary> {
    return this.editarCampos(
      approvalId,
      { findings, ...(verdict === undefined ? {} : { verdict }), ...(summary === undefined ? {} : { summary }) },
      "pessoa",
    );
  }

  /** A edição da pessoa no texto de uma resposta. Espaço nas pontas não conta. */
  updateText(approvalId: string, text: unknown): Promise<ApprovalSummary> {
    return this.editarCampos(approvalId, { text: typeof text === "string" ? text.trim() : text }, "pessoa");
  }

  private async query(where: SQL): Promise<ApprovalSummary[]> {
    const rows = await this.db
      .select({
        approval: schema.approvals,
        stepKey: schema.steps.stepKey,
        stepName: schema.steps.name,
        stepInput: schema.steps.input,
        agentId: schema.agents.id,
        agentName: schema.agents.name,
        agentVersion: schema.agentVersions.version,
      })
      .from(schema.approvals)
      .innerJoin(schema.steps, eq(schema.approvals.stepId, schema.steps.id))
      .innerJoin(schema.runs, eq(schema.approvals.runId, schema.runs.id))
      .innerJoin(schema.agentVersions, eq(schema.runs.agentVersionId, schema.agentVersions.id))
      .innerJoin(schema.agents, eq(schema.agentVersions.agentId, schema.agents.id))
      .where(where)
      .orderBy(desc(schema.approvals.createdAt));

    const runs = [...new Set(rows.map((r) => r.approval.runId))];
    const trocas = new Map<string, string>();
    if (runs.length > 0) {
      const passos = await this.db
        .select({ runId: schema.steps.runId, motivo: schema.steps.substitutionReason })
        .from(schema.steps)
        .where(and(inArray(schema.steps.runId, runs), like(schema.steps.substitutionReason, `${PREFIXO_DA_TROCA_POR_LIMITE}%`)));
      for (const p of passos) if (p.motivo !== null) trocas.set(p.runId, p.motivo);
    }

    return rows.map((r) => ({
      ...r.approval,
      hash: impressaoDe(r.approval.payload),
      trocaPorLimite: trocas.get(r.approval.runId) ?? null,
      stepKey: r.stepKey,
      stepName: r.stepName,
      propostoPor: propostoPorDe(r.stepInput),
      agentId: r.agentId,
      agentName: r.agentName,
      agentVersion: r.agentVersion,
    }));
  }
}

export const approvalService = new ApprovalService();
