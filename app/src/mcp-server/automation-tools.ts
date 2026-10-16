import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db/index.js";
import { agentService } from "../services/agent-service.js";
import { automationService } from "../services/automation-service.js";
import { esperaChats, triggerService, type TriggerEntry } from "../services/trigger-service.js";
import { lerDescartes } from "../triggers/descartes.js";
import { lerErro } from "../triggers/erros.js";
import type { AgentSpec, TriggerConfigInput } from "../config/types.js";
import { redactSecrets } from "./redact.js";
import { respond } from "./respond.js";

/**
 * Ferramentas de automação e de gatilho do servidor MCP.
 *
 * A automação não tem tabela: é o agent de fluxo mais os gatilhos dele, e as
 * ferramentas daqui só juntam as duas leituras. A gravação sai do mesmo
 * `automationService` da tela, com o teto de quem escreve de fora: passo de
 * ação sobe só até aprovação e gatilho gravado daqui nasce desligado.
 *
 * Ligar é separado de gravar, e vale uma regra extra: gatilho que reage em
 * nome da pessoa (o `prLinks` do Teams põe 👀 na mensagem) só liga com a
 * confirmação explícita de quem chama. Nada daqui decide a fila de aprovação.
 */

/** O gatilho age em nome da pessoa assim que liga: reage na mensagem do Teams. */
export function reageEmNomeDaPessoa(config: TriggerEntry["config"]): boolean {
  return config.kind === "teams-inbox" && config.prLinks;
}

const CONFIRMACAO =
  "this trigger reacts on Teams messages in the name of the person (👀 when it picks a PR link, then ✅, ⚠️ or 💬 by the review verdict); pass confirmo_reacoes_em_meu_nome: true to turn it on";

function exigirConfirmacao(gatilhos: TriggerEntry[], confirmado: boolean | undefined): void {
  if (gatilhos.some((g) => reageEmNomeDaPessoa(g.config)) && confirmado !== true) throw new Error(CONFIRMACAO);
}

async function paraLeitura(entrada: TriggerEntry) {
  return redactSecrets({
    id: entrada.id,
    agentId: entrada.agentId,
    kind: entrada.config.kind,
    enabled: entrada.enabled,
    config: entrada.config,
    lastError: await lerErro(db, entrada.id),
    ...(esperaChats(entrada.config) ? { blockedUntil: "chats are chosen: set the chats of the trigger" } : {}),
    ...(reageEmNomeDaPessoa(entrada.config) ? { reactsInMyName: true } : {}),
  });
}

async function listAutomations() {
  const agents = await agentService.list();
  return Promise.all(
    agents.map(async (agent) => {
      const latest = await agentService.getLatestVersion(agent.id);
      const triggers = await Promise.all((await triggerService.list(agent.id)).map(paraLeitura));
      return {
        id: agent.id,
        name: agent.name,
        latestVersion: latest?.version ?? null,
        stepCount: latest?.spec.steps.length ?? 0,
        // Ligada é a pergunta da lista: alguma coisa acorda esta automação sozinha.
        enabled: triggers.some((t) => t.enabled),
        triggers,
      };
    }),
  );
}

async function getAutomation(agentId: string) {
  const automacao = await automationService.get(agentId);
  if (automacao === null) throw new Error(`automacao "${agentId}" nao cadastrada`);
  return {
    id: agentId,
    name: automacao.version.spec.name,
    version: automacao.version.version,
    note: automacao.version.note,
    spec: automacao.version.spec,
    enabled: automacao.triggers.some((t) => t.enabled),
    triggers: await Promise.all(automacao.triggers.map(paraLeitura)),
  };
}

