import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, type SQL } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { today } from "../executor/budget.js";
import { sameSpot } from "../sources/github-reconciler.js";
import { isReserved } from "./agent-service.js";

type Db = typeof defaultDb;

/** Skill que um passo carregou, como o executor grava em `steps.skills_used`. */
export interface SkillStamp {
  name: string;
  origin: string;
  hash: string;
}

/** Janela medida de uma versao de agent, com o agent junto para dar contexto. */
export interface VersionMetrics {
  agentId: string;
  agentName: string;
  version: number;
  agentVersionId: string;
  /** Conjunto de skills daquela janela: sem ele a comparacao entre versoes mente. */
  skillSet: SkillStamp[];
  windowStart: number;
  windowEnd: number;
  /** Achados com desfecho na janela, duplicatas incluidas. */
  findingCount: number;
  precision: number | null;
  agreement: number | null;
  missed: number;
}

export interface DailyUsage {
  day: string;
  agentId: string;
  costUsd: number;
  runs: number;
}

export interface MetricsReport {
  versions: VersionMetrics[];
  usage: DailyUsage[];
  /** Vazio enquanto o reconciliador nao rodar, e quem le precisa saber disso. */
  note?: string;
}

/**
 * Metricas por versao de agent e gasto diario.
 *
 * `agent_metrics` e dado derivado: sai inteiro de `finding_outcomes`, que o
 * reconciliador preenche quando o pull request fecha. Por isso `aggregate`
 * apaga as janelas da versao antes de escrever de novo, e pode rodar quantas
 * vezes quiser sem inflar numero.
 *
 * A janela nao e por versao, e por versao mais conjunto de skills. Duas
 * execucoes da mesma versao com skills diferentes sao dois agents diferentes
 * na pratica, e misturar as duas esconde exatamente a mudanca que se quer
 * medir.
 */
export class MetricsService {
  constructor(private readonly db: Db = defaultDb) {}

