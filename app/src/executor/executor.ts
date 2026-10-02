import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import {
  AgentSpec,
  type ActionStep,
  type ModelStep,
  type Step,
  resolveTools,
  topoSort,
} from "../config/types.js";
import { McpRegistry } from "../mcp/registry.js";
import { resolveModel, type FallbackRow } from "../providers/registry.js";
import { providerService } from "../services/provider-service.js";
import type { Runtime } from "../runtimes/types.js";
import { selectSkills, skillsPreamble, type SkillContext } from "../skills/loader.js";
import { ApprovalGate, settleStep } from "../approval/gate.js";
import { BudgetExceeded, assertWithinBudget, recordSpend, type Spend } from "./budget.js";
import { SUBSCRIPTION_RUNTIMES } from "../runtimes/types.js";

export type EventPayload = {
  repo: string;
  changedFiles: string[];
  [k: string]: unknown;
};

type Deps = {
  mcp: McpRegistry;
  runtimes: Map<string, Runtime>;
  gate: ApprovalGate;
  machineId: string;
};

const nowSec = () => Math.floor(Date.now() / 1000);

type StepOutcome = { kind: "ok"; output: unknown; costUsd: number; tokens: number; billable: boolean };

/**
 * Maquina de estado duravel.
 *
 * Toda transicao vai para o banco antes de seguir. Fechou o app no meio de um
 * run, ao reabrir ele retoma do primeiro passo que nao esta `done`.
 */
export class Executor {
  constructor(private deps: Deps) {}

  /**
   * Cria o run e fotografa a iniciativa dele em `runs.initiative_id`: o
   * parametro explicito quando vier, senao a do agent neste instante. Essa
   * foto nunca e reescrita depois, nem pela retomada: mudar a iniciativa do
   * agent so vale para run criado dali em diante.
   */
  async createRun(
    agentVersionId: string,
    eventId: string | null,
    triggerId: string | null = null,
    initiativeId?: string | null,
  ): Promise<string> {
    const id = randomUUID();
    const resolvedInitiativeId =
      initiativeId !== undefined ? initiativeId : await this.agentInitiativeId(agentVersionId);
    await db
      .insert(schema.runs)
      .values({ id, agentVersionId, eventId, triggerId, initiativeId: resolvedInitiativeId, status: "queued" });
    return id;
  }

  private async agentInitiativeId(agentVersionId: string): Promise<string | null> {
    const [row] = await db
      .select({ initiativeId: schema.agents.initiativeId })
      .from(schema.agentVersions)
      .innerJoin(schema.agents, eq(schema.agentVersions.agentId, schema.agents.id))
      .where(eq(schema.agentVersions.id, agentVersionId));
    return row?.initiativeId ?? null;
  }

  /**
   * Decide a pendência e retoma o run dela.
   *
   * A decisão sozinha não basta: sem retomar, o run fica `paused`, o que vem
   * depois da ação nunca roda e a tela continua mostrando aguardando numa
   * execução que já saiu.
   */
  async decide(
    approvalId: string,
    decision: "approved" | "rejected",
  ): Promise<{ status: "approved" | "rejected" | "conflict"; run: "done" | "paused" | "failed" }> {
    const { runId, status } = await this.deps.gate.decide(approvalId, decision);
    const run = await this.execute(runId);
    return { status, run };
  }

  /** Runs interrompidos por fechamento do app ou por crash. */
  async resumeAll(): Promise<string[]> {
    const pending = await db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(inArray(schema.runs.status, ["queued", "running"]));

    const ids: string[] = [];
    for (const row of pending) {
      ids.push(row.id);
      await this.execute(row.id);
    }
    return ids;
  }

