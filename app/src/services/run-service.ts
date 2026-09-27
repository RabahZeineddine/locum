import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { AgentSpec } from "../config/types.js";
import { buildExecutor } from "../executor/build.js";

type Db = typeof defaultDb;

export type RunRow = typeof schema.runs.$inferSelect;
export type StepRow = typeof schema.steps.$inferSelect;

/** O minimo do executor que este servico usa, para poder trocar em teste. */
export interface StepRunner {
  execute(runId: string): Promise<"done" | "paused" | "failed">;
}

export interface RunFilter {
  status?: string | string[];
  agentId?: string;
  initiativeId?: string;
  limit?: number;
}

/** Run com o agent que rodou, que e o que a lista precisa mostrar. */
export interface RunSummary extends RunRow {
  agentId: string;
  agentName: string;
  agentVersion: number;
  /**
   * Sobre o que a execução foi, e como ela andou.
   *
   * Uma lista que mostra só nome do agent e horário obriga a abrir cada linha
   * para saber de que trabalho se trata. O alvo vem do evento e a contagem de
   * passos vem da própria execução.
   */
  target: { pull?: number; repo?: string; title?: string; author?: string } | null;
  stepTotal: number;
  stepDone: number;
  stepPending: number;
  stepFailed: number;
  findingCount: number;
}

export interface RunDetail extends Omit<RunSummary, "target" | "stepTotal" | "stepDone" | "stepPending" | "stepFailed" | "findingCount"> {
  /** A versao exata que executou, nao a mais recente do agent. */
  spec: AgentSpec;
  steps: StepRow[];
}

/** Achado de um run, ja normalizado, venha da tabela ou da saida do passo. */
export interface RunFinding {
  severity: string;
  file?: string;
  line?: number;
  category?: string;
  problem: string;
  fix?: string;
  state: string;
}

/**
 * Leitura de execucoes e reexecucao de passo. Linha de comando, servidor MCP e
 * interface passam por aqui, porque zerar um passo sem zerar quem depende dele
 * deixa o run com saida velha alimentando passo novo, e essa regra nao pode
 * viver em tres lugares.
 */
export class RunService {
  constructor(
    private readonly db: Db = defaultDb,
    private readonly makeRunner: () => Promise<StepRunner> = buildExecutor,
  ) {}

  async list(filter: RunFilter = {}): Promise<RunSummary[]> {
    const conditions = [];
    if (filter.status !== undefined) {
      conditions.push(
        Array.isArray(filter.status)
          ? inArray(schema.runs.status, filter.status)
          : eq(schema.runs.status, filter.status),
      );
    }
    if (filter.agentId !== undefined) {
      conditions.push(eq(schema.agentVersions.agentId, filter.agentId));
    }
    if (filter.initiativeId !== undefined) {
      conditions.push(eq(schema.runs.initiativeId, filter.initiativeId));
    }

    const rows = await this.db
      .select({
        run: schema.runs,
        agentId: schema.agents.id,
        agentName: schema.agents.name,
        agentVersion: schema.agentVersions.version,
        evento: schema.events.payload,
      })
      .from(schema.runs)
      .innerJoin(schema.agentVersions, eq(schema.runs.agentVersionId, schema.agentVersions.id))
      .innerJoin(schema.agents, eq(schema.agentVersions.agentId, schema.agents.id))
      .leftJoin(schema.events, eq(schema.runs.eventId, schema.events.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.runs.createdAt))
      .limit(filter.limit ?? 20);

    const contagens = await this.stepCounts(rows.map((r) => r.run.id));
    return rows.map((r) => ({
      ...r.run,
      agentId: r.agentId,
      agentName: r.agentName,
      agentVersion: r.agentVersion,
      target: alvo(r.evento),
      ...(contagens.get(r.run.id) ?? SEM_PASSOS),
    }));
  }

