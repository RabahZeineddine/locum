import { recusarEscritaDaConta } from "../runtimes/claude-account.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AgentProfile,
  LogicCompare,
  LogicOp,
  Toolset,
  type AgentProfileInput,
  type ToolRef,
  type ToolsetInput,
} from "../config/types.js";
import { buildGate } from "../executor/build.js";
import { libraryService } from "../services/library-service.js";
import { respond } from "./respond.js";
import { def } from "./tool-def.js";

/**
 * Ferramentas da biblioteca e do catálogo de passos.
 *
 * Com elas um assistente externo monta o que a tela monta: agent reutilizável,
 * toolset e fluxo com decisão e conversão. A gravação sai do `libraryService`,
 * o mesmo da tela, e herda as travas dele (escrita externa não entra como
 * ferramenta, toolset precisa existir). Ferramenta de escrita nova entra como
 * na tela, e a anotação destrutiva é o aviso ao cliente. Remover agent ou
 * toolset é interno e o serviço recusa enquanto algo o usa.
 */
export function registerLibraryTools(server: McpServer): void {
  def(server, "suggest_library_id", "read",
    "A free id for a new library agent or toolset, made from its name, like the editor does.",
    { name: z.string().min(1), kind: z.enum(["profile", "toolset"]) },
    async ({ name, kind }) => ({ id: await libraryService.suggestId(name, kind) }));

  server.registerTool(
    "describe_steps",
    {
      description:
        "Catalog of what an automation (AgentSpec) can contain: step types, logic operations, comparisons, action kinds with the modes each accepts, and the template markers. Read this before writing steps with upsert_agent.",
      inputSchema: {},
    },
    async () => respond(async () => catalogo()),
  );

  server.registerTool(
    "list_library_agents",
    {
      description:
        "Reusable agents of the library (context, instructions, model, temperature, toolsets and tools), with the automations that use each one. A model step references one through `profile`.",
      inputSchema: {},
    },
    async () => respond(() => libraryService.listProfiles()),
  );

  server.registerTool(
    "get_library_agent",
    {
      description: "A library agent with the full spec of its latest version and the version history.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) =>
      respond(async () => {
        const atual = await libraryService.getProfile(id);
        if (atual === null) throw new Error(`agent "${id}" não existe na biblioteca`);
        const versoes = await libraryService.listProfileVersions(id);
        return { ...atual, versions: versoes.map((v) => ({ version: v.version, note: v.note, createdAt: v.createdAt })) };
      }),
  );

  def(server, "upsert_library_agent", "danger",
    "Records a library agent as a new version. A spec identical to the latest records nothing. Fields: id (lowercase, digits and dashes), name, description, context, instructions, model (provider/model), temperature (0 to 2, optional), toolsets (ids), tools ([{server, tool, class}]), connections ([{connectionId, tools: {toolName: true|false}}]: a new connection starts with the reads on and the rest off; when the server's tool list is cached, saving writes it out as an explicit list, and a tool the server gains later stays off until someone turns it on), skills (names or {skill, when}), budget ({perRunUsd, perDayUsd, perRunTokens, perDayTokens}), maxSteps. Adds write tools to the agent when it lists tools of a write-scope server or turns on a write tool of a connection: the automations that use it can then write there. Tools that write externally through the Claude account are refused: writing goes in an action step.",
    {
      spec: z.record(z.string(), z.unknown()).describe("full agent spec, as get_library_agent returns it in `spec`"),
      note: z.string().optional().describe("reason for the change, stored with the version"),
      create: z.boolean().optional().describe("true refuses an id that already exists"),
    },
    async ({ spec, note, create }) => {
      const novo = AgentProfile.parse(spec);
      recusarEscritaDaConta(await ferramentasDoAgent(novo));
      const versao = await libraryService.saveProfile({ spec: novo as AgentProfileInput, note, create });
      return { id: versao.profileId, version: versao.version, note: versao.note };
    });

  def(server, "list_library_agent_versions", "read",
    "Every version of a library agent, newest first, each with its full spec, note and date (get_library_agent lists the versions without the spec).",
    { id: z.string().min(1) }, ({ id }) => libraryService.listProfileVersions(id));

  def(server, "restore_library_agent_version", "danger",
    "Restores an old version of a library agent by recording its spec as a NEW version: the current one stays in the history. The tools and toolsets of the old version come back with it, so the automations that use the agent run with them from the next run. Read the versions with list_library_agent_versions.",
    { id: z.string().min(1), version: z.number().int().positive(), note: z.string().optional() },
    async ({ id, version, note }) => {
      const antiga = await libraryService.getProfileVersion(id, version);
      if (antiga === null) throw new Error(`agent "${id}" não tem a versão ${version} na biblioteca`);
      const spec = AgentProfile.parse(antiga.spec);
      recusarEscritaDaConta(await ferramentasDoAgent(spec));
      const v = await libraryService.saveProfile({ spec: spec as AgentProfileInput, note: note ?? `restaurada da versão ${version}` });
      return { id: v.profileId, version: v.version, note: v.note };
    });

  server.registerTool(
    "list_toolsets",
    {
      description: "Named tool sets that library agents include, with the agents that use each one.",
      inputSchema: {},
    },
    async () => respond(() => libraryService.listToolsets()),
  );

  def(server, "upsert_toolset", "danger",
    "Records a toolset: id, name, description and tools ([{server, tool, class}]). Has no versions: the change applies to the next run of every agent that includes it. Adding a write tool widens what every agent that includes the toolset can write. Tools that write externally through the Claude account are refused.",
    {
      toolset: z.record(z.string(), z.unknown()),
      create: z.boolean().optional().describe("true refuses an id that already exists"),
    },
    async ({ toolset, create }) => {
      const novo = Toolset.parse(toolset);
      recusarEscritaDaConta(novo.tools);
      return libraryService.saveToolset({ toolset: novo as ToolsetInput, create });
    });

  server.registerTool(
    "remove_library_agent",
    {
      description:
        "Deletes a library agent and all its versions. Irreversible: the version history goes with it. Refused while any automation still uses it; the error lists them.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) =>
      respond(async () => {
        if ((await libraryService.getProfile(id)) === null) throw new Error(`agent "${id}" não existe na biblioteca`);
        await libraryService.removeProfile(id);
        return { id, removed: true };
      }),
  );

  server.registerTool(
    "remove_toolset",
    {
      description:
        "Deletes a toolset. Refused while any library agent still includes it; the error lists them.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) =>
      respond(async () => {
        if ((await libraryService.getToolset(id)) === null) throw new Error(`toolset "${id}" não existe`);
        await libraryService.removeToolset(id);
        return { id, removed: true };
      }),
  );
}

/** As ferramentas que o agent alcança: as avulsas e as dos toolsets dele. */
async function ferramentasDoAgent(spec: AgentProfile): Promise<ToolRef[]> {
  const dosToolsets = await Promise.all(spec.toolsets.map((id) => libraryService.getToolset(id)));
  return [...spec.tools, ...dosToolsets.flatMap((t) => t?.tools ?? [])];
}

function catalogo() {
  return {
    markers:
      "Text fields accept {{event.field}} and {{steps.<key>}} or {{steps.<key>.field.sub}}. A field that is only one marker keeps the raw value (number, object, list); a marker inside text becomes text. A missing value becomes null.",
    stepBase: {
      key: "unique id of the step inside the automation",
      name: "label shown in the app",
      needs: "keys of the steps this one waits for",
      optional: "true lets the run go on when this step fails (an action step stays failed with its error and its output is null)",
      when: "{ step, branch }: runs only when the decision step `step` (which must be in needs) chose `branch`. Steps off the chosen path are skipped, and so is whatever depends only on skipped steps. A step that joins two paths runs. A step rejected in the Queue skips every step that depends on it, even a join (`dependency_rejected:<step>`); a publish conflict does not.",
    },
    steps: {
      model: {
        fields: "model (provider/model), prompt, tools [{server, tool, class}], requiresServers, outputSchema (JSON Schema), maxSteps",
        profile:
          "id of a library agent. When present, model, instructions, temperature and tools come from it, and prompt is only the task of this step.",
        output: "the text, or the object that matches outputSchema",
      },
      action: {
        fields: "action (kind below), mode, target, input (key of the step whose output goes in), params",
        params:
          "for mcp.call: { server, tool, args }, which takes any tool of any enabled connection (new connections and new tools need no change): list_server_tools, or list_cached_server_tools without starting the server, gives each tool's inputSchema (JSON Schema for args, required fields included) and readOnlyHint. The editor builds the same form from that schema, and each arg may be a fixed value or a marker like {{event.text}} or {{steps.key.field}} that points to a step that comes before. A tool counts as read only when the server annotated readOnlyHint; without it, it is a write and stays in approve; for http.request: { method, url, headers, body }; for teams.react and slack.react (a reaction on the event's own message, never on one the model names): { emoji, operacao: 'set'|'unset' (default set), tirar (a reaction removed first), porValor: { de: '{{steps.revisar.verdict}}', mapa: { APPROVE: '✅', REQUEST_CHANGES: '⚠️', COMMENT: '💬' }, padrao: '💬' } }. porValor picks the emoji from a value and wins over emoji. Slack takes emoji names (eyes, :eyes:) or the common unicode ones. Without an event message they become a dry run. Nothing reacts unless a step does: triggers never react. Accept markers and go on top of the input step output.",
        target: "tracker.create_issue: id of the registered tracker",
        modes:
          "approve stops in the queue for a person; auto publishes on its own; draft prepares without publishing. upsert_agent lowers every action step to approve. save_automation, save_agent_edited, import_agent and restore_agent_version record the mode as given, like the editor, so an auto action recorded there publishes without asking; the client confirms each of those calls.",
      },
      logic: {
        fields: "op, value, compare, against, cases, title",
        ops: Object.fromEntries(LogicOp.options.map((op) => [op, DESCRICAO_DA_LOGICA[op]])),
        compares: LogicCompare.options,
        branches: 'if gives "true" or "false"; switch gives the matching case or "default". Point the next steps at them with `when`.',
      },
    },
    actions: buildGate().describe(),
    triggers:
      "Automation triggers are recorded with set_trigger (always disabled) or with the triggers of save_automation; turning one on is set_trigger_enabled or set_automation_enabled, which the client confirms because the app then acts by itself with your accounts.",
  };
}

const DESCRICAO_DA_LOGICA: Record<LogicOp, string> = {
  if: "compares value with against using compare, and chooses the true or false path",
  switch: "chooses the case equal to value (trimmed), or default",
  "json.parse": "text to JSON; strips the ```json fence that models add",
  "json.stringify": "JSON to text",
  text: "value as plain text",
  "slack.mrkdwn": "markdown to Slack mrkdwn; output { text }",
  "slack.blocks": "Block Kit with title as header and value in sections; output { text, blocks }",
  "teams.card": "Adaptive Card 1.4 with title and value; output { text, card }",
};
