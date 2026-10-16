import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { agentService } from "../services/agent-service.js";
import { machineId, machineService } from "../services/machine-service.js";
import { mcpService } from "../services/mcp-service.js";
import { metricsService } from "../services/metrics-service.js";
import { providerService } from "../services/provider-service.js";
import { runService } from "../services/run-service.js";
import { origemParaLeitura, redactServerConfig } from "./redact.js";
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
    "get_provider_limits",
    {
      description:
        "Limits of every provider in one model: subscription windows (Claude Code 5h and weekly, Codex), API rate limits read from response headers, gateway budgets and the local daily/monthly budget. Each limit has usage 0..1, the reset time (epoch s) and its origin. pausaAte is set while automations are paused for that provider.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => respond(async () => (await import("../services/limites-padrao.js")).visaoDosLimites()),
  );

  server.registerTool(
    "refresh_provider_limits",
    {
      description:
        "Refreshes the limits of one provider. For claude-code it makes one minimal Haiku call (spends a little subscription quota); for a registered OpenAI-compatible gateway it asks GET /key/info, at most every 10 minutes. Other providers have nothing to ask: their readings arrive with each call. Returns { chamou } and the provider's limits.",
      inputSchema: { provider: z.string().describe("provider id, as shown by get_provider_limits") },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ provider }) =>
      respond(async () => {
        const m = await import("../services/limites-padrao.js");
        const { chamou } = await m.atualizarLimites(provider);
        return { chamou, provedor: (await m.visaoDosLimites()).provedores.find((p) => p.provedor === provider) ?? null };
      }),
  );

  server.registerTool(
    "set_provider_budget",
    {
      description: "Sets the local budget of an API provider in USD per day and per month, computed from the spend Locum records. Omit or pass 0 to remove a cap. Writes local settings only.",
      inputSchema: {
        provider: z.string(),
        dayUsd: z.number().min(0).optional(),
        monthUsd: z.number().min(0).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: true },
    },
    async ({ provider, dayUsd, monthUsd }) =>
      respond(async () => {
        const { limitesService } = await import("../services/limites-service.js");
        await limitesService.definirOrcamento(provider, { diaUsd: dayUsd, mesUsd: monthUsd });
        return (await import("../services/limites-padrao.js")).visaoDosLimites();
      }),
  );

  server.registerTool(
    "set_limits_config",
    {
      description:
        "Configures the limit protection: pause automations near a provider limit (on by default), global thresholds as fractions (windowThreshold 0.95, budgetThreshold 1), per-provider thresholds, and whether to use the registered fallback model when a provider is at its limit (off by default; even on, it only switches to an API provider that has a local budget). Manual runs are never paused. Writes local settings only.",
      inputSchema: {
        pauseNearLimit: z.boolean().optional(),
        windowThreshold: z.number().gt(0).max(1).optional(),
        budgetThreshold: z.number().gt(0).max(1.5).optional(),
        providerThresholds: z
          .record(z.string(), z.object({ window: z.number().gt(0).max(1).optional(), budget: z.number().gt(0).max(1.5).optional() }))
          .optional(),
        useFallbackModel: z.boolean().optional(),
        litellmProviders: z.array(z.string()).optional().describe("registered providers that are LiteLLM gateways: only these get the key/info question on refresh"),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: true },
    },
    async (a) =>
      respond(async () => {
        const { limitesService } = await import("../services/limites-service.js");
        await limitesService.gravarConfig({
          ...(a.pauseNearLimit === undefined ? {} : { protecao: a.pauseNearLimit }),
          ...(a.windowThreshold === undefined ? {} : { limiarJanela: a.windowThreshold }),
          ...(a.budgetThreshold === undefined ? {} : { limiarOrcamento: a.budgetThreshold }),
          ...(a.useFallbackModel === undefined ? {} : { usarSubstituto: a.useFallbackModel }),
          ...(a.litellmProviders === undefined ? {} : { gateways: a.litellmProviders }),
          ...(a.providerThresholds === undefined
            ? {}
            : { limiares: Object.fromEntries(Object.entries(a.providerThresholds).map(([k, v]) => [k, { janela: v.window, orcamento: v.budget }])) }),
        });
        return (await import("../services/limites-padrao.js")).visaoDosLimites();
      }),
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
      description:
        "Metrics per agent version and the recorded daily spend. Spend rows with kind \"agent\" (id biblioteca:<id>) are library agents. An automation step that uses a library agent counts in both its own row and the agent row, so do not add the two kinds; ask_agent counts only in the agent row.",
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
  const vinculos = await mcpService.vinculos();
  // O nome da credencial pode sair; o segredo mora no keychain e nunca passa
  // por aqui, e valor escrito direto no `env` ou nos `headers` sai oculto.
  return entries.map((entrada) => {
    const vinculo = vinculos[entrada.config.name];
    // Vinculado, o que vale é a configuração da origem, e não a cópia aceita.
    const config = vinculo === undefined ? entrada.config : { ...entrada.config, ...(vinculo.efetivo as Partial<typeof entrada.config>) };
    return {
      ...redactServerConfig(config),
      enabled: entrada.enabled,
      credentialRef: entrada.credentialRef,
      ...origemParaLeitura(entrada, vinculo),
    };
  });
}

async function listProviders(model?: string) {
  return {
    providers: providerService.listProviders(),
    fallbacks: await providerService.getFallbacks(machineId),
    resolution:
      model === undefined ? undefined : await providerService.resolvePreview(model, machineId),
  };
}