  /**
   * Andamento e achados de várias execuções numa consulta só.
   *
   * A lista pede quinhentas linhas, e buscar os passos de cada uma eram
   * quinhentas idas ao banco a cada atualização da tela. O achado é contado
   * com o mesmo critério de `fromStepOutput`: objeto com `problem` e
   * `severity` em texto, e o resto fica fora.
   */
  private async stepCounts(runIds: string[]): Promise<Map<string, StepCounts>> {
    if (runIds.length === 0) return new Map();
    const s = schema.steps;
    const rows = await this.db
      .select({
        runId: s.runId,
        stepTotal: sql<number>`count(*)`,
        stepDone: sql<number>`sum(${s.status} = 'done')`,
        stepPending: sql<number>`sum(${s.status} in ('pending', 'running', 'awaiting_approval'))`,
        stepFailed: sql<number>`sum(${s.status} = 'failed')`,
        // O `case` protege o `json_each`: saída que não é objeto JSON, ou
        // objeto sem lista em `findings`, estouraria a consulta inteira.
        findingCount: sql<number>`sum(case when json_valid(${s.output}) and json_type(${s.output}, '$.findings') = 'array' then (
          select count(*) from json_each(${s.output}, '$.findings') as f
          where f.type = 'object'
            and json_type(f.value, '$.problem') = 'text'
            and json_type(f.value, '$.severity') = 'text'
        ) else 0 end)`,
      })
      .from(s)
      .where(inArray(s.runId, runIds))
      .groupBy(s.runId);

    return new Map(
      rows.map((r) => [
        r.runId,
        {
          stepTotal: Number(r.stepTotal),
          stepDone: Number(r.stepDone ?? 0),
          stepPending: Number(r.stepPending ?? 0),
          stepFailed: Number(r.stepFailed ?? 0),
          findingCount: Number(r.findingCount ?? 0),
        },
      ]),
    );
  }

  async get(runId: string): Promise<RunDetail | undefined> {
    const [row] = await this.db
      .select({
        run: schema.runs,
        agentId: schema.agents.id,
        agentName: schema.agents.name,
        agentVersion: schema.agentVersions.version,
        spec: schema.agentVersions.spec,
      })
      .from(schema.runs)
      .innerJoin(schema.agentVersions, eq(schema.runs.agentVersionId, schema.agentVersions.id))
      .innerJoin(schema.agents, eq(schema.agentVersions.agentId, schema.agents.id))
      .where(eq(schema.runs.id, runId));
    if (!row) return undefined;

    return {
      ...row.run,
      agentId: row.agentId,
      agentName: row.agentName,
      agentVersion: row.agentVersion,
      spec: AgentSpec.parse(row.spec),
      steps: await this.steps(runId),
    };
  }

  async steps(runId: string): Promise<StepRow[]> {
    return this.db
      .select()
      .from(schema.steps)
      .where(eq(schema.steps.runId, runId))
      .orderBy(asc(schema.steps.idx));
  }

  /**
   * Achados do run. A tabela `findings` so e preenchida quando o reconciliador
   * roda, entao antes disso o achado vive na saida do passo que o produziu e e
   * de la que ele sai.
   */
  async findings(runId: string): Promise<RunFinding[]> {
    return (await this.findingsByRun([runId]))[runId] ?? [];
  }

  /**
   * Achados de várias execuções de uma vez, com o mesmo critério de
   * `findings`: a tabela quando o reconciliador já gravou, a saída dos passos
   * quando não.
   *
   * A inbox mostra os achados de cada pendência na linha fechada, e pedir um
   * por um era uma ida à ponte e ao banco por linha. Aqui são duas consultas,
   * seja qual for o tamanho da fila.
   */
  async findingsByRun(runIds: string[]): Promise<Record<string, RunFinding[]>> {
    const out: Record<string, RunFinding[]> = Object.fromEntries(runIds.map((id) => [id, []]));
    if (runIds.length === 0) return out;

    const gravados = await this.db
      .select()
      .from(schema.findings)
      .where(inArray(schema.findings.runId, runIds))
      .orderBy(asc(schema.findings.createdAt));
    for (const r of gravados) {
      out[r.runId]!.push({
        severity: r.severity,
        file: r.file ?? undefined,
        line: r.line ?? undefined,
        category: r.category ?? undefined,
        problem: r.body,
        state: r.state,
      });
    }

    const semTabela = runIds.filter((id) => out[id]!.length === 0);
    if (semTabela.length === 0) return out;

    const passos = await this.db
      .select({ runId: schema.steps.runId, output: schema.steps.output })
      .from(schema.steps)
      .where(inArray(schema.steps.runId, semTabela))
      .orderBy(asc(schema.steps.runId), asc(schema.steps.idx));
    for (const p of passos) out[p.runId]!.push(...fromStepOutput(p.output));

    return out;
  }

