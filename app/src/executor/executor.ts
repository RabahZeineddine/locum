import { soltarOPr, type TeamsReactionOptions } from "../teams/reaction.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
import type { Atividade, Runtime } from "../runtimes/types.js";
import { conexoesIndisponiveis, libraryService, type LibraryService } from "../services/library-service.js";
import { runLogic } from "./logic.js";
import { discoverSkills, selectSkills, skillsAusentes, skillsIndisponiveis, skillsPreamble, type LoadedSkill, type SkillContext } from "../skills/loader.js";
import { ApprovalGate, settleStep } from "../approval/gate.js";
import { BudgetExceeded, assertWithinBudget, recordSpend, type Spend } from "./budget.js";
import { ehLeituraDa, type FerramentaClassificavel } from "../config/leitura.js";
import { ACOES_DE_CONVERSA, dependenciaDeEvento, recusaSemEvento } from "./dependencia-de-evento.js";
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
  /** Skills disponíveis. Ausente varre o disco, como sempre. Existe para o teste trocar. */
  skills?: Map<string, LoadedSkill>;
  /** Graph da reação do Teams. Ausente usa a conexão do Teams. Existe para o teste trocar. */
  teams?: TeamsReactionOptions;
  /** As ferramentas que o servidor anotou, do cache da última leitura. Ausente usa o cache do banco. Existe para o teste trocar. */
  ferramentasGuardadas?: (servidor: string) => Promise<readonly FerramentaClassificavel[] | null>;
};