export function registerAutomationTools(server: McpServer): void {
  server.registerTool(
    "list_automations",
    {
      description:
        "Lists the automations (a flow agent plus its triggers) with the latest version, the step count, whether any trigger is on, and each trigger with its kind, enabled state and last error.",
      inputSchema: {},
    },
    async () => respond(listAutomations),
  );

  server.registerTool(
    "get_automation",
    {
      description:
        "An automation with the spec of its latest version and its triggers (config, enabled state and last error of each).",
      inputSchema: { agentId: z.string().describe("automation id, as shown by list_automations") },
    },
    async ({ agentId }) => respond(() => getAutomation(agentId)),
  );

  server.registerTool(
    "list_triggers",
    {
      description:
        "Triggers of every automation, or of one, with config, enabled state and last error (configuration or poll). A Teams trigger that came from a package and still waits for its chats says so and cannot be turned on.",
      inputSchema: { agentId: z.string().optional().describe("only the triggers of this automation") },
    },
    async ({ agentId }) =>
      respond(async () => Promise.all((await triggerService.list(agentId)).map(paraLeitura))),
  );

  server.registerTool(
    "list_trigger_discards",
    {
      description:
        "The latest pull requests a trigger saw and did not turn into an event, with the reason of each, newest first. Reads what the polling already recorded.",
      inputSchema: { triggerId: z.string().min(1) },
    },
    async ({ triggerId }) =>
      respond(async () => {
        if ((await triggerService.get(triggerId)) === undefined) throw new Error(`gatilho ${triggerId} nao cadastrado`);
        return redactSecrets(await lerDescartes(db, triggerId));
      }),
  );

  server.registerTool(
    "save_automation",
    {
      description:
        "Records an automation: the flow spec (AgentSpec, as in upsert_agent) as a new immutable version, and its triggers in one call. Triggers with an id update that trigger, the ones without id are new, and the existing triggers left out of the list are removed. Triggers are saved disabled and an enabled value other than false is refused; changing the config of an enabled trigger disables it again; turn triggers on with set_trigger_enabled or set_automation_enabled. Action steps recorded here start in approval mode (draft and auto are downgraded and the response reports it), a step tool from a write server that the previous version did not use is refused, and a budget cap cannot be raised or removed. Without create the automation must already exist; with create the id must be free.",
      inputSchema: {
        spec: z.record(z.string(), z.unknown()).describe("full AgentSpec: id, name, steps and the rest of the get_agent format"),
        triggers: z
          .array(
            z.object({
              id: z.string().optional().describe("an existing trigger of this automation, to update it"),
              config: z.record(z.string(), z.unknown()).describe("trigger config, in the formats of set_trigger"),
              enabled: z.literal(false).optional().describe("only false is accepted here"),
            }),
          )
          .describe("the whole list of triggers the automation should have"),
        note: z.string().describe("what changed, stored with the version"),
        create: z.boolean().optional().describe("true for a new automation: refused when the id already exists"),
      },
    },
    async ({ spec, triggers, note, create }) =>
      respond(async () => {
        const salvo = await automationService.save(
          {
            spec: spec as unknown as AgentSpec,
            triggers: triggers.map((t) => ({
              ...(t.id === undefined ? {} : { id: t.id }),
              config: t.config as unknown as TriggerConfigInput,
              ...(t.enabled === undefined ? {} : { enabled: t.enabled }),
            })),
            note,
            ...(create === undefined ? {} : { create }),
          },
          "agent",
        );
        return {
          agentId: salvo.version.agentId,
          version: salvo.version.version,
          downgrades: salvo.version.downgrades,
          ...(salvo.version.downgrades.length > 0
            ? { aviso: "passo de acao so sobe de modo por decisao de uma pessoa, pela interface ou pela linha de comando" }
            : {}),
          triggers: await Promise.all(salvo.triggers.map(paraLeitura)),
        };
      }),
  );

  server.registerTool(
    "set_automation_enabled",
    {
      description:
        "Turns every trigger of an automation on or off, so it wakes by itself or stops. The agent can still run by hand. A Teams trigger from a package that still waits for its chats blocks turning on. Turning on a Teams trigger with prLinks makes the app react with 👀 (then ✅, ⚠️ or 💬) on Teams messages in the name of the person, so it requires confirmo_reacoes_em_meu_nome: true; turning off never does.",
      inputSchema: {
        agentId: z.string(),
        enabled: z.boolean(),
        confirmo_reacoes_em_meu_nome: z
          .boolean()
          .optional()
          .describe("required as true when a trigger of the automation reacts on Teams messages in the name of the person"),
      },
    },
    async ({ agentId, enabled, confirmo_reacoes_em_meu_nome }) =>
      respond(async () => {
        if (!(await agentService.get(agentId))) throw new Error(`automacao "${agentId}" nao cadastrada`);
        if (enabled) exigirConfirmacao((await triggerService.list(agentId)).filter((g) => !g.enabled), confirmo_reacoes_em_meu_nome);
        return Promise.all((await automationService.setEnabled(agentId, enabled)).map(paraLeitura));
      }),
  );

  server.registerTool(
    "set_trigger_enabled",
    {
      description:
        "Turns one trigger on or off. A Teams trigger from a package that still waits for its chats (chatsPendentes) blocks turning on until the chats are chosen. Turning on a Teams trigger with prLinks makes the app react with 👀 (then ✅, ⚠️ or 💬 by the review verdict) on Teams messages in the name of the person, so it requires confirmo_reacoes_em_meu_nome: true; turning off never does.",
      inputSchema: {
        triggerId: z.string().min(1),
        enabled: z.boolean(),
        confirmo_reacoes_em_meu_nome: z
          .boolean()
          .optional()
          .describe("required as true when the trigger reacts on Teams messages in the name of the person"),
      },
    },
    async ({ triggerId, enabled, confirmo_reacoes_em_meu_nome }) =>
      respond(async () => {
        const atual = await triggerService.get(triggerId);
        if (atual === undefined) throw new Error(`gatilho ${triggerId} nao cadastrado`);
        if (enabled && !atual.enabled) exigirConfirmacao([atual], confirmo_reacoes_em_meu_nome);
        return paraLeitura(await triggerService.setEnabled(triggerId, enabled));
      }),
  );

  server.registerTool(
    "remove_trigger",
    {
      description: "Removes a trigger, with its recorded discards and last error. The automation stays and can still run by hand.",
      inputSchema: { triggerId: z.string().min(1) },
    },
    async ({ triggerId }) =>
      respond(async () => {
        if ((await triggerService.get(triggerId)) === undefined) throw new Error(`gatilho ${triggerId} nao cadastrado`);
        return { triggerId, removed: await triggerService.remove(triggerId) };
      }),
  );

  server.registerTool(
    "run_automation_now",
    {
      description:
        "Runs an automation once, without an event, like the Run now button. Returns the run id at once; follow it with get_run. An action step still stops at the approval queue, which only a person decides.",
      inputSchema: { agentId: z.string() },
    },
    async ({ agentId }) => respond(() => automationService.runNow(agentId)),
  );
}
