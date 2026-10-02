import { generateText } from "ai";
import { buildProviders } from "../src/providers/registry.js";
import { ClaudeCodeRuntime } from "../src/runtimes/claude-code.js";
import { CODEX_DEFAULT_MODEL, CodexRuntime } from "../src/runtimes/codex.js";
import { AgentBuilder, type CatalogoDoCriador, type Gerador } from "../src/services/agent-builder.js";
import { agentService } from "../src/services/agent-service.js";
import { mcpService } from "../src/services/mcp-service.js";
import { providerService } from "../src/services/provider-service.js";
import { settingsService } from "../src/services/settings-service.js";
import { trackerService } from "../src/services/tracker-service.js";
import { prReviewSpec, slackDigestSpec, slackReplySpec, teamsReplySpec } from "../src/examples/agents.js";
import { CHAVE_DO_MODELO } from "./chat.js";
import { t } from "./i18n.js";

/**
 * Quem escreve o rascunho, nesta ordem: a assinatura do Claude Code, o plano
 * do Codex, que também não cobram por chamada, e depois o modelo escolhido
 * para o assistente.
 *
 * Aqui a assinatura serve, ao contrário do assistente: o rascunho é uma
 * resposta só, e esperar por ela inteira é o que a tela já faz.
 */
async function gerador(): Promise<Gerador | null> {
  if (providerService.isAvailable("claude-code")) {
    const runtime = new ClaudeCodeRuntime(new Map());
    return {
      modelo: "claude-code/sonnet",
      gerar: async (sistema, pedido) =>
        (await runtime.run({ provider: "claude-code", model: "sonnet", system: sistema, prompt: pedido, tools: {}, maxSteps: 1 })).text,
    };
  }

  if (providerService.isAvailable("codex")) {
    const runtime = new CodexRuntime(new Map());
    return {
      modelo: `codex/${CODEX_DEFAULT_MODEL}`,
      gerar: async (sistema, pedido) =>
        (
          await runtime.run({
            provider: "codex",
            model: CODEX_DEFAULT_MODEL,
            system: sistema,
            prompt: pedido,
            tools: {},
            maxSteps: 1,
          })
        ).text,
    };
  }

  const guardado = await settingsService.get(CHAVE_DO_MODELO);
  const corte = guardado?.indexOf("/") ?? -1;
  if (guardado === undefined || guardado === null || corte < 1) return null;
  const entry = buildProviders()[guardado.slice(0, corte)];
  if (!entry?.model || !entry.available()) return null;
  const modelo = entry.model(guardado.slice(corte + 1));
  return {
    modelo: guardado,
    gerar: async (sistema, pedido) => (await generateText({ model: modelo, system: sistema, prompt: pedido })).text,
  };
}

/**
 * O catálogo desta máquina. Servidor que não responde fica de fora em vez de
 * derrubar o rascunho: o agent montado sem ele ainda serve, e um com ele
 * quebraria na primeira execução do mesmo jeito.
 */
async function catalogo(): Promise<CatalogoDoCriador> {
  const [modelos, servidores, trackers] = await Promise.all([
    providerService.listAllModels({ assinatura: true }),
    mcpService.list(),
    trackerService.list(),
  ]);
  const ferramentas = await Promise.allSettled(
    servidores.map(async (s) => ({ nome: s.config.name, ferramentas: await mcpService.listTools(s.config.name) })),
  );
  return {
    modelos: modelos.map((m) => ({ provedor: m.provedor, modelos: m.modelos })),
    servidores: ferramentas
      .filter((r) => r.status === "fulfilled")
      .map((r) => ({
        nome: r.value.nome,
        ferramentas: r.value.ferramentas.map((f) => ({ nome: f.name, descricao: f.description })),
      })),
    trackers: trackers.filter((tr) => tr.enabled).map((tr) => ({ id: tr.id, rotulo: tr.label })),
    exemplos: [prReviewSpec, slackReplySpec, teamsReplySpec, slackDigestSpec],
  };
}

export const agentBuilder = new AgentBuilder({
  gerador,
  catalogo,
  existentes: async () => (await agentService.list()).map((a) => a.id),
  idioma: () => t("agents.ai.language"),
});

/** Há quem escreva o rascunho? A tela esconde o botão quando não há. */
export async function criadorDisponivel(): Promise<{ disponivel: boolean; modelo: string | null }> {
  const g = await gerador();
  return { disponivel: g !== null, modelo: g?.modelo ?? null };
}
