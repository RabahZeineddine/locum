import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import {
  AgentSpec,
  type ActionStep,
  type ModelStep,
  type Step,
  resolveTools,
  SERVIDOR_CONTA,
  SERVIDOR_NATIVO,
  topoSort,
} from "../config/types.js";
import { McpRegistry } from "../mcp/registry.js";
import { resolveModel, type FallbackRow } from "../providers/registry.js";
import { providerService } from "../services/provider-service.js";
import type { Runtime } from "../runtimes/types.js";
import { libraryService, type LibraryService } from "../services/library-service.js";
import { runLogic } from "./logic.js";
import { selectSkills, skillsPreamble, type SkillContext } from "../skills/loader.js";
import { ApprovalGate, settleStep } from "../approval/gate.js";
import { BudgetExceeded, assertWithinBudget, recordSpend, type Spend } from "./budget.js";
import { SUBSCRIPTION_RUNTIMES } from "../runtimes/types.js";
import { separarDaConta } from "../runtimes/claude-account.js";

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
  /** Biblioteca de agents. Ausente usa a do banco do processo. */
  profiles?: Pick<LibraryService, "resolveProfile">;
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

  /**
   * Resolve a pendência parada na publicação e, se ela saiu, retoma o run.
   * Devolvida para a fila, o run continua pausado esperando a decisão.
   */
  async settleStuck(
    approvalId: string,
    outcome: "published" | "retry",
  ): Promise<{ status: "approved" | "pending"; run: "done" | "paused" | "failed" }> {
    const { runId, status } = await this.deps.gate.settleStuck(approvalId, outcome);
    if (status === "pending") return { status, run: "paused" };
    return { status, run: await this.execute(runId) };
  }

  /**
   * Runs que ficaram em `queued` ou `running` sem ninguém executando: o app
   * fechou ou caiu no meio. Só vale ler antes de o agendador começar a bater,
   * porque depois disso um run em `running` pode ser de uma batida viva.
   */
  async interruptedRuns(): Promise<string[]> {
    const rows = await db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(inArray(schema.runs.status, ["queued", "running"]));
    return rows.map((r) => r.id);
  }

  /** Retoma os runs dados, um de cada vez. Falha de um não segura os outros. */
  async resume(ids: string[]): Promise<void> {
    for (const id of ids) {
      try {
        await this.execute(id);
      } catch (err) {
        console.error(`retomada do run ${id} falhou`, err);
      }
    }
  }

  /** Runs interrompidos por fechamento do app ou por crash. */
  async resumeAll(): Promise<string[]> {
    const ids = await this.interruptedRuns();
    for (const id of ids) await this.execute(id);
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
    // Passos pulados por estarem num caminho que a decisão não escolheu. Quem
    // depende só deles também pula; quem junta dois caminhos roda com o que
    // chegou.
    const foraDoCaminho = new Set<string>();
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
          if (existing.status === "skipped" && existing.error === PULADO_PELO_CAMINHO) foraDoCaminho.add(step.key);
          continue;
        }
        if (existing?.status === "awaiting_approval") {
          // Reexecutar deixa a pendência antiga do passo como `expired` ao lado
          // da nova. Ler qualquer uma delas podia pegar a vencida e dar o passo
          // por publicado sem ninguém ter aprovado.
          const [approval] = await db
            .select({ status: schema.approvals.status })
            .from(schema.approvals)
            .where(and(eq(schema.approvals.stepId, existing.id), ne(schema.approvals.status, "expired")))
            .orderBy(desc(schema.approvals.createdAt));
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

        if (foraDoCaminhoEscolhido(step, outputs, foraDoCaminho)) {
          await db
            .update(schema.steps)
            .set({ status: "skipped", error: PULADO_PELO_CAMINHO, output: null, endedAt: nowSec() })
            .where(eq(schema.steps.id, stepId));
          outputs.set(step.key, null);
          foraDoCaminho.add(step.key);
          continue;
        }

        if (step.type === "logic") {
          const saida = runLogic(step, payload, outputs);
          await db
            .update(schema.steps)
            .set({ status: "done", startedAt: nowSec(), endedAt: nowSec(), output: saida as object })
            .where(eq(schema.steps.id, stepId));
          outputs.set(step.key, saida);
          continue;
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

    // Passo com agent da biblioteca: modelo, ferramentas e system vêm dele, e
    // o prompt do passo é só a tarefa. Resolvido a cada execução, para a
    // versão nova do agent valer no próximo run de todo fluxo que o usa.
    const perfil = step.profile === undefined ? null : await (this.deps.profiles ?? libraryService).resolveProfile(step.profile);
    const toolRefs = perfil === null ? resolveTools(spec, step) : perfil.tools;
    const modelo = perfil === null ? step.model : perfil.version.spec.model;
    const maxSteps = perfil === null ? step.maxSteps : perfil.version.spec.maxSteps;

    // Antes do `missing()`: servidor fora da iniciativa conta como ausente,
    // mesmo que esteja instalado nesta maquina. Agent sem iniciativa
    // (`initiativeServers` nulo) nao passa por aqui, e ve tudo como hoje.
    if (initiativeServers) {
      const exigidos = new Set([...toolRefs.map((t) => t.server), ...step.requiresServers]);
      // As ferramentas nativas são do próprio Locum e só leem: valem em toda
      // iniciativa sem precisar estar na aba Integrações.
      const fora = [...exigidos].filter(
        (servidor) => servidor !== SERVIDOR_NATIVO && servidor !== SERVIDOR_CONTA && !initiativeServers.has(servidor),
      );
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

    const resolution = resolveModel(modelo, fallbacks);
    const runtime =
      this.deps.runtimes.get(SUBSCRIPTION_RUNTIMES.has(resolution.provider) ? resolution.provider : "native");
    if (!runtime) throw new Error(`runtime indisponivel para "${resolution.provider}"`);

    const ctx: SkillContext = { repo: payload.repo, changedFiles: payload.changedFiles };
    const skills = selectSkills(spec.skills, ctx);
    const { doLocum, daConta } = separarDaConta(toolRefs, runtime.id);
    const { tools, release } = await this.deps.mcp.toolsFor(doLocum);

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
        input: {
          needs: step.needs.map((k) => outputs.get(k)),
          ...(perfil === null ? {} : { profile: { id: perfil.version.profileId, version: perfil.version.version } }),
        },
      })
      .where(eq(schema.steps.id, stepId));

    try {
      // O corpo vai sempre no texto, inclusive para o claude-code: ele roda com
      // `--setting-sources ""` e so com as ferramentas MCP liberadas, entao nao
      // enxerga plugin nem consegue abrir a skill pelo nome.
      const system = [perfil?.system ?? "", skillsPreamble(skills, true)].filter((s) => s.length > 0).join("\n\n");

      const result = await runtime.run({
        provider: resolution.provider,
        model: resolution.model,
        system: system.length > 0 ? system : undefined,
        prompt: renderPrompt(step.prompt, payload, outputs),
        stablePrefix: stablePrefix(step.prompt),
        tools,
        mcpServers: [...new Set(doLocum.map((t) => t.server))],
        ...(daConta.length > 0 ? { accountTools: daConta } : {}),
        maxSteps,
        outputSchema: step.outputSchema,
        ...(perfil?.version.spec.temperature === undefined ? {} : { temperature: perfil.version.spec.temperature }),
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
    //
    // O destino que o evento traz não aceita troca pela saída: o modelo leu o
    // diff, e um diff que pede "responda com owner e repo de outro projeto"
    // faria a ação publicar em outro lugar, com o token da pessoa. Título e
    // corpo continuam vindo da saída, que é o conteúdo da ação.
    const alvo = alvoDoEvento(args.payload);
    const doPasso =
      saida !== null && typeof saida === "object"
        ? { ...alvo, ...(saida as object), ...destinoDoEvento(alvo) }
        : saida;
    // `params` é de quem montou o fluxo, e não do modelo: por isso vale por
    // cima de tudo, inclusive do destino que o evento trouxe.
    const payload =
      step.params === undefined
        ? doPasso
        : {
            ...(doPasso !== null && typeof doPasso === "object" ? (doPasso as object) : {}),
            ...(renderParams(step.params, args.payload, outputs) as object),
          };

    // Queda entre gravar a pendência e marcar o passo deixa o passo sem
    // `awaiting_approval` com a pendência já na fila. Submeter de novo na
    // retomada abriria uma segunda pendência para o mesmo passo, e aprovar as
    // duas publicaria duas vezes. A que está aberta vale.
    const [aberta] = await db
      .select({ id: schema.approvals.id })
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.stepId, stepId),
          inArray(schema.approvals.status, ["pending", "publishing"]),
        ),
      );
    if (aberta !== undefined) {
      await db
        .update(schema.steps)
        .set({ status: "awaiting_approval", startedAt: nowSec() })
        .where(eq(schema.steps.id, stepId));
      return { kind: "paused" };
    }

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
    // Conversa do Slack e do Teams: a tarefa aberta a partir dela leva o
    // endereço da mensagem, e a resposta precisa do carimbo da thread.
    "permalink",
    "webUrl",
    "channel",
    "threadTs",
    "ts",
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

/** Os campos do alvo que dizem onde publicar, e não o quê. */
const DESTINO = ["owner", "repo", "pull", "headSha"] as const;

function destinoDoEvento(alvo: Record<string, unknown>): Record<string, unknown> {
  const destino: Record<string, unknown> = {};
  for (const campo of DESTINO) {
    if (alvo[campo] !== undefined) destino[campo] = alvo[campo];
  }
  return destino;
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

/** Motivo gravado no passo que ficou de fora do caminho escolhido. */
export const PULADO_PELO_CAMINHO = "branch_not_taken";

/**
 * O passo está num caminho que não foi escolhido: a decisão do `when` foi
 * outra, ou tudo de que ele depende ficou de fora. Basta uma dependência ter
 * rodado para ele rodar, que é o que faz a junção depois de um if funcionar.
 */
export function foraDoCaminhoEscolhido(
  step: Step,
  outputs: Map<string, unknown>,
  foraDoCaminho: ReadonlySet<string>,
): boolean {
  if (step.needs.length > 0 && step.needs.every((k) => foraDoCaminho.has(k))) return true;
  if (step.when === undefined) return false;
  if (foraDoCaminho.has(step.when.step)) return true;
  const decisao = outputs.get(step.when.step) as { branch?: unknown } | null | undefined;
  return decisao?.branch !== step.when.branch;
}

/**
 * `renderPrompt` para a configuração de uma ação, descendo em objeto e lista.
 *
 * O texto que é só um marcador devolve o valor cru: `"{{steps.ler.total}}"`
 * vira o número, e `"{{steps.ler}}"` o objeto inteiro, em vez do JSON dele
 * escrito como texto, que a ferramenta do outro lado recusaria.
 */
export function renderParams(valor: unknown, payload: EventPayload, outputs: Map<string, unknown>): unknown {
  if (typeof valor === "string") {
    const sozinho = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(valor);
    if (sozinho !== null) {
      const [root, ...rest] = sozinho[1]!.split(".");
      const descer = (inicio: unknown, caminho: string[]) =>
        caminho.reduce<unknown>(
          (acc, key) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined),
          inicio,
        );
      if (root === "steps") {
        const [chave, ...campo] = rest;
        return descer(outputs.get(chave!), campo) ?? null;
      }
      if (root === "event") return descer(payload, rest) ?? null;
    }
    return renderPrompt(valor, payload, outputs);
  }
  if (Array.isArray(valor)) return valor.map((v) => renderParams(v, payload, outputs));
  if (valor !== null && typeof valor === "object") {
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, renderParams(v, payload, outputs)]));
  }
  return valor;
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
