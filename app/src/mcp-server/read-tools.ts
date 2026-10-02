import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { agentService } from "../services/agent-service.js";
import { machineId, machineService } from "../services/machine-service.js";
import { mcpService } from "../services/mcp-service.js";
import { metricsService } from "../services/metrics-service.js";
import { providerService } from "../services/provider-service.js";
import { runService } from "../services/run-service.js";
import { respond } from "./respond.js";

/**
 * Ferramentas de leitura do servidor MCP.
 *
 * Toda consulta sai da camada de servico, a mesma que a linha de comando usa.
 * O ganho nao e economia de codigo: e que um assistente externo e o dono da
 * maquina enxergam exatamente o mesmo estado, sem uma segunda leitura do banco
 * que pudesse divergir.
 *
 * Nada aqui escreve. A escrita mora em `config-tools.ts`, e aprovacao e
 * publicacao nao entram em nenhum dos dois, conforme o ADR 0002.
 */
export function registerReadTools(server: McpServer): void {
  server.registerTool(
    "list_agents",
    {
      description: "Lists the registered agents with the latest version of each.",
      inputSchema: {},
    },
    async () => respond(listAgents),
  );

  server.registerTool(
    "get_agent",
    {
      description: "Returns an agent, the spec of its latest version and its version history.",
      inputSchema: {
        agentId: z.string().describe("agent id, as shown by list_agents"),
      },
    },
    async ({ agentId }) => respond(() => getAgent(agentId)),
  );

  server.registerTool(
    "list_runs",
    {
      description: "Lists the most recent runs, optionally filtered by status or agent.",
      inputSchema: {
        status: z.string().optional().describe("queued, running, done, paused or failed"),
        agentId: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ status, agentId, limit }) => respond(() => runService.list({ status, agentId, limit })),
  );

  server.registerTool(
    "get_run",
    {
      description: "Returns a run with its steps and the spec of the version it ran.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => respond(() => getRun(runId)),
  );

  server.registerTool(
    "list_findings",
    {
      description:
        "Findings of a run, from the findings table or from the output of the step that produced them.",
      inputSchema: { runId: z.string() },
    },
    async ({ runId }) => respond(() => runService.findings(runId)),
  );

  server.registerTool(
    "get_metrics",
    {
      description: "Metrics per agent version and the recorded daily spend.",
      inputSchema: {
        agentId: z.string().optional(),
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("spend window, counted back from today"),
      },
    },
    async ({ agentId, days }) => respond(() => metricsService.report({ agentId, days })),
  );

  server.registerTool(
    "list_mcp_servers",
    {
      description:
        "Registered MCP servers, with transport, scope and whether each is exposed to the executor.",
      inputSchema: {},
    },
    async () => respond(listMcpServers),
  );

  server.registerTool(
    "list_providers",
    {
      description:
        "Model providers on this machine, the fallback table and, when asked, where a model would resolve to.",
      inputSchema: {
        model: z
          .string()
          .optional()
          .describe("model as provider/model, to see how it resolves"),
      },
    },
    async ({ model }) => respond(() => listProviders(model)),
  );

  server.registerTool(
    "get_machine_profile",
    {
      description:
        "Snapshot of this machine: identity, database, providers, fallbacks and MCP servers.",
      inputSchema: {},
    },
    async () => respond(() => machineService.profile()),
  );
}

async function listAgents() {
  const agents = await agentService.list();
  return Promise.all(
    agents.map(async (agent) => {
      const latest = await agentService.getLatestVersion(agent.id);
      return {
        id: agent.id,
        name: agent.name,
        enabled: agent.enabled,
        latestVersion: latest?.version ?? null,
        stepCount: latest?.spec.steps.length ?? 0,
      };
    }),
  );
}

async function getAgent(agentId: string) {
  const agent = await agentService.get(agentId);
  if (!agent) throw new Error(`agent "${agentId}" nao cadastrado`);

  const versions = await agentService.listVersions(agentId);
  return {
    id: agent.id,
    name: agent.name,
    enabled: agent.enabled,
    spec: versions[0]?.spec ?? null,
    versions: versions.map((v) => ({ version: v.version, note: v.note, createdAt: v.createdAt })),
  };
}

async function getRun(runId: string) {
  const run = await runService.get(runId);
  if (!run) throw new Error(`run ${runId} nao encontrado`);
  return run;
}

async function listMcpServers() {
  const entries = await mcpService.list();
  // O nome da credencial pode sair; o segredo mora no keychain e nunca passa por aqui.
  return entries.map(({ config, enabled, credentialRef }) => ({ ...config, enabled, credentialRef }));
}

async function listProviders(model?: string) {
  return {
    providers: providerService.listProviders(),
    fallbacks: await providerService.getFallbacks(machineId),
    resolution:
      model === undefined ? undefined : await providerService.resolvePreview(model, machineId),
  };
}
