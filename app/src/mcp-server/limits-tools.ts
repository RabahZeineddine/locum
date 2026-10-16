import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { def } from "./tool-def.js";

/** Limites de cada provedor, o que a tela de Limites mostra e configura. */
export function registerLimitsTools(server: McpServer): void {
  const visao = async () => (await import("../services/limites-padrao.js")).visaoDosLimites();

  def(server, "get_provider_limits", "read",
    "Limits of every provider in one model: subscription windows (Claude Code 5h and weekly, Codex), API rate limits read from response headers, gateway budgets and the local daily/monthly budget. Each limit has usage 0..1, the reset time (epoch s) and its origin. pausaAte is set while automations are paused for that provider.",
    {}, visao);

  def(server, "refresh_provider_limits", "external",
    "Refreshes the limits of one provider. For claude-code it makes one minimal Haiku call (spends a little subscription quota); for a registered OpenAI-compatible gateway it asks GET /key/info, at most every 10 minutes. Other providers have nothing to ask: their readings arrive with each call. Returns { chamou } and the provider's limits.",
    { provider: z.string().describe("provider id, as shown by get_provider_limits") },
    async ({ provider }) => {
      const m = await import("../services/limites-padrao.js");
      const { chamou } = await m.atualizarLimites(provider);
      return { chamou, provedor: (await m.visaoDosLimites()).provedores.find((p) => p.provedor === provider) ?? null };
    });

  def(server, "set_provider_budget", "write",
    "Sets the local budget of an API provider in USD per day and per month, computed from the spend Locum records. Omit or pass 0 to remove a cap. Writes local settings only.",
    { provider: z.string(), dayUsd: z.number().min(0).optional(), monthUsd: z.number().min(0).optional() },
    async ({ provider, dayUsd, monthUsd }) => {
      const { limitesService } = await import("../services/limites-service.js");
      await limitesService.definirOrcamento(provider, { diaUsd: dayUsd, mesUsd: monthUsd });
      return visao();
    });

  def(server, "set_limits_config", "write",
    "Configures the limit protection: pause automations near a provider limit (on by default), global thresholds as fractions (windowThreshold 0.95, budgetThreshold 1), per-provider thresholds, and whether to use the registered fallback model when a provider is at its limit (off by default; even on, it only switches to an API provider that has a local budget). Manual runs are never paused. Writes local settings only.",
    {
      pauseNearLimit: z.boolean().optional(),
      windowThreshold: z.number().gt(0).max(1).optional(),
      budgetThreshold: z.number().gt(0).max(1.5).optional(),
      providerThresholds: z
        .record(z.string(), z.object({ window: z.number().gt(0).max(1).optional(), budget: z.number().gt(0).max(1.5).optional() }))
        .optional(),
      useFallbackModel: z.boolean().optional(),
      litellmProviders: z.array(z.string()).optional().describe("registered providers that are LiteLLM gateways: only these get the key/info question on refresh"),
    },
    async (a) => {
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
      return visao();
    });
}