  /**
   * Recalcula `agent_metrics` a partir do gabarito e devolve o que gravou.
   *
   * Achado sem desfecho fica de fora: run que ainda nao foi reconciliado nao
   * e erro do agent, e conta-lo como ignorado derrubaria a precisao de graca.
   */
  async aggregate(options: { agentId?: string } = {}): Promise<VersionMetrics[]> {
    const rows = await this.db
      .select({
        findingId: schema.findings.id,
        file: schema.findings.file,
        line: schema.findings.line,
        createdAt: schema.findings.createdAt,
        runId: schema.findings.runId,
        eventId: schema.runs.eventId,
        agentVersionId: schema.runs.agentVersionId,
        agentId: schema.agents.id,
        agentName: schema.agents.name,
        version: schema.agentVersions.version,
        outcome: schema.findingOutcomes.state,
      })
      .from(schema.findingOutcomes)
      .innerJoin(schema.findings, eq(schema.findingOutcomes.findingId, schema.findings.id))
      .innerJoin(schema.runs, eq(schema.findings.runId, schema.runs.id))
      .innerJoin(schema.agentVersions, eq(schema.runs.agentVersionId, schema.agentVersions.id))
      .innerJoin(schema.agents, eq(schema.agentVersions.agentId, schema.agents.id))
      .where(options.agentId !== undefined ? eq(schema.agents.id, options.agentId) : undefined);

    const semReservados = rows.filter((r) => !isReserved(r.agentId));
    if (semReservados.length === 0) return [];

    const runIds = [...new Set(semReservados.map((r) => r.runId))];
    const skillsByRun = await this.skillsByRun(runIds);
    const prKeyByRun = await this.prKeyByRun(semReservados);

    const groups = new Map<string, Group>();
    for (const row of semReservados) {
      const skills = skillsByRun.get(row.runId) ?? [];
      const key = `${row.agentVersionId}\u0000${signature(skills)}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          agentId: row.agentId,
          agentName: row.agentName,
          version: row.version,
          agentVersionId: row.agentVersionId,
          skillSet: skills,
          windowStart: row.createdAt,
          windowEnd: row.createdAt,
          spotsByPr: new Map(),
          counts: { hit: 0, considered: 0, confirmed: 0, disputed: 0, total: 0 },
        };
        groups.set(key, group);
      }

      group.windowStart = Math.min(group.windowStart, row.createdAt);
      group.windowEnd = Math.max(group.windowEnd, row.createdAt);
      group.counts.total += 1;

      const prKey = prKeyByRun.get(row.runId);
      if (prKey !== undefined) {
        const spots = group.spotsByPr.get(prKey) ?? [];
        spots.push({ file: row.file ?? undefined, line: row.line ?? undefined });
        group.spotsByPr.set(prKey, spots);
      }

      // Duplicata nao entra na conta: dois achados no mesmo trecho contariam
      // como dois acertos e a precisao subiria de graca.
      if (row.outcome === "duplicate") continue;
      group.counts.considered += 1;
      if (row.outcome === "confirmed_by_human") group.counts.confirmed += 1;
      if (row.outcome === "disputed") group.counts.disputed += 1;
      if (row.outcome === "confirmed_by_human" || row.outcome === "became_commit") {
        group.counts.hit += 1;
      }
    }

    const missedByGroup = await this.missedByGroup([...groups.values()]);

    const measured: VersionMetrics[] = [...groups.values()].map((group, i) => ({
      agentId: group.agentId,
      agentName: group.agentName,
      version: group.version,
      agentVersionId: group.agentVersionId,
      skillSet: group.skillSet,
      windowStart: group.windowStart,
      windowEnd: group.windowEnd,
      findingCount: group.counts.total,
      precision:
        group.counts.considered > 0 ? group.counts.hit / group.counts.considered : null,
      // So fala explicita de humano entra aqui. Achado que ninguem comentou
      // nem recusou nao e concordancia nem discordancia, e fica fora dos dois
      // lados da fracao.
      agreement:
        group.counts.confirmed + group.counts.disputed > 0
          ? group.counts.confirmed / (group.counts.confirmed + group.counts.disputed)
          : null,
      missed: missedByGroup[i] ?? 0,
    }));

    await this.replace(measured);
    return measured.sort(
      (a, b) => b.version - a.version || a.windowStart - b.windowStart,
    );
  }

  async byVersion(agentId?: string): Promise<VersionMetrics[]> {
    const rows = await this.db
      .select({
        metric: schema.agentMetrics,
        agentId: schema.agents.id,
        agentName: schema.agents.name,
        version: schema.agentVersions.version,
      })
      .from(schema.agentMetrics)
      .innerJoin(
        schema.agentVersions,
        eq(schema.agentMetrics.agentVersionId, schema.agentVersions.id),
      )
      .innerJoin(schema.agents, eq(schema.agentVersions.agentId, schema.agents.id))
      .where(agentId !== undefined ? eq(schema.agents.id, agentId) : undefined)
      .orderBy(desc(schema.agentVersions.version), asc(schema.agentMetrics.windowStart));

    return rows.filter((r) => !isReserved(r.agentId)).map((r) => ({
      agentId: r.agentId,
      agentName: r.agentName,
      version: r.version,
      agentVersionId: r.metric.agentVersionId,
      skillSet: (r.metric.skillSet as SkillStamp[] | null) ?? [],
      windowStart: r.metric.windowStart,
      windowEnd: r.metric.windowEnd,
      findingCount: r.metric.findingCount,
      precision: r.metric.precision,
      agreement: r.metric.agreement,
      missed: r.metric.missed,
    }));
  }

  /** Gasto por dia, do mais recente para tras. `days` conta a partir de hoje. */
  async usage(options: { agentId?: string; days?: number } = {}): Promise<DailyUsage[]> {
    const conditions: SQL[] = [];
    if (options.agentId !== undefined) {
      conditions.push(eq(schema.usageDaily.agentId, options.agentId));
    }
    if (options.days !== undefined) {
      conditions.push(gte(schema.usageDaily.day, daysAgo(options.days)));
    }

    const rows = await this.db
      .select()
      .from(schema.usageDaily)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.usageDaily.day));
    return rows.filter((r) => !isReserved(r.agentId));
  }

  /**
   * Relatorio de leitura. Nao agrega: quem quer o numero atualizado chama
   * `aggregate` antes, porque recalcular dentro de uma leitura faria toda
   * consulta escrever no banco.
   */
  async report(options: { agentId?: string; days?: number } = {}): Promise<MetricsReport> {
    const versions = await this.byVersion(options.agentId);
    const usage = await this.usage(options);
    return {
      versions,
      usage,
      note:
        versions.length === 0
          ? "nenhuma janela medida ainda: agregue depois que o reconciliador gravar os desfechos"
          : undefined,
    };
  }

  /** Skills de cada run, unidas pelos passos e sem repetir a mesma versao. */
  private async skillsByRun(runIds: string[]): Promise<Map<string, SkillStamp[]>> {
    const rows = await this.db
      .select({ runId: schema.steps.runId, skillsUsed: schema.steps.skillsUsed })
      .from(schema.steps)
      .where(inArray(schema.steps.runId, runIds));

    const out = new Map<string, Map<string, SkillStamp>>();
    for (const row of rows) {
      const used = row.skillsUsed as SkillStamp[] | null;
      if (!Array.isArray(used)) continue;
      const seen = out.get(row.runId) ?? new Map<string, SkillStamp>();
      for (const skill of used) seen.set(`${skill.name}@${skill.hash}`, skill);
      out.set(row.runId, seen);
    }

    return new Map(
      [...out].map(([runId, seen]) => [
        runId,
        [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)),
      ]),
    );
  }

  /**
   * Pull request de cada run, tirado do evento que o originou. Run sintetico
   * ou de outra origem fica de fora: sem pull request nao ha review humano
   * para dizer o que o agent deixou passar.
   */
  private async prKeyByRun(
    rows: { runId: string; eventId: string | null }[],
  ): Promise<Map<string, string>> {
    const eventIds = [...new Set(rows.map((r) => r.eventId).filter((id): id is string => !!id))];
    if (eventIds.length === 0) return new Map();

    const events = await this.db
      .select()
      .from(schema.events)
      .where(inArray(schema.events.id, eventIds));

    const byEvent = new Map<string, string>();
    for (const event of events) {
      if (event.source !== "github") continue;
      const p = event.payload as Record<string, unknown>;
      if (typeof p.owner !== "string" || typeof p.repoName !== "string") continue;
      if (typeof p.pull !== "number") continue;
      byEvent.set(event.id, `${p.owner}/${p.repoName}#${p.pull}`);
    }

    const out = new Map<string, string>();
    for (const row of rows) {
      const prKey = row.eventId ? byEvent.get(row.eventId) : undefined;
      if (prKey !== undefined) out.set(row.runId, prKey);
    }
    return out;
  }

