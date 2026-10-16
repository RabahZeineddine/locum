import { recusarEscritaDaConta } from "../runtimes/claude-account.js";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, schema } from "../db/index.js";
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
 * ferramenta, toolset precisa existir).
 *
 * Por cima vale a mesma regra do `upsert_agent`: ferramenta nova de servidor
 * `write` só entra pela tela, onde a pessoa vê o que está ligando. Remover
 * agent ou toolset é interno e o serviço recusa enquanto algo o usa.
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

  server.registerTool(
    "upsert_library_agent",
    {
      description:
        "Records a library agent as a new version. A spec identical to the latest records nothing. Fields: id (lowercase, digits and dashes), name, description, context, instructions, model (provider/model), temperature (0 to 2, optional), toolsets (ids), tools ([{server, tool, class}]), connections ([{connectionId, tools: {toolName: true|false}}]: reads are on by default, writes off, and `tools` overrides per tool), skills (names or {skill, when}), budget ({perRunUsd, perDayUsd, perRunTokens, perDayTokens}), maxSteps. Tools that write externally are refused: writing goes in an action step. A tool from a write-scope server that the latest version did not already have is refused, and so is turning on a write tool of a connection that the latest version did not already have on: only a person adds it, in the app.",
      inputSchema: {
        spec: z.record(z.string(), z.unknown()).describe("full agent spec, as get_library_agent returns it in `spec`"),
        note: z.string().optional().describe("reason for the change, stored with the version"),
        create: z.boolean().optional().describe("true refuses an id that already exists"),
      },
    },
    async ({ spec, note, create }) =>
      respond(async () => {
        const novo = AgentProfile.parse(spec);
        const anterior = await libraryService.getProfile(novo.id);
        await recusarEscritaNova(await ferramentasDoAgent(novo), anterior === null ? [] : await ferramentasDoAgent(anterior.spec));
        await recusarEscritaDeConexao(novo, anterior?.spec);
        const versao = await libraryService.saveProfile({ spec: novo as AgentProfileInput, note, create });
        return { id: versao.profileId, version: versao.version, note: versao.note };
      }),
  );

  server.registerTool(
    "list_toolsets",
    {
      description: "Named tool sets that library agents include, with the agents that use each one.",
      inputSchema: {},
    },
    async () => respond(() => libraryService.listToolsets()),
  );

  server.registerTool(
    "upsert_toolset",
    {
      description:
        "Records a toolset: id, name, description and tools ([{server, tool, class}]). Has no versions: the change applies to the next run of every agent that includes it. Same refusals as upsert_library_agent for external write and for new tools of a write-scope server.",
      inputSchema: {
        toolset: z.record(z.string(), z.unknown()),
        create: z.boolean().optional().describe("true refuses an id that already exists"),
      },
    },
    async ({ toolset, create }) =>
      respond(async () => {
        const novo = Toolset.parse(toolset);
        const anterior = await libraryService.getToolset(novo.id);
        await recusarEscritaNova(novo.tools, anterior?.tools ?? []);
        return libraryService.saveToolset({ toolset: novo as ToolsetInput, create });
      }),
  );

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

/**
 * Liberar escrita numa conexão só pela tela. Pelo MCP, recusa:
 * - ligar uma ferramenta que o nome marca como escrita, e gravar uma escolha
 *   "read" nova, seja qual for o nome;
 * - conexão nova cujo servidor tem escopo write, e qualquer escolha que
 *   libere ferramenta de conexão assim (ligar uma, ou tirar o desligar).
 * O que a versão anterior já tinha continua valendo.
 */