  /**
   * Zera o passo e todos que dependem dele, direta ou indiretamente, e executa
   * o run de novo. O executor retoma do primeiro passo que nao esta `done`,
   * entao zerar e tudo que separa uma reexecucao de uma retomada.
   *
   * O custo dos passos zerados sai do total do run, senao o valor gasto conta
   * duas vezes. O contador diario nao e mexido: ele registra dinheiro que saiu,
   * e a reexecucao gasta de novo.
   *
   * Com `wait` falso a reexecucao fica correndo atras e o retorno e `queued`,
   * que e o que serve para um cliente MCP: o pipeline leva minutos e o desfecho
   * fica no banco de qualquer jeito.
   */
  async rerunStep(
    runId: string,
    stepKey: string,
    options: { wait?: boolean } = {},
  ): Promise<"queued" | "done" | "paused" | "failed"> {
    const detail = await this.get(runId);
    if (!detail) throw new Error(`run ${runId} nao encontrado`);

    const affected = dependents(detail.spec, stepKey);
    const targets = detail.steps.filter((s) => affected.has(s.stepKey));
    await this.reset(detail, targets);

    const runner = await this.makeRunner();
    if (options.wait === false) {
      void runner.execute(runId).catch(() => undefined);
      return "queued";
    }
    return runner.execute(runId);
  }

  private async reset(run: RunRow, targets: StepRow[]): Promise<void> {
    if (targets.length > 0) {
      const ids = targets.map((s) => s.id);

      await this.db
        .update(schema.steps)
        .set({
          status: "pending",
          // A tentativa e historico do passo, e continua contando.
          modelUsed: null,
          substitutionReason: null,
          skillsUsed: null,
          toolsUsed: null,
          output: null,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: 0,
          startedAt: null,
          endedAt: null,
          error: null,
        })
        .where(inArray(schema.steps.id, ids));

      // Aprovacao presa ao passo antigo nao pode ficar na inbox: aprovar
      // publicaria um texto que o run acabou de descartar.
      await this.db
        .update(schema.approvals)
        .set({ status: "expired", decidedAt: Math.floor(Date.now() / 1000) })
        .where(and(inArray(schema.approvals.stepId, ids), eq(schema.approvals.status, "pending")));
    }

    const billable = targets.filter((s) => s.billable).reduce((acc, s) => acc + s.costUsd, 0);
    const total = targets.reduce((acc, s) => acc + s.costUsd, 0);

    await this.db
      .update(schema.runs)
      .set({
        status: "queued",
        costUsd: Math.max(0, run.costUsd - billable),
        estimateUsd: Math.max(0, run.estimateUsd - total),
        endedAt: null,
        error: null,
      })
      .where(eq(schema.runs.id, run.id));
  }
}

type StepCounts = Pick<
  RunSummary,
  "stepTotal" | "stepDone" | "stepPending" | "stepFailed" | "findingCount"
>;

const SEM_PASSOS: StepCounts = {
  stepTotal: 0,
  stepDone: 0,
  stepPending: 0,
  stepFailed: 0,
  findingCount: 0,
};

/** O passo pedido mais o fecho transitivo de quem depende dele. */
function dependents(spec: AgentSpec, stepKey: string): Set<string> {
  if (!spec.steps.some((s) => s.key === stepKey)) {
    throw new Error(`passo "${stepKey}" nao existe na versao que este run executou`);
  }

  const out = new Set([stepKey]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of spec.steps) {
      if (out.has(step.key)) continue;
      if (step.needs.some((need) => out.has(need))) {
        out.add(step.key);
        grew = true;
      }
    }
  }
  return out;
}

/** Só o que nomeia o trabalho. O diff inteiro não cabe numa linha de lista. */
function alvo(payload: unknown): RunSummary["target"] {
  if (payload === null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.pull !== "number") return null;
  return {
    pull: p.pull,
    repo: typeof p.repo === "string" ? p.repo : undefined,
    title: typeof p.title === "string" ? p.title : undefined,
    author: typeof p.author === "string" ? p.author : undefined,
  };
}

function fromStepOutput(output: unknown): RunFinding[] {
  if (output === null || typeof output !== "object") return [];
  const raw = (output as { findings?: unknown }).findings;
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const f = item as Record<string, unknown>;
    if (typeof f.problem !== "string" || typeof f.severity !== "string") return [];
    return [
      {
        severity: f.severity,
        file: typeof f.file === "string" ? f.file : undefined,
        line: typeof f.line === "number" ? f.line : undefined,
        category: typeof f.category === "string" ? f.category : undefined,
        problem: f.problem,
        fix: typeof f.fix === "string" ? f.fix : undefined,
        state: "open",
      },
    ];
  });
}

export const runService = new RunService();