  /**
   * Sinal humano que nenhum achado do grupo cobriu, contado por pull request
   * para que duas execucoes sobre o mesmo pull request nao somem o mesmo "nao
   * vi" duas vezes.
   */
  private async missedByGroup(groups: Group[]): Promise<number[]> {
    const prKeys = [...new Set(groups.flatMap((g) => [...g.spotsByPr.keys()]))];
    if (prKeys.length === 0) return groups.map(() => 0);

    const signals = await this.db
      .select()
      .from(schema.reviewSignals)
      .where(inArray(schema.reviewSignals.prKey, prKeys));

    const byPr = new Map<string, { file?: string; line?: number }[]>();
    for (const signal of signals) {
      if (!signal.file) continue;
      const list = byPr.get(signal.prKey) ?? [];
      list.push({ file: signal.file, line: signal.line ?? undefined });
      byPr.set(signal.prKey, list);
    }

    return groups.map((group) => {
      let missed = 0;
      for (const [prKey, spots] of group.spotsByPr) {
        for (const signal of byPr.get(prKey) ?? []) {
          if (!spots.some((spot) => sameSpot(spot, signal))) missed += 1;
        }
      }
      return missed;
    });
  }

  /** Troca as janelas das versoes recalculadas, sem tocar nas outras. */
  private async replace(measured: VersionMetrics[]): Promise<void> {
    const versionIds = [...new Set(measured.map((m) => m.agentVersionId))];
    if (versionIds.length === 0) return;

    await this.db
      .delete(schema.agentMetrics)
      .where(inArray(schema.agentMetrics.agentVersionId, versionIds));

    await this.db.insert(schema.agentMetrics).values(
      measured.map((m) => ({
        id: randomUUID(),
        agentVersionId: m.agentVersionId,
        skillSet: m.skillSet,
        windowStart: m.windowStart,
        windowEnd: m.windowEnd,
        findingCount: m.findingCount,
        precision: m.precision,
        agreement: m.agreement,
        missed: m.missed,
      })),
    );
  }
}

interface Group {
  agentId: string;
  agentName: string;
  version: number;
  agentVersionId: string;
  skillSet: SkillStamp[];
  windowStart: number;
  windowEnd: number;
  /** Trecho de cada achado, por pull request, para descontar o que ele cobriu. */
  spotsByPr: Map<string, { file?: string; line?: number }[]>;
  counts: {
    hit: number;
    considered: number;
    confirmed: number;
    disputed: number;
    total: number;
  };
}

/** Identidade do conjunto de skills. Nome mais hash, porque skill muda de conteudo sem mudar de nome. */
function signature(skills: SkillStamp[]): string {
  return skills.map((s) => `${s.name}@${s.hash}`).join(",");
}

/**
 * Dia limite no mesmo formato que `usage_daily` guarda. A comparacao e de
 * texto, que so funciona porque o formato e ISO e tem largura fixa.
 */
function daysAgo(days: number): string {
  const ms = Date.parse(`${today()}T00:00:00Z`) - Math.max(0, days - 1) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export const metricsService = new MetricsService();
