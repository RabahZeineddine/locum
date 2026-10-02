import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { agentService } from "../services/agent-service.js";
import { machineId } from "../services/machine-service.js";
import { mcpService } from "../services/mcp-service.js";
import { providerService } from "../services/provider-service.js";
import { triggerService } from "../services/trigger-service.js";
import type { AgentSpec, McpServerConfig, McpServerInput, TriggerConfigInput } from "../config/types.js";
import { redactServerConfig, restoreHidden } from "./redact.js";
import { respond } from "./respond.js";

/**
 * Ferramentas de configuracao do servidor MCP.
 *
 * Toda gravacao sai da camada de servico, que e onde as regras moram: versao
 * imutavel de agent, deteccao de ciclo na tabela de substituicao, gatilho que
 * nasce desabilitado. O servidor aqui e casca, e por isso um assistente
 * externo nao consegue contornar nenhuma delas.
 *
 * O que entra vem como objeto solto e e validado pelo zod do servico, nao por
 * um schema duplicado aqui. A validacao precisa ser a mesma que a linha de
 * comando e a interface aplicam, senao o servidor viraria a porta larga.
 *
 * Aprovacao e publicacao continuam fora, sem excecao, conforme o ADR 0002.
 * Gravar e reversivel e auditavel; publicar no nome de outra pessoa nao e.
 */
/**
 * O cadastro que a ferramenta grava: o que veio, completado pelo que ja estava.
 *
 * O servico grava o objeto inteiro, porque a tela manda sempre o formulario
 * completo e um campo vazio la quer dizer apagar. Um assistente manda so o que
 * quer mudar, e sem esta mistura trocar o `scope` apagava o `Authorization`
 * que o OAuth tinha posto. Com transporte novo, comando e endereco do antigo
 * nao fazem sentido e nao sao herdados.
 */
export function mergeRegistration(atual: McpServerConfig | undefined, novo: McpServerInput): McpServerInput {
  if (atual === undefined) return novo;
  const herda = <K extends keyof McpServerInput>(campo: K, deAtual: McpServerInput[K]) =>
    novo[campo] === undefined && deAtual !== undefined ? { [campo]: deAtual } : {};
  const mesmoTransporte = atual.transport === novo.transport;
  return {
    ...novo,
    ...(novo.env !== undefined ? { env: restoreHidden(atual.env, novo.env) } : {}),
    ...(novo.headers !== undefined ? { headers: restoreHidden(atual.headers, novo.headers) } : {}),
    ...herda("scope", atual.scope),
    ...herda("idleTimeoutMs", atual.idleTimeoutMs),
    ...(mesmoTransporte
      ? {
          ...herda("command", atual.command),
          ...herda("env", atual.env),
          ...herda("url", atual.url),
          ...herda("headers", atual.headers),
        }
      : {}),
  };
}

