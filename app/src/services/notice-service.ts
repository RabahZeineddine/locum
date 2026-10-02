import { and, desc, eq, gt, sql, type SQL } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";

type Db = typeof defaultDb;

export type NoticeKind = "critical_finding" | "run_failed";

/**
 * Um aviso digno de interromper quem esta usando a maquina.
 *
 * A chave e por run e por tipo, e nao por achado, porque uma review com oito
 * problemas criticos e uma noticia so: oito notificacoes empilhadas viram
 * ruido e a pessoa desliga a notificacao do Locum inteiro.
 */
export interface Notice {
  key: string;
  runId: string;
  kind: NoticeKind;
  /** De quem e o run. Quem escreve a frase e a casca, com o dicionario dela. */
  agentName: string;
  /** So em `run_failed`, e so quando o run deixou mensagem. */
  error?: string;
  /** Quantos achados criticos o run juntou. Zero nos avisos de falha. */
  criticalCount: number;
  /** Quando a noticia aconteceu, em segundos, para ordenar e para o corte. */
  at: number;
}

/** O que uma pendencia da fila oferece antes de virar aviso. */
export interface ApprovalCandidate {
  runId: string;
  agentName: string;
  createdAt: number;
  payload: unknown;
}

export interface NoticeFilter {
  /** Segundos. Corta o historico: aviso velho nao interrompe ninguem. */
  since?: number;
  limit?: number;
}

/**
 * Decide o que merece notificacao nativa. Mora no servico, e nao no processo
 * principal do Electron, porque a regra de agrupar por run e de que severidade
 * interrompe e a mesma para qualquer casca que venha depois.
 *
 * O que sai daqui e o fato, e nao a frase: titulo e corpo sao montados por quem
 * exibe, com o dicionario do idioma escolhido. Texto pronto no servico voltaria
 * a prender o aviso a um idioma so, e nem a linha de comando nem o servidor MCP
 * falam necessariamente o mesmo da janela.
 *
 * Nao guarda o que ja foi avisado: isso e estado de sessao e fica em quem
 * entrega, em electron/notify.ts.
 */
export class NoticeService {
  constructor(private readonly db: Db = defaultDb) {}

  async pending(filter: NoticeFilter = {}): Promise<Notice[]> {
    const [failed, critical] = await Promise.all([
      this.failedRuns(filter),
      this.criticalApprovals(filter),
    ]);

    return [...failed, ...critical]
      .sort((a, b) => b.at - a.at)
      .slice(0, filter.limit ?? 50);
  }

  private async failedRuns(filter: NoticeFilter): Promise<Notice[]> {
    // A hora da falha, e não a da criação: um run longo criado antes de cem
    // falhas curtas ficaria fora do teto de leitura e nunca viraria aviso, e
    // o corte por data o descartaria como velho no exato momento em que falhou.
    const quando = sql<number>`coalesce(${schema.runs.endedAt}, ${schema.runs.createdAt})`;
    const rows = await this.db
      .select({
        runId: schema.runs.id,
        error: schema.runs.error,
        endedAt: schema.runs.endedAt,
        createdAt: schema.runs.createdAt,
        agentName: schema.agents.name,
      })
      .from(schema.runs)
      .innerJoin(schema.agentVersions, eq(schema.runs.agentVersionId, schema.agentVersions.id))
      .innerJoin(schema.agents, eq(schema.agentVersions.agentId, schema.agents.id))
      .where(every(eq(schema.runs.status, "failed"), cutoff(quando, filter.since)))
      .orderBy(desc(quando))
      .limit(filter.limit ?? 50);

    return rows.map((r) => ({
      key: `run_failed:${r.runId}`,
      runId: r.runId,
      kind: "run_failed" as const,
      agentName: r.agentName,
      error: r.error ?? undefined,
      criticalCount: 0,
      at: r.endedAt ?? r.createdAt,
    }));
  }

  private async criticalApprovals(filter: NoticeFilter): Promise<Notice[]> {
    const rows = await this.db
      .select({
        runId: schema.approvals.runId,
        payload: schema.approvals.payload,
        createdAt: schema.approvals.createdAt,
        agentName: schema.agents.name,
      })
      .from(schema.approvals)
      .innerJoin(schema.runs, eq(schema.approvals.runId, schema.runs.id))
      .innerJoin(schema.agentVersions, eq(schema.runs.agentVersionId, schema.agentVersions.id))
      .innerJoin(schema.agents, eq(schema.agentVersions.agentId, schema.agents.id))
      .where(
        every(eq(schema.approvals.status, "pending"), cutoff(schema.approvals.createdAt, filter.since)),
      )
      .orderBy(desc(schema.approvals.createdAt));

    return criticalNotices(rows);
  }
}

/**
 * Junta as pendencias de um mesmo run num aviso so e conta os criticos.
 *
 * Fica exportada e pura para poder ser exercitada sem banco: o agrupamento e a
 * parte que erra, e o smoke do Electron nao pode plantar run de mentira no
 * banco de quem desenvolve so para conferir uma contagem.
 */
export function criticalNotices(candidates: ApprovalCandidate[]): Notice[] {
  const porRun = new Map<string, { agentName: string; at: number; criticals: number }>();

  for (const c of candidates) {
    const criticals = countCritical(c.payload);
    if (criticals === 0) continue;

    const atual = porRun.get(c.runId);
    if (atual === undefined) {
      porRun.set(c.runId, { agentName: c.agentName, at: c.createdAt, criticals });
      continue;
    }
    atual.criticals += criticals;
    // O aviso carrega a hora da pendencia mais nova do run, que e a que
    // acabou de chegar na fila.
    atual.at = Math.max(atual.at, c.createdAt);
  }

  return [...porRun].map(([runId, dados]) => ({
    key: `critical_finding:${runId}`,
    runId,
    kind: "critical_finding" as const,
    agentName: dados.agentName,
    criticalCount: dados.criticals,
    at: dados.at,
  }));
}

/**
 * Le os achados do que sairia publicado. A tabela `findings` so e preenchida
 * quando o reconciliador roda, bem depois, entao na hora em que a pendencia
 * entra na fila o achado so existe dentro do payload.
 */
function countCritical(payload: unknown): number {
  if (payload === null || typeof payload !== "object") return 0;
  const raw = (payload as { findings?: unknown }).findings;
  if (!Array.isArray(raw)) return 0;

  return raw.filter((item) => {
    if (item === null || typeof item !== "object") return false;
    return (item as { severity?: unknown }).severity === "critical";
  }).length;
}

/** Corte por data, ou nada quando quem chamou nao pediu corte. */
function cutoff(column: Parameters<typeof gt>[0] | SQL, since: number | undefined): SQL | undefined {
  return since === undefined ? undefined : gt(column, since);
}

function every(...conditions: (SQL | undefined)[]): SQL | undefined {
  const presentes = conditions.filter((c): c is SQL => c !== undefined);
  return presentes.length > 0 ? and(...presentes) : undefined;
}

export const noticeService = new NoticeService();
