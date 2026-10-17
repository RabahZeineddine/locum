import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "../db/index.js";
import { agentService } from "../services/agent-service.js";
import { ArquivarRecusado, DeletarRecusado, automationService, type BloqueioDeArquivar, type BloqueioDeDeletar } from "../services/automation-service.js";
import { esperaChats, triggerService, type TriggerEntry } from "../services/trigger-service.js";
import { scheduler } from "../triggers/scheduler.js";
import { lerDescartes } from "../triggers/descartes.js";
import { lerErro } from "../triggers/erros.js";
import { AgentSpec as EsquemaDoSpec, TriggerConfig as EsquemaDoGatilho, type AgentSpec, type TriggerConfig, type TriggerConfigInput } from "../config/types.js";
import { referenciasDoFluxo } from "../services/referencias-service.js";
import { specAtual } from "./config-tools.js";
import { restoreSpec } from "./redact.js";
import { limparSegredos } from "../pacote/limpeza.js";
import { def } from "./tool-def.js";

/**
 * Automações e gatilhos: o que o canvas faz.
 *
 * A automação não tem tabela, é o agent de fluxo mais os gatilhos dele. Gravar
 * pelo `save_automation` é o que a tela faz ao salvar: como pessoa, e por isso
 * o passo de ação pode ficar em `auto`. Ligar um gatilho é o que faz o app agir
 * sozinho com a conta da pessoa, e as ferramentas que ligam ou disparam dizem
 * isso na descrição e na anotação para o cliente perguntar antes.
 */

const EFEITO_DE_LIGAR =
  "Turning on makes the app act by itself with your accounts: it polls, spends model budget and starts runs, and an action step in auto mode publishes without asking. The trigger itself never reacts or writes anywhere: reactions (teams.react, slack.react) are steps of the flow.";

/** O erro do gatilho é texto de fora (resposta de API, mensagem de rede), que só se lê: pode trazer token colado. */
function semSegredo<E extends { texto: string }>(erro: E | null): E | null {
  return erro === null ? null : { ...erro, texto: limparSegredos(erro.texto) };
}

async function paraLeitura(entrada: TriggerEntry) {
  return {
    id: entrada.id,
    agentId: entrada.agentId,
    kind: entrada.config.kind,
    enabled: entrada.enabled,
    config: entrada.config,
    lastError: semSegredo(await lerErro(db, entrada.id)),
    ...(esperaChats(entrada.config) ? { blockedUntil: "chats are chosen: set the chats of the trigger, or allow_all_chats_for_trigger" } : {}),
  };
}