  async execute(runId: string): Promise<"done" | "paused" | "failed"> {
    const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    if (!run) throw new Error(`run ${runId} nao encontrado`);

    const [version] = await db
      .select()
      .from(schema.agentVersions)
      .where(eq(schema.agentVersions.id, run.agentVersionId));
    if (!version) throw new Error(`versao de agent ${run.agentVersionId} nao encontrada`);

    const spec = AgentSpec.parse(version.spec);
    const event = run.eventId
      ? (await db.select().from(schema.events).where(eq(schema.events.id, run.eventId)))[0]
      : undefined;
    const payload = (event?.payload ?? { repo: "", changedFiles: [] }) as EventPayload;

    await db
      .update(schema.runs)
      .set({ status: "running", startedAt: run.startedAt ?? nowSec() })
      .where(eq(schema.runs.id, runId));

    const fallbacks = await providerService.getFallbacks(this.deps.machineId);

    // Lida a cada `execute`, inclusive na retomada: tirar um servidor da
    // iniciativa vale a partir da proxima execucao, mesmo sem novo run. `null`
    // quando o run nao tem iniciativa (fotografia do `createRun`), e ai o
    // agent enxerga tudo, como hoje.
    const initiativeServers = run.initiativeId
      ? new Set(
          (
            await db
              .select({ serverName: schema.initiativeMcpServers.serverName })
              .from(schema.initiativeMcpServers)
              .where(eq(schema.initiativeMcpServers.initiativeId, run.initiativeId))
          ).map((r) => r.serverName),
        )
      : null;

    const outputs = new Map<string, unknown>();
    let runCost = run.costUsd;
    let runTokens = run.tokens;
    let runEstimate = run.estimateUsd;
    // O que este trecho gastou. Vai para o dia em qualquer saída, e não só em
    // `done`: o review para na fila antes de terminar, e gravar só no fim
    // deixava o teto diário sem ver gasto nenhum.
    const newRun = run.startedAt === null;

    try {
      for (const [idx, step] of topoSort(spec.steps).entries()) {
        const existing = await this.loadStep(runId, step.key);

        if (existing?.status === "done" || existing?.status === "skipped") {
          outputs.set(step.key, existing.output);
          continue;
        }
        if (existing?.status === "awaiting_approval") {
          const [approval] = await db
            .select({ status: schema.approvals.status })
            .from(schema.approvals)
            .where(eq(schema.approvals.stepId, existing.id));
          // `publishing` é uma decisão que caiu no meio: sem saber se saiu,
          // o passo espera em vez de se dar por publicado.
          if (!approval || approval.status === "pending" || approval.status === "publishing") {
            return this.pause(runId);
          }
          outputs.set(step.key, (await settleStep(existing.id, approval.status)).output);
          continue;
        }

        const stepId = existing?.id ?? randomUUID();
        if (!existing) {
          await db.insert(schema.steps).values({
            id: stepId,
            runId,
            idx,
            stepKey: step.key,
            name: step.name,
            status: "pending",
          });
        }

        const outcome =
          step.type === "model"
            ? await this.runModelStep({
                runId,
                stepId,
                step,
                spec,
                payload,
                outputs,
                fallbacks,
                run: { usd: runCost, tokens: runTokens },
                initiativeServers,
              })
            : await this.runActionStep({ runId, stepId, step, outputs, payload });

        if (outcome.kind === "paused") return this.pause(runId);
        if (outcome.kind === "skipped") {
          outputs.set(step.key, null);
          continue;
        }

        if (outcome.billable) {
          runCost += outcome.costUsd;
          runTokens += outcome.tokens;
          // O dia recebe o gasto a cada passo, e não só no fim do trecho:
          // um gatilho que acha vinte PRs abre vinte runs juntos, e cada um
          // precisa ver o que os outros já gastaram antes do próximo passo.
          await recordSpend(spec.id, { usd: outcome.costUsd, tokens: outcome.tokens }, false);
        }
        runEstimate += outcome.costUsd;
        outputs.set(step.key, outcome.output);
        await db
          .update(schema.runs)
          .set({ costUsd: runCost, tokens: runTokens, estimateUsd: runEstimate })
          .where(eq(schema.runs.id, runId));
      }

      await db
        .update(schema.runs)
        .set({ status: "done", endedAt: nowSec() })
        .where(eq(schema.runs.id, runId));
      return "done";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Orcamento nao e falha: o run para e espera decisao sua.
      const status = err instanceof BudgetExceeded ? "paused" : "failed";
      await db
        .update(schema.runs)
        .set({ status, endedAt: status === "failed" ? nowSec() : null, error: message })
        .where(eq(schema.runs.id, runId));
      return status;
    } finally {
      // Servidor MCP não fecha aqui: o registro vive entre execuções e cada
      // processo sai sozinho depois do tempo ocioso, ou no encerramento do app.
      // O gasto já foi para o dia passo a passo; aqui só conta a execução.
      if (newRun) await recordSpend(spec.id, { usd: 0, tokens: 0 }, true);
    }
  }

