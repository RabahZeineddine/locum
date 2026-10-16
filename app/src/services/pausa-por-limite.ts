import { AgentSpec } from "../config/types.js";
import type { AgentVersion } from "./agent-service.js";
import type { Bloqueio, LimitesService } from "./limites-service.js";

type Fallbacks = { fromModel: string; toModel: string; order: number }[];

export interface DependenciasDaPausa {
  limites: Pick<LimitesService, "decidir">;
  versao: (agentId: string) => Promise<AgentVersion | undefined>;
  fallbacks: () => Promise<Fallbacks>;
  disponivel: (provedor: string) => boolean;
  /** O modelo do agent da biblioteca que um passo usa, quando o passo aponta um. */
  modeloDoPerfil?: (perfil: string) => Promise<string | undefined>;
}

/** Os modelos que o agent pode pedir: um por passo de modelo, ou o do perfil que o passo usa. */
export async function modelosDoAgent(spec: AgentSpec, perfil?: DependenciasDaPausa["modeloDoPerfil"]): Promise<string[]> {
  const modelos = new Set<string>();
  for (const passo of spec.steps) {
    if (passo.type !== "model") continue;
    let modelo: string | undefined = passo.model;
    if (passo.profile !== undefined && perfil !== undefined) modelo = (await perfil(passo.profile).catch(() => undefined)) ?? modelo;
    if (modelo !== undefined && modelo.includes("/")) modelos.add(modelo);
  }
  return [...modelos];
}

/**
 * Se uma execução automática deste agent deve esperar: algum modelo dele cai
 * num provedor no limite e não há substituto livre na cadeia de
 * `model_fallbacks`. Com substituto, o executor o usa e isto devolve nulo.
 */
export async function pausaDoAgent(agentId: string, deps: DependenciasDaPausa, agoraMs?: number): Promise<Bloqueio | null> {
  const versao = await deps.versao(agentId);
  if (versao === undefined) return null;
  const fallbacks = await deps.fallbacks();
  let pior: Bloqueio | null = null;
  for (const modelo of await modelosDoAgent(versao.spec, deps.modeloDoPerfil)) {
    const d = await deps.limites.decidir(modelo, { fallbacks, disponivel: deps.disponivel }, agoraMs);
    if (d.tipo === "pausa" && (pior === null || d.bloqueio.ate > pior.ate)) pior = d.bloqueio;
  }
  return pior;
}
