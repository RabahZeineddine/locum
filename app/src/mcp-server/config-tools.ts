import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { agentService } from "../services/agent-service.js";
import { machineId } from "../services/machine-service.js";
import { mcpService } from "../services/mcp-service.js";
import { providerService } from "../services/provider-service.js";
import { triggerService } from "../services/trigger-service.js";
import type { AgentSpec, McpServerInput, TriggerConfigInput } from "../config/types.js";
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
export function registerConfigTools(server: McpServer): void {
  server.registerTool(
    "upsert_agent",
    {
      description:
        "Grava um AgentSpec como versao nova e imutavel. Spec identico ao topo devolve a versao que ja existe. Spec invalido nao grava nada. Passo de acao gravado por aqui nasce em modo de aprovacao: rascunho e automatico sao rebaixados e o rebaixamento vem na resposta.",
      inputSchema: {
        spec: z
          .record(z.string(), z.unknown())
          .describe("AgentSpec completo: id, name, steps e o resto do formato de get_agent"),
        note: z.string().optional().describe("motivo da alteracao, guardado junto da versao"),
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
        "Cadastra ou atualiza um servidor MCP que o Locum vai consumir como cliente. O nome e a chave que os passos referenciam.",
      inputSchema: {
        name: z.string().min(1),
        transport: z.enum(["stdio", "http", "sse"]),
        command: z
          .array(z.string())
          .optional()
          .describe("executavel e argumentos ja separados, obrigatorio no stdio"),
        env: z.record(z.string(), z.string()).optional(),
        url: z.string().optional().describe("obrigatorio em http e sse"),
        headers: z.record(z.string(), z.string()).optional(),
        scope: z
          .enum(["read", "write"])
          .optional()
          .describe("write nao libera escrita externa sem aprovacao, so classifica"),
        idleTimeoutMs: z.number().int().positive().optional(),
        enabled: z
          .boolean()
          .optional()
          .describe("se o executor pode enxergar o servidor; ausente mantem como esta"),
      },
    },
    async ({ enabled, ...config }) =>
      respond(async () => {
        const entry = await mcpService.register(config as McpServerInput);
        if (enabled !== undefined) await mcpService.setEnabled(entry.config.name, enabled);
        return { ...entry.config, enabled: enabled ?? entry.enabled };
      }),
  );

  server.registerTool(
    "test_mcp_server",
    {
      description:
        "Sobe o servidor cadastrado, conta as ferramentas e encerra. Falha de conexao volta como resultado, nao como erro.",
      inputSchema: { name: z.string().min(1) },
    },
    async ({ name }) => respond(() => mcpService.testConnection(name)),
  );

  server.registerTool(
    "list_server_tools",
    {
      description:
        "Ferramentas que um servidor cadastrado expoe, com descricao e estimativa de tokens do schema, para escolher quais marcar num passo.",
      inputSchema: { name: z.string().min(1) },
    },
    async ({ name }) => respond(() => mcpService.listTools(name)),
  );

  server.registerTool(
    "set_model_fallback",
    {
      description:
        "Grava uma substituicao de modelo para esta maquina. Cadeia circular e recusada na gravacao.",
      inputSchema: {
        fromModel: z.string().describe("no formato provedor/modelo"),
        toModel: z.string().describe("no formato provedor/modelo"),
        order: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("ordem de tentativa entre as saidas do mesmo modelo"),
        machineId: z
          .string()
          .optional()
          .describe("ausente usa esta maquina, que e o caso normal"),
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
        "Ajusta o teto de gasto de um agent. Como o orcamento mora no spec, isso grava versao nova. Campo ausente fica como esta e null tira o teto. O teto em tokens e o que protege modelo sem preco cadastrado, cujo custo em dolar fica zero.",
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
        "Cadastra ou atualiza um gatilho do agent. Nasce desabilitado: habilitar e o passo que deixa o agent acordar sozinho.",
      inputSchema: {
        agentId: z.string(),
        config: z
          .record(z.string(), z.unknown())
          .describe(
            'por tipo: {"kind":"schedule","everyMinutes":30}, {"kind":"webhook","path":"..."}, {"kind":"poll","source":"github","owner":"...","repoMatch":"...","authorship":"any|mine|others","includeDrafts":false} {"kind":"mcp-poll","server":"...","tool":"..."} , {"kind":"slack-inbox","mentions":true,"dms":true}, só com o Slack conectado pelo servidor oficial, ou {"kind":"teams-inbox","mentions":true,"dms":true,"channels":[{"teamId":"...","channelId":"...","label":"..."}]}, só com o Teams conectado (channels pede os escopos de canal)',
          ),
        triggerId: z.string().optional().describe("ausente cadastra, presente atualiza aquele"),
        enabled: z.boolean().optional(),
      },
    },
    async ({ agentId, config, triggerId, enabled }) =>
      respond(() =>
        triggerService.set(agentId, config as unknown as TriggerConfigInput, {
          id: triggerId,
          enabled,
        }),
      ),
  );
}