  private async pause(runId: string): Promise<"paused"> {
    await db.update(schema.runs).set({ status: "paused" }).where(eq(schema.runs.id, runId));
    return "paused";
  }

  private async loadStep(runId: string, stepKey: string) {
    const [row] = await db
      .select()
      .from(schema.steps)
      .where(and(eq(schema.steps.runId, runId), eq(schema.steps.stepKey, stepKey)));
    return row;
  }

  private async runModelStep(args: {
    runId: string;
    stepId: string;
    step: ModelStep;
    spec: AgentSpec;
    payload: EventPayload;
    outputs: Map<string, unknown>;
    fallbacks: FallbackRow[];
    run: Spend;
    initiativeServers: Set<string> | null;
  }): Promise<StepOutcome | { kind: "skipped" }> {
    const { runId, stepId, step, spec, payload, outputs, fallbacks, initiativeServers } = args;

    await assertWithinBudget(spec.id, args.run, spec.budget);

    const toolRefs = resolveTools(spec, step);

    // Antes do `missing()`: servidor fora da iniciativa conta como ausente,
    // mesmo que esteja instalado nesta maquina. Agent sem iniciativa
    // (`initiativeServers` nulo) nao passa por aqui, e ve tudo como hoje.
    if (initiativeServers) {
      const exigidos = new Set([...toolRefs.map((t) => t.server), ...step.requiresServers]);
      const fora = [...exigidos].filter((servidor) => !initiativeServers.has(servidor));
      if (fora.length > 0) {
        if (!step.optional) {
          await db
            .update(schema.steps)
            .set({ status: "failed", endedAt: nowSec(), error: "outside_initiative" })
            .where(eq(schema.steps.id, stepId));
          throw new Error(`passo "${step.key}" usa servidor fora da iniciativa: ${fora.join(", ")}`);
        }
        await db
          .update(schema.steps)
          .set({ status: "skipped", error: "outside_initiative", endedAt: nowSec() })
          .where(eq(schema.steps.id, stepId));
        return { kind: "skipped" };
      }
    }

    const missing = this.deps.mcp.missing(step.requiresServers);
    if (missing.length > 0) {
      if (!step.optional) {
        throw new Error(`passo "${step.key}" exige servidores ausentes nesta maquina: ${missing.join(", ")}`);
      }
      await db
        .update(schema.steps)
        .set({ status: "skipped", error: `servidores indisponíveis: ${missing.join(", ")}`, endedAt: nowSec() })
        .where(eq(schema.steps.id, stepId));
      return { kind: "skipped" };
    }

    const resolution = resolveModel(step.model, fallbacks);
    const runtime =
      this.deps.runtimes.get(SUBSCRIPTION_RUNTIMES.has(resolution.provider) ? resolution.provider : "native");
    if (!runtime) throw new Error(`runtime indisponivel para "${resolution.provider}"`);

    const ctx: SkillContext = { repo: payload.repo, changedFiles: payload.changedFiles };
    const skills = selectSkills(spec.skills, ctx);
    const { tools, release } = await this.deps.mcp.toolsFor(toolRefs);

    await db
      .update(schema.steps)
      .set({
        status: "running",
        startedAt: nowSec(),
        attempt: (await this.loadStep(runId, step.key))!.attempt + 1,
        modelRequested: resolution.requested,
        modelUsed: resolution.used,
        substitutionReason: resolution.substitutionReason,
        skillsUsed: skills.map((s) => ({ name: s.name, origin: s.origin, hash: s.hash })),
        input: { needs: step.needs.map((k) => outputs.get(k)) },
      })
      .where(eq(schema.steps.id, stepId));

    try {
      // O corpo vai sempre no texto, inclusive para o claude-code: ele roda com
      // `--setting-sources ""` e so com as ferramentas MCP liberadas, entao nao
      // enxerga plugin nem consegue abrir a skill pelo nome.
      const system = [skillsPreamble(skills, true)].filter((s) => s.length > 0).join("\n\n");

      const result = await runtime.run({
        provider: resolution.provider,
        model: resolution.model,
        system: system.length > 0 ? system : undefined,
        prompt: renderPrompt(step.prompt, payload, outputs),
        stablePrefix: stablePrefix(step.prompt),
        tools,
        mcpServers: [...new Set(toolRefs.map((t) => t.server))],
        maxSteps: step.maxSteps,
        outputSchema: step.outputSchema,
      });

      const output = step.outputSchema ? result.structured : result.text;

      await db
        .update(schema.steps)
        .set({
          status: "done",
          endedAt: nowSec(),
          output: output as object,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          cacheReadTokens: result.cacheReadTokens ?? null,
          costUsd: result.costUsd,
          billable: result.billable,
          toolsUsed: result.toolsUsed,
        })
        .where(eq(schema.steps.id, stepId));

      return {
        kind: "ok",
        output,
        costUsd: result.costUsd,
        tokens: result.promptTokens + result.completionTokens,
        billable: result.billable,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(schema.steps)
        .set({ status: "failed", endedAt: nowSec(), error: message })
        .where(eq(schema.steps.id, stepId));
      throw err;
    } finally {
      release();
    }
  }

  private async runActionStep(args: {
    runId: string;
    stepId: string;
    step: ActionStep;
    outputs: Map<string, unknown>;
    payload: EventPayload;
  }): Promise<StepOutcome | { kind: "paused" }> {
    const { runId, stepId, step, outputs } = args;
    const source = step.input ?? step.needs[0];
    const saida = source ? outputs.get(source) : undefined;

    // A saída do passo diz o que publicar; o evento diz onde. Sem juntar os
    // dois, a ação chega ao handler sem destino: a fila mostra "agent · passo"
    // em vez do pull request, e publicar falharia por falta de owner e repo.
    const payload =
      saida !== null && typeof saida === "object"
        ? { ...alvoDoEvento(args.payload), ...(saida as object) }
        : saida;

    const state = await this.deps.gate.submit(
      { runId, stepId, kind: step.action, payload, target: step.target ?? null },
      step.mode,
    );

    if (state === "pending") {
      await db
        .update(schema.steps)
        .set({ status: "awaiting_approval", startedAt: nowSec() })
        .where(eq(schema.steps.id, stepId));
      return { kind: "paused" };
    }

    await db
      .update(schema.steps)
      .set({ status: "done", endedAt: nowSec(), output: { state } })
      .where(eq(schema.steps.id, stepId));
    return { kind: "ok", output: { state }, costUsd: 0, tokens: 0, billable: false };
  }
}

/**
 * Os campos do evento que identificam o destino de uma ação.
 *
 * Só o que nomeia o alvo, e não o evento inteiro: o diff de um pull request
 * tem dezenas de milhares de caracteres, e ele iria parar dentro da fila de
 * aprovação, gravado em cada pendência.
 */
export function alvoDoEvento(payload: EventPayload): Record<string, unknown> {
  const campos = [
    "owner",
    "repo",
    "repoName",
    "pull",
    "title",
    "headSha",
    "author",
    "baseBranch",
    "headBranch",
    "url",
    "additions",
    "deletions",
    "fileCount",
    "draft",
  ] as const;
  const alvo: Record<string, unknown> = {};
  for (const campo of campos) {
    const valor = (payload as Record<string, unknown>)[campo];
    if (valor !== undefined) alvo[campo] = valor;
  }
  // O handler do GitHub espera `repo` como nome curto, e o evento guarda o
  // caminho completo em `repo` e o nome curto em `repoName`.
  if (typeof alvo.repoName === "string") alvo.repo = alvo.repoName;
  return alvo;
}

/** Interpolação simples: {{event.x}}, {{steps.chave}} e {{steps.chave.campo}}. */
export function renderPrompt(
  template: string,
  payload: EventPayload,
  outputs: Map<string, unknown>,
): string {
  const descer = (inicio: unknown, caminho: string[]) =>
    caminho.reduce<unknown>(
      (acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined),
      inicio,
    );
  const texto = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2));

  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const [root, ...rest] = path.split(".");
    if (root === "steps") {
      const [chave, ...campo] = rest;
      return texto(descer(outputs.get(chave!), campo));
    }
    if (root === "event") return texto(descer(payload, rest));
    return "";
  });
}

/**
 * O começo do template que vem antes do primeiro marcador.
 *
 * É literal, então sai igual em todo evento da mesma versão do agent, e é o
 * trecho que o provedor consegue guardar em cache. Tudo depois do primeiro
 * marcador já depende do evento.
 */
export function stablePrefix(template: string): string {
  const primeiro = template.search(/\{\{/);
  return primeiro < 0 ? template : template.slice(0, primeiro);
}