async function listAutomations({ archived }: { archived?: boolean | undefined }) {
  const agents = await agentService.list({ arquivadas: archived === true ? "so" : "nao" });
  return Promise.all(
    agents.map(async (agent) => {
      const latest = await agentService.getLatestVersion(agent.id);
      const triggers = await Promise.all((await triggerService.list(agent.id)).map(paraLeitura));
      return {
        id: agent.id,
        name: agent.name,
        latestVersion: latest?.version ?? null,
        stepCount: latest?.spec.steps.length ?? 0,
        pending: latest?.spec.pendentes ?? [],
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
    pending: automacao.version.spec.pendentes ?? [],
    downgraded: automacao.version.spec.rebaixados ?? [],
    enabled: automacao.triggers.some((t) => t.enabled),
    triggers: await Promise.all(automacao.triggers.map(paraLeitura)),
  };
}

const ACAO_DO_BLOQUEIO: Record<BloqueioDeArquivar["kind"], (n: number) => string> = {
  running: (n) => `${n} run(s) queued or running: open the app so each one finishes, is resumed or cancelled, then archive`,
  pending: (n) => `${n} approval(s) pending: decide them in the approval queue, then archive`,
  publishing: (n) => `${n} approval(s) publishing: resolve the stuck publication in the approval queue (check at the destination whether it went out), then archive`,
  conversing: (n) => `${n} run conversation(s) in progress: wait for the answer to end or cancel it (run_chat_cancel), then archive`,
};

function frasesDeBloqueio(blockers: BloqueioDeArquivar[]): string {
  return blockers.map((b) => ACAO_DO_BLOQUEIO[b.kind](b.count)).join("; ");
}

function frasesDeBloqueioDeDeletar(blockers: BloqueioDeDeletar[]): string {
  return blockers
    .map((b) => (b.kind === "active" ? "the automation is in use: archive it first (archive_automation), then delete" : ACAO_DO_BLOQUEIO[b.kind](b.count).replace(/then archive$/, "then delete")))
    .join("; ");
}

export function registerAutomationTools(server: McpServer): void {
  def(server, "list_automations", "read",
    "Lists the automations (a flow agent plus its triggers) with the latest version, the step count, whether any trigger is on, the fields still to fill (pending: where, field path and reason code) and each trigger with kind, enabled state and last error.",
    { archived: z.boolean().optional().describe("true lists the archived automations instead of the ones in use") },
    listAutomations);

  def(server, "get_automation", "read",
    "An automation with the spec of its latest version and its triggers (config, enabled state and last error of each). pending lists the fields still to fill after a package import (where: a step key or gatilho:<trigger id>; field: the path inside it; reason: a code such as destino-a-escolher). downgraded lists the action steps that came as auto in a package and entered in approval (step, reason): setting the step to auto in save_automation, as a person, brings it back and clears the mark. A step with a pending field does not run (the run fails naming it) and the automation cannot be turned on; saving with the field filled clears it.",
    { agentId: z.string().describe("automation id, as shown by list_automations") },
    ({ agentId }) => getAutomation(agentId));

  def(server, "list_step_references", "read",
    "What a step can cite with {{...}}, as the editor offers it: groups in flow order, the event of the triggers first and then each earlier step with its number and name, each with the paths the executor resolves (event.title, steps.review.findings.0.severity) and the type and description the source declares in its JSON Schema. Items marked origin last-run come from the last run's output, not from a schema. Pass agentId for a saved automation, or spec and triggers for a draft. The marker always uses the step key, never the number: the number only places the step in the flow and changes with it.",
    {
      agentId: z.string().optional().describe("saved automation id; the last runs outputs are read too"),
      spec: z.record(z.string(), z.unknown()).optional().describe("draft AgentSpec, when there is no saved automation"),
      triggers: z.array(z.record(z.string(), z.unknown())).optional().describe("draft trigger configs, as in set_trigger"),
      stepKey: z.string().optional().describe("only this step; omitted gives every step"),
    },
    async ({ agentId, spec, triggers, stepKey }) => {
      let fluxo: { spec: AgentSpec; triggers: TriggerConfig[] };
      if (spec !== undefined) {
        fluxo = { spec: EsquemaDoSpec.parse(spec), triggers: (triggers ?? []).map((t) => EsquemaDoGatilho.parse(t)) };
      } else if (agentId !== undefined) {
        const automacao = await automationService.get(agentId);
        if (automacao === null) throw new Error(`automacao "${agentId}" nao cadastrada`);
        fluxo = { spec: automacao.version.spec, triggers: automacao.triggers.map((t) => t.config) };
      } else {
        throw new Error("informe agentId ou spec");
      }
      const todas = await referenciasDoFluxo({ ...fluxo, ...(agentId === undefined ? {} : { agentId }) });
      if (stepKey === undefined) return todas;
      const dele = todas[stepKey];
      if (dele === undefined) throw new Error(`passo "${stepKey}" nao existe no fluxo`);
      return { [stepKey]: dele };
    });

  def(server, "list_triggers", "read",
    "Triggers of every automation, or of one, with config, enabled state and last error (configuration or poll). A Teams trigger from a package that still waits for its chats says so and cannot be turned on.",
    { agentId: z.string().optional().describe("only the triggers of this automation") },
    async ({ agentId }) => Promise.all((await triggerService.list(agentId)).map(paraLeitura)));

  def(server, "list_trigger_discards", "read",
    "The latest pull requests a trigger saw and did not turn into an event, with the reason of each, newest first. Reads what the polling already recorded.",
    { triggerId: z.string().min(1) },
    async ({ triggerId }) => {
      if ((await triggerService.get(triggerId)) === undefined) throw new Error(`gatilho ${triggerId} nao cadastrado`);
      return lerDescartes(db, triggerId);
    });

  def(server, "get_trigger_schedule", "read",
    "Every trigger with its schedule: when it last fired and when the scheduler will wake it next (null for a disabled trigger, and for a webhook).",
    {}, () => scheduler.schedule());

  def(server, "suggest_automation_id", "read",
    "A free automation id derived from a name, for a new automation.",
    { name: z.string().min(1) }, ({ name }) => automationService.suggestId(name));

  def(server, "preview_github_trigger", "read-external",
    "What the GitHub polling would do now with a poll trigger config, which may not be saved: each open pull request with whether it enters or not and why. Reads GitHub with your token and writes no cursor, event or discard.",
    { config: z.record(z.string(), z.unknown()).describe('a {"kind":"poll","source":"github",...} config, as in set_trigger') },
    async ({ config }) => (await import("../services/trigger-preview.js")).previaDoGatilho(config as unknown as TriggerConfigInput));

  def(server, "save_automation", "publish",
    "Records an automation as the app screen does when it saves: the flow spec (AgentSpec, as in upsert_agent) as a new immutable version, and its triggers in one call. Triggers with an id update that trigger, the ones without id are new, and existing triggers left out of the list are removed. Saved as a person: an action step can be set to auto here, and then it publishes without approval once the automation runs (upsert_agent, in contrast, lowers actions to approval). An mcp.call that writes is the exception: it only publishes without approval with params.autoEscrita: true, written on the node itself (a {{...}} reference does not count); without it the call goes to the approval queue even in auto. A new trigger starts disabled unless enabled is true, which turns it on (so this tool acts like set_automation_enabled: " + EFEITO_DE_LIGAR + "). A Teams trigger from a package that waits for its chats refuses to be saved empty unless valerParaTodosOsChats is true. Fields still to fill (pending) are cleared when the saved step or trigger has a value at the path (a skill one, when the skill exists here); saving keeps the ones left from the previous version, even if the spec you send has no pendentes, and only dismissPending removes one without filling it; enabled true is refused while any remains. Without create the automation must already exist; with create the id must be free.",
    {
      spec: z.record(z.string(), z.unknown()).describe("full AgentSpec: id, name, steps and the rest of the get_agent format"),
      triggers: z
        .array(
          z.object({
            id: z.string().optional().describe("an existing trigger of this automation, to update it"),
            config: z.record(z.string(), z.unknown()).describe("trigger config, in the formats of set_trigger"),
            enabled: z.boolean().optional().describe("true turns the trigger on: " + EFEITO_DE_LIGAR),
            valerParaTodosOsChats: z.boolean().optional().describe("the trigger that waited for the choice of chats now covers all chats"),
          }),
        )
        .describe("the whole list of triggers the automation should have"),
      note: z.string().describe("what changed, stored with the version"),
      create: z.boolean().optional().describe("true for a new automation: refused when the id already exists"),
      dismissPending: z
        .array(z.object({ onde: z.string().describe("the step key, or gatilho:<trigger id>"), campo: z.string().describe("the field path, as listed in pending") }))
        .optional()
        .describe("pending items the person dismisses by name, leaving the field as it is; one that does not exist is refused"),
    },
    async ({ spec, triggers, note, create, dismissPending }) => {
      const { spec: inteiro, semValor } = restoreSpec(await specAtual(spec), spec);
      const salvo = await automationService.save({
        spec: inteiro as unknown as AgentSpec,
        triggers: triggers.map((t) => ({
          ...(t.id === undefined ? {} : { id: t.id }),
          config: t.config as unknown as TriggerConfigInput,
          ...(t.enabled === undefined ? {} : { enabled: t.enabled }),
          ...(t.valerParaTodosOsChats === undefined ? {} : { valerParaTodosOsChats: t.valerParaTodosOsChats }),
        })),
        note,
        ...(create === undefined ? {} : { create }),
        ...(dismissPending === undefined ? {} : { dispensadas: dismissPending }),
      });
      return {
        agentId: salvo.version.agentId,
        version: salvo.version.version,
        pending: salvo.version.spec.pendentes ?? [],
        ...(semValor.length > 0 ? { hiddenWithoutValue: semValor } : {}),
        triggers: await Promise.all(salvo.triggers.map(paraLeitura)),
      };
    });

  def(server, "set_automation_enabled", "publish",
    "Turns every trigger of an automation on or off. " + EFEITO_DE_LIGAR + " Turning off stops it waking by itself; the agent can still run by hand. A Teams trigger from a package that still waits for its chats, or an automation with fields still to fill (pending), blocks turning on.",
    { agentId: z.string(), enabled: z.boolean() },
    async ({ agentId, enabled }) => {
      if (!(await agentService.get(agentId))) throw new Error(`automacao "${agentId}" nao cadastrada`);
      return Promise.all((await automationService.setEnabled(agentId, enabled)).map(paraLeitura));
    });

  def(server, "set_trigger_enabled", "publish",
    "Turns one trigger on or off. " + EFEITO_DE_LIGAR + " A Teams trigger from a package that still waits for its chats (chatsPendentes) blocks turning on until the chats are chosen, and so does an automation with fields still to fill (pending).",
    { triggerId: z.string().min(1), enabled: z.boolean() },
    async ({ triggerId, enabled }) => paraLeitura(await triggerService.setEnabled(triggerId, enabled)));

  def(server, "remove_trigger", "danger",
    "Removes a trigger, with its recorded discards and last error. The automation stays and can still run by hand. Irreversible.",
    { triggerId: z.string().min(1) },
    async ({ triggerId }) => {
      if ((await triggerService.get(triggerId)) === undefined) throw new Error(`gatilho ${triggerId} nao cadastrado`);
      return { triggerId, removed: await triggerService.remove(triggerId) };
    });

  def(server, "archive_automation", "danger",
    "Archives an automation: it leaves list_automations and the scheduler, and its triggers are deleted together with the state tied to them (cursors, discards, last error). Runs, findings, approvals and versions stay, as the trail of what was published in the person's name, and the id stays taken. unarchive_automation brings it back without triggers and off; the triggers must be created again. Refused while a run is queued or running, or an approval is pending or publishing, and for an automation linked to an initiative (a person decides that, on the screen): the message says what to do.",
    { agentId: z.string().describe("automation id, as shown by list_automations") },
    async ({ agentId }) => {
      const previa = await automationService.archivePreview(agentId);
      if (previa.blockers.length > 0) throw new Error(frasesDeBloqueio(previa.blockers));
      // A recusa por corrida, dentro da transação, sai pela mesma frase da prévia.
      return automationService.archive(agentId, "agent").catch((e: unknown) => {
        throw e instanceof ArquivarRecusado ? new Error(frasesDeBloqueio(e.blockers)) : e;
      });
    });

  def(server, "delete_automation", "danger",
    "Deletes an ARCHIVED automation for good, with everything that belongs to it: versions, triggers and the state tied to them, runs with their steps, approvals and findings, budget, spend and the events pasted by hand for it. The agents of the library and the skills stay. Irreversible, and the id becomes free; the dedupe of reviews loses the approvals it read. An active automation is refused (archive_automation first), and so is one with a run queued or running, an approval pending or publishing, or linked to an initiative (a person decides that, on the screen): the message says what to do.",
    { agentId: z.string().describe("id of an archived automation, as listed by list_automations with archived true") },
    async ({ agentId }) => {
      const previa = await automationService.deletePreview(agentId);
      if (previa.blockers.length > 0) throw new Error(frasesDeBloqueioDeDeletar(previa.blockers));
      return automationService.delete(agentId, "agent").catch((e: unknown) => {
        throw e instanceof DeletarRecusado ? new Error(frasesDeBloqueioDeDeletar(e.blockers)) : e;
      });
    });

  def(server, "unarchive_automation", "write",
    "Takes an automation out of the archive: it goes back to list_automations, without triggers and off. Create the triggers again with save_automation or set_trigger; a person turns them on.",
    { agentId: z.string().describe("automation id, as listed by list_automations with archived true") },
    ({ agentId }) => automationService.unarchive(agentId));

  def(server, "allow_all_chats_for_trigger", "danger",
    "The 'valid for all chats' button of a Teams trigger that came from a package and waits for its chats to be chosen: it clears the pending choice and leaves the chats list empty, so the trigger watches ALL group and direct chats of the account. To watch only some chats, use set_trigger with the chats list instead (ids from list_teams_chats).",
    { triggerId: z.string().min(1) },
    async ({ triggerId }) => {
      const atual = await triggerService.get(triggerId);
      if (atual === undefined) throw new Error(`gatilho ${triggerId} nao cadastrado`);
      if (atual.config.kind !== "teams-inbox") throw new Error("so o gatilho do Teams escolhe chats");
      const salvo = await triggerService.set(atual.agentId, { ...atual.config, chatsPendentes: 0, chats: [] } as TriggerConfigInput, {
        id: triggerId,
        valerParaTodosOsChats: true,
      });
      return paraLeitura(salvo);
    });

  def(server, "list_automation_events", "read",
    "Whether an automation depends on an event (its prompts use {{event.*}} or a step needs a conversation: teams.post, slack.post, github.review_comment without a target) and the latest events its triggers recorded, with source, author, excerpt and date. Use an id as eventId in run_automation_now.",
    { agentId: z.string().describe("automation id, as shown by list_automations") },
    ({ agentId }) => automationService.eventsForRun(agentId));

  def(server, "run_automation_now", "publish",
    "Runs an automation once, like the Run now button. Returns the run id at once; follow it with get_run. An automation that depends on an event (see list_automation_events) needs eventId, a recent event, or prUrl, a GitHub pull request link that is turned into the event the Teams trigger would build (reads GitHub with your token); without one it is refused before any model step. A run from prUrl is a dry run: every action that publishes outside (teams.post, slack.post, github.review_comment, tracker.create_issue, an mcp.call that writes, an http.request that is not GET) ends as a dry run that shows the text and nothing is published. With eventId from a trigger, an action step in approval mode stops at the approval queue; an action step in auto mode PUBLISHES IN YOUR NAME without asking (GitHub comment, Slack or Teams message, task in the tracker, external call).",
    {
      agentId: z.string(),
      eventId: z.string().optional().describe("a recent event, as shown by list_automation_events"),
      prUrl: z.string().optional().describe("link of a GitHub pull request, e.g. https://github.com/owner/repo/pull/123"),
    },
    ({ agentId, eventId, prUrl }) =>
      automationService.runNow(agentId, { ...(eventId === undefined ? {} : { eventId }), ...(prUrl === undefined ? {} : { prUrl }) }));

  def(server, "tick_triggers", "publish",
    "Runs one polling round now over every enabled trigger, as the Check now button does, without waiting for the runs to finish. It reads GitHub, Slack or Teams with your accounts and starts runs (an action in auto mode publishes in your name; triggers never react or write on their own, that is what steps are for). Returns what each trigger did.",
    {}, () => scheduler.tick({ reason: "manual", wait: false }));
}