async function ferramentasDoCache(servidor: string): Promise<readonly FerramentaClassificavel[] | null> {
  const { mcpService } = await import("../services/mcp-service.js");
  return (await mcpService.cachedTools(servidor))?.tools ?? null;
}

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

  /** Veio de gatilho que não é o botão: só essas execuções cedem ao limite do provedor. */
  private async ehAutomatica(runId: string): Promise<boolean> {
    if (this.manuais.has(runId)) return false;
    const [run] = await db.select({ triggerId: schema.runs.triggerId }).from(schema.runs).where(eq(schema.runs.id, runId));
    if (run?.triggerId == null) return false;
    const [gatilho] = await db.select({ kind: schema.triggers.kind }).from(schema.triggers).where(eq(schema.triggers.id, run.triggerId));
    return gatilho !== undefined && gatilho.kind !== "manual";
  }

  /** Runs que uma pessoa pediu (reexecução de passo): nunca cedem ao limite do provedor. */
  private readonly manuais = new Set<string>();

  /**
   * `manual` marca quem pediu: reexecutar um passo é clique de pessoa, mesmo num
   * run que nasceu de gatilho automático, e a origem do run não decide isso.
   */
  async execute(runId: string, opcoes: { manual?: boolean } = {}): Promise<"done" | "paused" | "failed"> {
    if (opcoes.manual !== true) return this.executarRun(runId);
    this.manuais.add(runId);
    try {
      return await this.executarRun(runId);
    } finally {
      this.manuais.delete(runId);
    }
  }

  private async executarRun(runId: string): Promise<"done" | "paused" | "failed"> {
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

    // Antes do primeiro passo de modelo: sem o evento o prompt sai com `null`,
    // e a chamada paga só para o modelo dizer que não há dado. Vale só para o
    // run que alguém pediu (Executar agora, MCP): o gatilho de relógio nunca
    // traz evento, e seguir com `null` é o que ele sempre fez.
    const faltaEvento = event === undefined && !(await this.vemDeGatilho(run.triggerId)) ? dependenciaDeEvento(spec) : null;
    if (faltaEvento !== null) return this.recusarSemEvento(runId, spec, recusaSemEvento(faltaEvento));

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

    const contextoDaIniciativa = run.initiativeId ? await lerContextoDaIniciativa(run.initiativeId) : null;

    const outputs = new Map<string, unknown>();
    // Passos pulados por estarem num caminho que a decisão não escolheu. Quem
    // depende só deles também pula; quem junta dois caminhos roda com o que
    // chegou.
    const foraDoCaminho = new Set<string>();
    let runCost = run.costUsd;
    let runTokens = run.tokens;
    let runEstimate = run.estimateUsd;
    // O que cada agent da biblioteca gastou neste trecho, para o teto por run dele.
    // Retomado depois da fila, parte do que os passos já feitos gastaram.
    const gastoDosAgents = new Map<string, Spend>();
    for (const feito of await db.select().from(schema.steps).where(and(eq(schema.steps.runId, runId), eq(schema.steps.billable, true)))) {
      const id = (feito.input as { profile?: { id?: string } } | null)?.profile?.id;
      if (id === undefined) continue;
      const antes = gastoDosAgents.get(id) ?? { usd: 0, tokens: 0 };
      gastoDosAgents.set(id, {
        usd: antes.usd + (feito.costUsd ?? 0),
        tokens: antes.tokens + (feito.promptTokens ?? 0) + (feito.completionTokens ?? 0),
      });
    }
    // O que este trecho gastou. Vai para o dia em qualquer saída, e não só em
    // `done`: o review para na fila antes de terminar, e gravar só no fim
    // deixava o teto diário sem ver gasto nenhum.
    const newRun = run.startedAt === null;
    // O passo em andamento, para o erro ficar nele e não só no run.
    let atual: string | null = null;

    try {
      for (const [idx, step] of topoSort(spec.steps).entries()) {
        atual = step.key;
        const existing = await this.loadStep(runId, step.key);

        if (existing?.status === "done" || (existing?.status === "skipped" && existing.error !== NAO_RODOU)) {
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
                contextoDaIniciativa,
                fallbacks,
                run: { usd: runCost, tokens: runTokens },
                gastoDosAgents,
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
          if (step.type === "model" && step.profile !== undefined) {
            const gasto = { usd: outcome.costUsd, tokens: outcome.tokens };
            const antes = gastoDosAgents.get(step.profile) ?? { usd: 0, tokens: 0 };
            gastoDosAgents.set(step.profile, { usd: antes.usd + gasto.usd, tokens: antes.tokens + gasto.tokens });
            await recordSpend(`biblioteca:${step.profile}`, gasto, false);
          }
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
      // O passo antes do run: quem vê o run falho já encontra o passo que falhou.
      if (status === "failed") await this.marcarOQueFalhou(runId, spec, atual, message);
      await db
        .update(schema.runs)
        .set({ status, endedAt: status === "failed" ? nowSec() : null, error: message })
        .where(eq(schema.runs.id, runId));
      // Run que não chegou ao review: o 👀 que anunciou o PR sai da mensagem.
      await soltarOPr(payload, this.deps.teams);
      return status;
    } finally {
      // Servidor MCP não fecha aqui: o registro vive entre execuções e cada
      // processo sai sozinho depois do tempo ocioso, ou no encerramento do app.
      // O gasto já foi para o dia passo a passo; aqui só conta a execução.
      if (newRun) await recordSpend(spec.id, { usd: 0, tokens: 0 }, true);
    }
  }

  /**
   * O run que falhou diz qual passo foi: o que estava em andamento fica
   * `failed` com o erro, e os que não chegaram a rodar ficam `skipped` com
   * `not_run`, e não `pending`, que a tela leria como "ainda vai rodar".
   */
  private async marcarOQueFalhou(runId: string, spec: AgentSpec, atual: string | null, message: string): Promise<void> {
    const ordem = topoSort(spec.steps);
    const daFalha = atual === null ? -1 : ordem.findIndex((s) => s.key === atual);
    for (const [idx, step] of ordem.entries()) {
      if (idx < daFalha) continue;
      const existente = await this.loadStep(runId, step.key);
      if (existente?.status === "done" || existente?.status === "skipped" || existente?.status === "awaiting_approval") continue;
      if (idx === daFalha) {
        if (existente === undefined) {
          await db.insert(schema.steps).values({ id: randomUUID(), runId, idx, stepKey: step.key, name: step.name, status: "failed", error: message, endedAt: nowSec() });
        } else if (existente.status !== "failed") {
          await db.update(schema.steps).set({ status: "failed", error: message, endedAt: nowSec() }).where(eq(schema.steps.id, existente.id));
        }
        continue;
      }
      if (existente === undefined) {
        await db.insert(schema.steps).values({ id: randomUUID(), runId, idx, stepKey: step.key, name: step.name, status: "skipped", error: NAO_RODOU, endedAt: nowSec() });
      } else {
        await db.update(schema.steps).set({ status: "skipped", error: NAO_RODOU, endedAt: nowSec() }).where(eq(schema.steps.id, existente.id));
      }
    }
  }

  /** Se o run nasceu de um gatilho que se dispara sozinho. O gatilho manual é o botão. */
  private async vemDeGatilho(triggerId: string | null): Promise<boolean> {
    if (triggerId === null) return false;
    const [gatilho] = await db.select({ kind: schema.triggers.kind }).from(schema.triggers).where(eq(schema.triggers.id, triggerId));
    return gatilho !== undefined && gatilho.kind !== "manual";
  }

  /** O run que não pode começar: falha inteiro, sem gastar passo, com todos os passos como "não rodou". */
  private async recusarSemEvento(runId: string, spec: AgentSpec, message: string): Promise<"failed"> {
    await db.update(schema.runs).set({ status: "failed", startedAt: nowSec(), endedAt: nowSec(), error: message }).where(eq(schema.runs.id, runId));
    await this.marcarOQueFalhou(runId, spec, null, message);
    return "failed";
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
    gastoDosAgents: Map<string, Spend>;
    initiativeServers: Set<string> | null;
    contextoDaIniciativa: string | null;
  }): Promise<StepOutcome | { kind: "skipped" }> {
    const { runId, stepId, step, spec, payload, outputs, fallbacks, initiativeServers } = args;

    await assertWithinBudget(spec.id, args.run, spec.budget);

    // Passo com agent da biblioteca: modelo, ferramentas e system vêm dele, e
    // o prompt do passo é só a tarefa. Resolvido a cada execução, para a
    // versão nova do agent valer no próximo run de todo fluxo que o usa.
    const perfil = step.profile === undefined ? null : await (this.deps.profiles ?? libraryService).resolveProfile(step.profile);
    // O teto do próprio agent vale em todo fluxo que o usa, além do do fluxo.
    if (perfil !== null) {
      await assertWithinBudget(
        `biblioteca:${perfil.version.profileId}`,
        args.gastoDosAgents.get(perfil.version.profileId) ?? { usd: 0, tokens: 0 },
        perfil.version.spec.budget,
        perfil.version.spec.name,
      );
    }
    let toolRefs = perfil === null ? resolveTools(spec, step) : perfil.tools;
    const modelo = perfil === null ? step.model : perfil.version.spec.model;
    const maxSteps = perfil === null ? step.maxSteps : perfil.version.spec.maxSteps;

    // Conexão sem servidor utilizável ou skill que sumiu da máquina: o passo
    // para com o nome dela, e o opcional é pulado com o mesmo motivo.
    // O disco só é lido quando o agent cita skill.
    const skillsDoAgent = perfil?.version.spec.skills ?? [];
    const catalogoDeSkills = this.deps.skills ?? (skillsDoAgent.length > 0 ? discoverSkills(undefined, undefined, undefined, { projeto: false }) : undefined);
    const semSkill = catalogoDeSkills === undefined ? [] : skillsAusentes(skillsDoAgent, catalogoDeSkills, { repo: payload.repo, changedFiles: payload.changedFiles });
    if (perfil !== null && (perfil.semServidor.length > 0 || semSkill.length > 0)) {
      const motivo = [
        ...(perfil.semServidor.length > 0 ? [conexoesIndisponiveis(perfil.version.profileId, perfil.semServidor)] : []),
        ...(semSkill.length > 0 ? [skillsIndisponiveis(perfil.version.profileId, semSkill)] : []),
      ].join("; ");
      if (!step.optional) {
        await db
          .update(schema.steps)
          .set({ status: "failed", endedAt: nowSec(), error: motivo })
          .where(eq(schema.steps.id, stepId));
        throw new Error(`passo "${step.key}": ${motivo}`);
      }
      await db
        .update(schema.steps)
        .set({
          status: "skipped",
          error: motivo,
          endedAt: nowSec(),
          activity: [{ at: Date.now(), tipo: "texto", detalhe: motivo, erro: true }],
        })
        .where(eq(schema.steps.id, stepId));
      return { kind: "skipped" };
    }

    // Antes do `missing()`: servidor fora da iniciativa conta como ausente,
    // mesmo que esteja instalado nesta maquina. Agent sem iniciativa
    // (`initiativeServers` nulo) nao passa por aqui, e ve tudo como hoje.
    if (initiativeServers) {
      const dentro = (servidor: string): boolean =>
        servidor === SERVIDOR_NATIVO || servidor === SERVIDOR_CONTA || initiativeServers.has(servidor);
      // O que o agent exige é o que veio de toolset e de ferramenta avulsa. Das
      // conexões basta uma instância dentro da iniciativa; as de fora saem das
      // ferramentas em vez de serem exigidas.
      const exigidos = new Set([...(perfil === null ? toolRefs : perfil.fixas).map((t) => t.server), ...step.requiresServers]);
      if (perfil !== null) {
        for (const grupo of perfil.grupos) if (!grupo.servers.some(dentro)) grupo.servers.forEach((x) => exigidos.add(x));
        const fixos = new Set(perfil.fixas.map((t) => t.server));
        toolRefs = toolRefs.filter((t) => dentro(t.server) || fixos.has(t.server));
      }
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

    let resolution = resolveModel(modelo, fallbacks, providerService.entries());
    // Execução automática com o provedor no limite troca pelo substituto da
    // cadeia de fallback, se houver. A manual nunca é trocada nem barrada.
    if (await this.ehAutomatica(runId)) {
      const { limitesService } = await import("../services/limites-service.js");
      const entradas = providerService.entries();
      const decisao = await limitesService.decidir(resolution.used, { fallbacks, disponivel: (p) => entradas[p]?.available() ?? false });
      if (decisao.tipo === "substitui") {
        resolution = { ...resolveModel(decisao.modelo, fallbacks, entradas), requested: modelo, substitutionReason: decisao.motivo };
      }
    }
    const runtime =
      this.deps.runtimes.get(SUBSCRIPTION_RUNTIMES.has(resolution.provider) ? resolution.provider : "native");
    if (!runtime) throw new Error(`runtime indisponivel para "${resolution.provider}"`);

    const ctx: SkillContext = { repo: payload.repo, changedFiles: payload.changedFiles };
    const skills = selectSkills([...spec.skills, ...(perfil?.version.spec.skills ?? [])], ctx, catalogoDeSkills);
    const { doLocum, daConta } = separarDaConta(toolRefs, runtime.id);
    const { tools, release } =
      runtime.id === "claude-code" ? this.deps.mcp.nomesPara(doLocum) : await this.deps.mcp.toolsFor(doLocum);

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
        activity: [],
        input: {
          needs: step.needs.map((k) => outputs.get(k)),
          ...(perfil === null ? {} : { profile: { id: perfil.version.profileId, version: perfil.version.version } }),
        },
      })
      .where(eq(schema.steps.id, stepId));

    // A atividade vai para o banco em lotes curtos: a tela relê o passo e
    // acompanha sem esperar o fim, e um passo com cem chamadas não vira cem
    // escritas seguidas.
    const atividade: Atividade[] = [];
    let lote: ReturnType<typeof setTimeout> | null = null;
    const gravarAtividade = (): void => {
      lote = null;
      void db
        .update(schema.steps)
        .set({ activity: [...atividade] })
        .where(eq(schema.steps.id, stepId))
        .catch(() => undefined);
    };
    const onActivity = (a: Atividade): void => {
      atividade.push(a);
      if (atividade.length > TETO_DE_ATIVIDADES) atividade.shift();
      lote ??= setTimeout(gravarAtividade, 700);
    };
    const fecharAtividade = (): void => {
      if (lote !== null) clearTimeout(lote);
      lote = null;
    };

    try {
      // O corpo vai sempre no texto, inclusive para o claude-code: ele roda com
      // `--setting-sources ""` e so com as ferramentas MCP liberadas, entao nao
      // enxerga plugin nem consegue abrir a skill pelo nome.
      // O contexto da iniciativa entra no system: sem ele, o agent saía
      // procurando "o contexto da iniciativa" pelo disco.
      const system = [perfil?.system ?? "", args.contextoDaIniciativa ?? "", skillsPreamble(skills, true, runtime.id)]
        .filter((s) => s.length > 0)
        .join("\n\n");

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
        onActivity,
      });
      fecharAtividade();

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
          activity: atividade,
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
      fecharAtividade();
      const message = err instanceof Error ? err.message : String(err);
      await db
        .update(schema.steps)
        .set({ status: "failed", endedAt: nowSec(), error: message, activity: atividade })
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

    // Evento montado de um link colado não deve publicar nada: a pessoa pediu
    // para ver o que a automação faria com aquele PR. A ação não falha nem
    // entra na Fila: o passo termina com o texto que sairia.
    if (args.payload.semConversa === true && (await publicaParaFora(step, args.payload, outputs, this.deps.ferramentasGuardadas ?? ferramentasDoCache))) {
      const motivo = ACOES_DE_CONVERSA.has(step.action) ? ENSAIO_SEM_CONVERSA : ENSAIO_EVENTO_COLADO;
      const output = { state: "ensaio", motivo, text: textoDaResposta(saida) };
      await db
        .update(schema.steps)
        .set({ status: "done", startedAt: nowSec(), endedAt: nowSec(), output })
        .where(eq(schema.steps.id, stepId));
      return { kind: "ok", output, costUsd: 0, tokens: 0, billable: false };
    }

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
 * O texto que a resposta teria: o campo `text` da saída, escrita em JSON ou já
 * como objeto, ou a saída inteira. Saída que é um Adaptive Card sem `text` mostra
 * os textos do cartão, e o JSON dele quando não tem nenhum.
 */
