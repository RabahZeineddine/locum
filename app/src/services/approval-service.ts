import { and, desc, eq, lte, type SQL } from "drizzle-orm";
import { z } from "zod";
import { ReviewFinding, ReviewVerdict } from "../config/types.js";
import { STUCK_AFTER_SECONDS } from "../approval/gate.js";
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
    summary?: unknown,
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
    const resumo = z.string().optional().safeParse(summary);

    const escrita = this.db
      .update(schema.approvals)
      .set({
        payload: {
          ...(atual.payload as object),
          findings: lidos.data,
          ...(veredito.data !== undefined && { verdict: veredito.data }),
          ...(resumo.data !== undefined && { summary: resumo.data }),
        },
      })
      .where(and(eq(schema.approvals.id, approvalId), eq(schema.approvals.status, "pending")))
      .run();
    // A decisão pode ter começado a publicar entre a leitura e aqui; gravar
    // por cima faria o histórico mostrar um texto diferente do que saiu.
    if (escrita.changes !== 1) throw new Error(`aprovação ${approvalId} já resolvida`);

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

    const escrita = this.db
      .update(schema.approvals)
      .set({ payload: { ...(atual.payload as object), text: lido.data } })
      .where(and(eq(schema.approvals.id, approvalId), eq(schema.approvals.status, "pending")))
      .run();
    if (escrita.changes !== 1) throw new Error(`aprovação ${approvalId} já resolvida`);

    const [novo] = await this.query(eq(schema.approvals.id, approvalId));
    return novo!;
  }

  /**
   * Converte achados de um PR review em proposta de história no Tracker (Shortcut/Jira).
   *
   * Mantém a integridade arquitetural: não cria direto no Shortcut por fora,
   * mas insere uma pendência oficial de `tracker.create_issue` na fila,
   * pronta para ser aprovada e publicada com 1 clique.
   */
  async createTrackerIssueProposal(
    approvalId: string,
    trackerId: string,
  ): Promise<{ issueApprovalId: string }> {
    const [atual] = await this.query(eq(schema.approvals.id, approvalId));
    if (!atual) throw new Error(`aprovação ${approvalId} não encontrada`);
    if (atual.kind !== REVIEW_KIND) {
      throw new Error(`apenas revisões de código podem gerar tarefas no tracker`);
    }

    const payload = atual.payload as {
      pull?: number;
      repo?: string;
      owner?: string;
      title?: string;
      url?: string;
      findings?: Array<{ file?: string; line?: number; problem?: string; fix?: string; severity?: string }>;
      summary?: string;
    };

    const { trackerService } = await import("./tracker-service.js");
    const project = await trackerService.defaultProject(trackerId);
    if (!project) {
      throw new Error(`o tracker "${trackerId}" não possui um projeto configurado`);
    }

    const pullUrl = payload.url ?? (payload.owner && payload.repo && payload.pull ? `https://github.com/${payload.owner}/${payload.repo}/pull/${payload.pull}` : "");
    const titulo = `Fix PR #${payload.pull ?? ""}: ${payload.title ?? "Apontamentos de code review"}`.trim();
    
    const corpoAchados = (payload.findings ?? [])
      .map((f) => `* **${f.file ?? "geral"}${f.line ? `:${f.line}` : ""}** [${f.severity ?? "defeito"}]: ${f.problem ?? ""}${f.fix ? `\n  _Sugestão:_ ${f.fix}` : ""}`)
      .join("\n\n");
    const corpo = [
      payload.summary ? `### Resumo da Auditoria\n${payload.summary}\n` : "",
      "### Apontamentos a Resolver\n",
      corpoAchados || "Verificar apontamentos no pull request correspondente.",
      pullUrl ? `\n\n---\n**Pull Request:** ${pullUrl}` : "",
    ].filter(Boolean).join("\n");

    const id = (await import("node:crypto")).randomUUID();
    const externalId = `${atual.runId}:tracker:${Date.now()}`;

    this.db.insert(schema.approvals).values({
      id,
      runId: atual.runId,
      stepId: atual.stepId,
      kind: "tracker.create_issue",
      payload: {
        tracker: trackerId,
        project,
        title: titulo,
        body: corpo,
        pullRequestUrl: pullUrl,
      },
      status: "pending",
      externalId,
    }).run();

    return { issueApprovalId: id };
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