async function recusarEscritaDeConexao(novo: AgentProfile, anterior: AgentProfile | undefined): Promise<void> {
  const barradas: string[] = [];
  const antes = new Map((anterior?.connections ?? []).map((c) => [c.connectionId, c]));

  for (const c of novo.connections) {
    const antiga = antes.get(c.connectionId);
    for (const [chave, escolha] of Object.entries(c.tools)) {
      if (escolha === false || antiga?.tools[chave] === escolha) continue;
      // "read" é a pessoa dizendo que a ferramenta só lê, e vale mesmo para nome
      // de leitura: o servidor pode ter anotado escrita, e o MCP não consulta.
      // Ligar vale pela anotação que o servidor deixou no cache, e pelo nome só sem ela.
      if (escolha === "read" || (await libraryService.ehEscritaLigada(c, chave))) barradas.push(`${c.connectionId}.${chave}`);
    }
  }

  const escopoWrite = new Set(
    (await db.select({ name: schema.mcpServers.name, scope: schema.mcpServers.scope }).from(schema.mcpServers))
      .filter((s) => s.scope === "write")
      .map((s) => s.name),
  );
  if (escopoWrite.size > 0) {
    const { connectionService } = await import("../services/connection-service.js");
    const conexoes = await connectionService.list();
    for (const c of novo.connections) {
      if (!(conexoes.find((x) => x.id === c.connectionId)?.servers ?? []).some((s) => escopoWrite.has(s))) continue;
      const antiga = antes.get(c.connectionId);
      if (antiga === undefined) {
        barradas.push(`${c.connectionId} (conexão nova)`);
        continue;
      }
      for (const [chave, escolha] of Object.entries(c.tools)) {
        if (escolha !== false && antiga.tools[chave] !== escolha) barradas.push(`${c.connectionId}.${chave}`);
      }
      for (const [chave, escolha] of Object.entries(antiga.tools)) {
        if (escolha === false && c.tools[chave] !== false) barradas.push(`${c.connectionId}.${chave}`);
      }
    }
  }

  if (barradas.length > 0) {
    throw new Error(
      `${[...new Set(barradas)].join(", ")}: liberar escrita, ou abrir conexão de servidor com escopo write, só pela tela do Locum, onde a pessoa decide.`,
    );
  }
}

async function recusarEscritaNova(novas: readonly ToolRef[], jaEstavam: readonly ToolRef[]): Promise<void> {
  recusarEscritaDaConta(novas);
  const escrita = new Set(
    (await db.select({ name: schema.mcpServers.name, scope: schema.mcpServers.scope }).from(schema.mcpServers))
      .filter((s) => s.scope === "write")
      .map((s) => s.name),
  );
  if (escrita.size === 0) return;
  const chave = (t: ToolRef) => `${t.server}.${t.tool}`;
  const antes = new Set(jaEstavam.map(chave));
  const barradas = [...new Set(novas.filter((t) => escrita.has(t.server) && !antes.has(chave(t))).map(chave))];
  if (barradas.length > 0) {
    throw new Error(
      `${barradas.join(", ")} é de servidor com escopo write; ferramenta assim só entra pela tela do Locum, onde a pessoa decide.`,
    );
  }
}

function catalogo() {
  return {
    markers:
      "Text fields accept {{event.field}} and {{steps.<key>}} or {{steps.<key>.field.sub}}. A field that is only one marker keeps the raw value (number, object, list); a marker inside text becomes text. A missing value becomes null.",
    stepBase: {
      key: "unique id of the step inside the automation",
      name: "label shown in the app",
      needs: "keys of the steps this one waits for",
      optional: "true lets the run go on when this step fails",
      when: "{ step, branch }: runs only when the decision step `step` (which must be in needs) chose `branch`. Steps off the chosen path are skipped, and so is whatever depends only on skipped steps. A step that joins two paths runs.",
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
          "for mcp.call: { server, tool, args }; for http.request: { method, url, headers, body }. Accept markers and go on top of the input step output.",
        target: "tracker.create_issue: id of the registered tracker",
        modes:
          "approve stops in the queue for a person; auto publishes on its own; draft prepares without publishing. Recorded from here, every action step starts in approve: only a person raises the mode, in the app.",
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
      "Automation triggers are recorded with set_trigger and start disabled; a person enables them in the app.",
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