function textoDaResposta(saida: unknown): string | null {
  let valor = saida;
  if (typeof valor === "string") {
    try {
      valor = JSON.parse(valor);
    } catch {
      return typeof saida === "string" ? saida : null;
    }
  }
  const objeto = valor !== null && typeof valor === "object" ? (valor as { text?: unknown; card?: unknown }) : null;
  if (typeof objeto?.text === "string") return objeto.text;
  if (objeto === null) return typeof saida === "string" ? saida : null;
  const card = objeto.card !== null && typeof objeto.card === "object" ? objeto.card : objeto;
  return resumoDoCard(card) ?? (typeof saida === "string" ? saida : null);
}

/** Os textos do corpo de um Adaptive Card, um por linha; o JSON do cartão se não houver nenhum. */
function resumoDoCard(card: object): string | null {
  const textos: string[] = [];
  const colher = (no: unknown): void => {
    if (Array.isArray(no)) return no.forEach(colher);
    if (no === null || typeof no !== "object") return;
    const o = no as Record<string, unknown>;
    if (typeof o.text === "string" && o.text.trim() !== "") textos.push(o.text);
    for (const filho of [o.body, o.items, o.columns, o.facts]) colher(filho);
  };
  colher((card as { body?: unknown }).body);
  if (textos.length > 0) return textos.join("\n");
  const json = JSON.stringify(card, null, 2);
  return json === undefined || json === "{}" ? null : json;
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
    // A mensagem do Teams onde o review reage ao sair, e o `prOwner` que
    // distingue o evento de PR do de conversa na hora de achar a resposta.
    ...TEAMS_REACAO,
    "prOwner",
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
/** Teto do contexto da iniciativa no prompt. O ops-review tem uns 10 mil caracteres. */
const TETO_DO_CONTEXTO = 40_000;

/**
 * O `context.md` da iniciativa do run, com um título que diz de onde veio.
 * Nulo quando a iniciativa não tem o arquivo; falha de leitura não derruba o
 * passo, que segue sem o contexto.
 */
async function lerContextoDaIniciativa(initiativeId: string): Promise<string | null> {
  const [linha] = await db
    .select({ title: schema.initiatives.title, contextPath: schema.initiatives.contextPath })
    .from(schema.initiatives)
    .where(eq(schema.initiatives.id, initiativeId));
  if (linha === undefined) return null;
  const texto = await readFile(join(linha.contextPath, "context.md"), "utf8").catch(() => null);
  if (texto === null || texto.trim() === "") return null;
  return `# Contexto da iniciativa ${linha.title}\n\n${texto.slice(0, TETO_DO_CONTEXTO)}`;
}

/** Quantos acontecimentos de um passo ficam guardados; os mais velhos saem. */
const TETO_DE_ATIVIDADES = 300;

const TEAMS_REACAO = ["teamsChatId", "teamsTeamId", "teamsChannelId", "teamsMessageId", "teamsReplyToId", "teamsAccount"] as const;

const DESTINO = ["owner", "repo", "pull", "headSha", "prOwner", ...TEAMS_REACAO] as const;

export function destinoDoEvento(alvo: Record<string, unknown>): Record<string, unknown> {
  const destino: Record<string, unknown> = {};
  for (const campo of DESTINO) {
    if (alvo[campo] !== undefined) destino[campo] = alvo[campo];
  }
  // Os campos da reação entram mesmo ausentes, como `undefined`: ao serem
  // espalhados por cima da saída do modelo, apagam o que ele inventou. Sem
  // isso, evento de outra origem deixaria o modelo apontar a reação do review
  // para uma conversa qualquer do Teams.
  // O `prOwner` também: com ele a saída do modelo trocaria o caminho de
  // conversa pelo de PR, e o `teams*` que ela inventasse valeria.
  for (const campo of [...TEAMS_REACAO, "prOwner"]) destino[campo] = alvo[campo];
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

/** O que o passo de resposta diz quando o run de teste não tem conversa de origem. */
/** Por que o passo virou ensaio, em código: o renderer traduz. */
export const ENSAIO_SEM_CONVERSA = "sem-conversa";
export const ENSAIO_EVENTO_COLADO = "evento-colado";

/**
 * Se a ação sairia do Locum. Só passa como leitura o `http.request` GET e o
 * `mcp.call` de ferramenta que o servidor anotou como leitura (`readOnlyHint`,
 * no cache da última leitura): o nome sozinho engana (`query`, `report_issue`).
 * Sem anotação conhecida, conta como escrita.
 */
async function publicaParaFora(
  step: ActionStep,
  payload: EventPayload,
  outputs: Map<string, unknown>,
  guardadas: (servidor: string) => Promise<readonly FerramentaClassificavel[] | null>,
): Promise<boolean> {
  const params = step.params === undefined ? {} : (renderParams(step.params, payload, outputs) as Record<string, unknown>);
  if (step.action === "mcp.call") {
    if (typeof params.server !== "string" || typeof params.tool !== "string") return true;
    const ferramenta = (await guardadas(params.server).catch(() => null))?.find((f) => f.name === params.tool);
    return ferramenta?.readOnlyHint !== true || !ehLeituraDa(ferramenta);
  }
  if (step.action === "http.request") return String(params.method ?? "POST").toUpperCase() !== "GET";
  return true;
}

/** Motivo gravado no passo que ficou sem rodar porque um anterior falhou. */
export const NAO_RODOU = "not_run";

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
