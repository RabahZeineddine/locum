import { desc, eq, type SQL } from "drizzle-orm";
import { z } from "zod";
import { ReviewFinding, ReviewVerdict } from "../config/types.js";
import { db as defaultDb, schema } from "../db/index.js";

type Db = typeof defaultDb;

const REVIEW_KIND = "github.review_comment";

/** Ações cuja pendência é uma mensagem, e o texto dela é o que a pessoa edita. */
const MESSAGE_KINDS: readonly string[] = ["slack.post", "teams.post"];

/** O mesmo teto que os handlers aplicam ao texto que vem do modelo. */
const TETO_DE_MENSAGEM = 3000;

export type ApprovalRow = typeof schema.approvals.$inferSelect;

/** Pendencia com o passo e o agent que a criaram, que e o que a inbox mostra. */
export interface ApprovalSummary extends ApprovalRow {
  stepKey: string;
  stepName: string;
  agentId: string;
  agentName: string;
  agentVersion: number;
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
  constructor(private readonly db: Db = defaultDb) {}

  async listPending(): Promise<ApprovalSummary[]> {
    return this.query(eq(schema.approvals.status, "pending"));
  }

  async get(approvalId: string): Promise<ApprovalSummary | undefined> {
    const [row] = await this.query(eq(schema.approvals.id, approvalId));
    return row;
  }

  /**
   * Grava o que vai sair, antes de sair.
   *
   * Editar não é publicar: o texto revisado fica na pendência e continua
   * esperando. Só a ApprovalGate publica, e só depois do clique.
   *
   * Só a lista de achados e o veredito são editáveis. Dono, repositório e pull request são os
   * que o executor gravou, e o payload que a janela mandasse inteiro poderia
   * redirecionar a publicação para outro pull request enquanto a tela mostra o
   * de sempre: a pessoa aprovaria achando que é o que está vendo.
   *
   * Pendência já resolvida não aceita edição. Sem essa trava, alterar o payload
   * depois do envio mudaria o registro do que foi publicado, e o histórico
   * passaria a mentir sobre o que saiu.
   *
   * Veredito ausente fica o que estava gravado.
   */
  async updateFindings(
    approvalId: string,
    findings: unknown,
    verdict?: unknown,
  ): Promise<ApprovalSummary> {
    const [atual] = await this.query(eq(schema.approvals.id, approvalId));
    if (!atual) throw new Error(`aprovação ${approvalId} não encontrada`);
    if (atual.status !== "pending") {
      throw new Error(`aprovação ${approvalId} já resolvida: ${atual.status}`);
    }
    if (atual.kind !== REVIEW_KIND) {
      throw new Error(`aprovação ${approvalId} é ${atual.kind}, e só pendência de review tem achados`);
    }

    const lidos = z.array(ReviewFinding).safeParse(findings);
    if (!lidos.success) {
      throw new Error(`achado fora do formato: ${z.prettifyError(lidos.error)}`);
    }
    const veredito = ReviewVerdict.optional().safeParse(verdict);
    if (!veredito.success) {
      throw new Error(`veredito fora do formato: ${String(verdict)}`);
    }

    await this.db
      .update(schema.approvals)
      .set({
        payload: {
          ...(atual.payload as object),
          findings: lidos.data,
          ...(veredito.data !== undefined && { verdict: veredito.data }),
        },
      })
      .where(eq(schema.approvals.id, approvalId));

    const [novo] = await this.query(eq(schema.approvals.id, approvalId));
    return novo!;
  }

  /**
   * Troca o texto de uma resposta de Slack ou Teams antes de ela sair.
   *
   * Mesma trava de `updateFindings`: só o texto muda. Canal, thread e
   * servidor são os que o handler conferiu contra o que o Locum leu, e um
   * payload inteiro vindo da janela poderia mandar a resposta para outra
   * conversa enquanto a tela mostra a de sempre.
   */
  async updateText(approvalId: string, text: unknown): Promise<ApprovalSummary> {
    const [atual] = await this.query(eq(schema.approvals.id, approvalId));
    if (!atual) throw new Error(`aprovação ${approvalId} não encontrada`);
    if (atual.status !== "pending") {
      throw new Error(`aprovação ${approvalId} já resolvida: ${atual.status}`);
    }
    if (!MESSAGE_KINDS.includes(atual.kind)) {
      throw new Error(`aprovação ${approvalId} é ${atual.kind}, e só resposta de Slack ou Teams tem texto`);
    }

    const lido = z.string().trim().min(1, "a mensagem não pode ficar vazia").max(TETO_DE_MENSAGEM).safeParse(text);
    if (!lido.success) throw new Error(`texto fora do formato: ${z.prettifyError(lido.error)}`);

    await this.db
      .update(schema.approvals)
      .set({ payload: { ...(atual.payload as object), text: lido.data } })
      .where(eq(schema.approvals.id, approvalId));

    const [novo] = await this.query(eq(schema.approvals.id, approvalId));
    return novo!;
  }

  private async query(where: SQL): Promise<ApprovalSummary[]> {
    const rows = await this.db
      .select({
        approval: schema.approvals,
        stepKey: schema.steps.stepKey,
        stepName: schema.steps.name,
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

    return rows.map((r) => ({
      ...r.approval,
      stepKey: r.stepKey,
      stepName: r.stepName,
      agentId: r.agentId,
      agentName: r.agentName,
      agentVersion: r.agentVersion,
    }));
  }
}

export const approvalService = new ApprovalService();