export function registerConfigTools(server: McpServer): void {
  server.registerTool(
    "upsert_agent",
    {
      description:
        "Records an AgentSpec as a new immutable version. A spec identical to the latest returns the existing version. An invalid spec records nothing. Action steps recorded here start in approval mode: draft and auto are downgraded, and the response reports the downgrade.",
      inputSchema: {
        spec: z
          .record(z.string(), z.unknown())
          .describe("full AgentSpec: id, name, steps and the rest of the get_agent format"),
        note: z.string().optional().describe("reason for the change, stored with the version"),
      },
    },
    async ({ spec, note }) =>
      respond(async () => {
        // "agent" e o teto: passo de acao gravado daqui nasce em aprovacao, e
        // qualquer tentativa de subir para rascunho ou automatico volta
        // rebaixada, com o rebaixamento declarado na resposta.
        const version = await agentService.upsert(spec as unknown as AgentSpec, note, "agent");
        return {
          agentId: version.agentId,
          version: version.version,
          note: version.note,
          downgrades: version.downgrades,
          ...(version.downgrades.length > 0
            ? {
                aviso:
                  "passo de acao so sobe de modo por decisao de uma pessoa, pela interface ou pela linha de comando",
              }
            : {}),
        };
      }),
  );

  server.registerTool(
    "register_mcp_server",
    {
      description:
        "Registers or updates an MCP server that Locum consumes as a client. The name is the key that steps reference. On update, fields left out keep their current value; changing transport, url or command unlinks the stored credential.",
      inputSchema: {
        name: z.string().min(1),
        transport: z.enum(["stdio", "http", "sse"]),
        command: z
          .array(z.string())
          .optional()
          .describe("executable and arguments already split, required for stdio"),
        env: z.record(z.string(), z.string()).optional(),
        url: z.string().optional().describe("required for http and sse"),
        headers: z.record(z.string(), z.string()).optional(),
        scope: z
          .enum(["read", "write"])
          .optional()
          .describe("write does not allow external writes without approval, it only classifies"),
        idleTimeoutMs: z.number().int().positive().optional(),
        enabled: z
          .boolean()
          .optional()
          .describe("whether the executor can see the server; when absent, keeps the current value"),
      },
    },
    async ({ enabled, ...config }) =>
      respond(async () => {
        const atual = await mcpService.get(config.name);
        const entry = await mcpService.register(mergeRegistration(atual?.config, config as McpServerInput));
        if (enabled !== undefined) await mcpService.setEnabled(entry.config.name, enabled);
        return { ...redactServerConfig(entry.config), enabled: enabled ?? entry.enabled };
      }),
  );

  server.registerTool(
    "test_mcp_server",
    {
      description:
        "Starts the registered server, counts its tools and shuts it down. A connection failure comes back as a result, not as an error.",
      inputSchema: { name: z.string().min(1) },
    },
    async ({ name }) => respond(() => mcpService.testConnection(name)),
  );

  server.registerTool(
    "list_server_tools",
    {
      description:
        "Tools a registered server exposes, with description and estimated schema tokens, to choose which ones a step uses.",
      inputSchema: { name: z.string().min(1) },
    },
    async ({ name }) => respond(() => mcpService.listTools(name)),
  );

  server.registerTool(
    "set_model_fallback",
    {
      description:
        "Records a model fallback for this machine. A circular chain is refused on write.",
      inputSchema: {
        fromModel: z.string().describe("as provider/model"),
        toModel: z.string().describe("as provider/model"),
        order: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("attempt order among the fallbacks of the same model"),
        machineId: z
          .string()
          .optional()
          .describe("when absent, uses this machine, which is the normal case"),
      },
    },
    async ({ fromModel, toModel, order, machineId: target }) =>
      respond(async () => {
        const machine = target ?? machineId;
        await providerService.setFallback(machine, fromModel, toModel, order ?? 0);
        return { machineId: machine, fallbacks: await providerService.getFallbacks(machine) };
      }),
  );

  server.registerTool(
    "set_budget",
    {
      description:
        "Adjusts an agent's spending cap. The budget lives in the spec, so this records a new version. An absent field stays as is and null removes the cap. The token cap is what protects a model without a registered price, whose dollar cost stays at zero.",
      inputSchema: {
        agentId: z.string(),
        perRunUsd: z.number().positive().nullable().optional(),
        perDayUsd: z.number().positive().nullable().optional(),
        perRunTokens: z.number().int().positive().nullable().optional(),
        perDayTokens: z.number().int().positive().nullable().optional(),
        note: z.string().optional(),
      },
    },
    async ({ agentId, perRunUsd, perDayUsd, perRunTokens, perDayTokens, note }) =>
      respond(async () => {
        const version = await agentService.setBudget(
          agentId,
          { perRunUsd, perDayUsd, perRunTokens, perDayTokens },
          note,
        );
        return { agentId, version: version.version, budget: version.spec.budget };
      }),
  );

  server.registerTool(
    "set_trigger",
    {
      description:
        "Registers or updates an agent trigger. It starts disabled, and only a person enables it, in the app or the command line. Changing the config of an enabled trigger disables it again.",
      inputSchema: {
        agentId: z.string(),
        config: z
          .record(z.string(), z.unknown())
          .describe(
            'by kind: {"kind":"schedule","everyMinutes":30}, {"kind":"webhook","path":"..."}, {"kind":"poll","source":"github","owner":"...","repoMatch":"...","authorship":"any|mine|others","includeDrafts":false} {"kind":"mcp-poll","server":"...","tool":"..."} , {"kind":"slack-inbox","mentions":true,"dms":true}, only with Slack connected through the official server, or {"kind":"teams-inbox","mentions":true,"dms":true,"channels":[{"teamId":"...","channelId":"...","label":"..."}]}, only with Teams connected (channels needs the channel scopes)',
          ),
        triggerId: z.string().optional().describe("when absent, registers a new one; when present, updates that one"),
        enabled: z.boolean().optional().describe("only false is accepted here"),
      },
    },
    async ({ agentId, config, triggerId, enabled }) =>
      respond(() =>
        triggerService.set(agentId, config as unknown as TriggerConfigInput, {
          id: triggerId,
          enabled,
          fromTool: true,
        }),
      ),
  );
}
