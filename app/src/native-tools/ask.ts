import { recordSpend } from "../executor/budget.js";
import type { McpRegistry } from "../mcp/registry.js";
import { resolveModel } from "../providers/registry.js";
import type { Runtime } from "../runtimes/types.js";
import { SUBSCRIPTION_RUNTIMES } from "../runtimes/types.js";
import { libraryService, type LibraryService } from "../services/library-service.js";
import { machineId } from "../services/machine-service.js";
import { providerService } from "../services/provider-service.js";

/** Nome do servidor das ferramentas nativas, como os passos o referenciam. */
export const SERVIDOR_NATIVO = "locum-ferramentas";

export interface ConsultaDeps {
  library?: Pick<LibraryService, "resolveProfile">;
  build: () => Promise<{ mcp: Pick<McpRegistry, "toolsFor">; runtimes: Map<string, Runtime> }>;
  fallbacks?: () => Promise<Parameters<typeof resolveModel>[1]>;
  spend?: typeof recordSpend;
}

export interface Resposta {
  agent: string;
  version: number;
  answer: string;
  costUsd: number;
  tokens: number;
}

/**
 * Um agent pergunta a outro da biblioteca, como ferramenta.
 *
 * O consultado roda com as ferramentas dele, menos esta: consulta não
 * encadeia, então um agent que pergunta a outro que pergunta ao primeiro não
 * vira laço. O gasto entra no dia com o nome do agent da biblioteca, para
 * aparecer nas métricas mesmo fora de um run.
 */
export async function consultarAgent(id: string, pergunta: string, deps: ConsultaDeps): Promise<Resposta> {
  if (pergunta.trim() === "") throw new Error("diga o que perguntar ao agent");
  const perfil = await (deps.library ?? libraryService).resolveProfile(id);
  const spec = perfil.version.spec;

  const fallbacks = deps.fallbacks ? await deps.fallbacks() : await providerService.getFallbacks(machineId);
  const { mcp, runtimes } = await deps.build();
  const resolucao = resolveModel(spec.model, fallbacks);
  const runtime = runtimes.get(SUBSCRIPTION_RUNTIMES.has(resolucao.provider) ? resolucao.provider : "native");
  if (runtime === undefined) throw new Error(`runtime indisponível para "${resolucao.provider}"`);

  const refs = perfil.tools.filter((t) => !(t.server === SERVIDOR_NATIVO && t.tool === "ask_agent"));
  const { tools, release } = await mcp.toolsFor(refs);
  try {
    const resultado = await runtime.run({
      provider: resolucao.provider,
      model: resolucao.model,
      system: perfil.system.length > 0 ? perfil.system : undefined,
      prompt: pergunta,
      tools,
      mcpServers: [...new Set(refs.map((t) => t.server))],
      maxSteps: spec.maxSteps,
      ...(spec.temperature === undefined ? {} : { temperature: spec.temperature }),
    });
    const tokens = resultado.promptTokens + resultado.completionTokens;
    await (deps.spend ?? recordSpend)(`biblioteca:${spec.id}`, { usd: resultado.costUsd, tokens }, true);
    return { agent: spec.id, version: perfil.version.version, answer: resultado.text, costUsd: resultado.costUsd, tokens };
  } finally {
    release();
  }
}
