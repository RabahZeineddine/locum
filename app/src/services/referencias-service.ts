import type { AgentSpec, TriggerConfig } from "../config/types.js";
import { catalogoDeReferencias, saidasDosRuns, type EsquemaJson, type GrupoDeReferencias } from "../config/referencias.js";
import { esquemaDaLogica } from "../executor/esquemas-de-logica.js";
import { esquemaDoEvento } from "../sources/esquemas-de-evento.js";
import { mcpService } from "./mcp-service.js";
import { runService } from "./run-service.js";

/**
 * O catálogo de `{{...}}` de cada passo de um fluxo, o mesmo que a tela monta
 * para o autocomplete: o que o evento dos gatilhos traz e a saída de cada passo
 * anterior, pelos esquemas que cada fonte declara.
 */
export async function referenciasDoFluxo(entrada: {
  spec: AgentSpec;
  triggers: readonly TriggerConfig[];
  /** Com a automação gravada, as saídas do último run entram junto. */
  agentId?: string;
}): Promise<Record<string, GrupoDeReferencias[]>> {
  const { buildGate } = await import("../executor/build.js");
  const acoes = new Map(buildGate().describe().map((a) => [a.kind, a.outputSchema]));

  const ferramentas = new Map<string, EsquemaJson>();
  const servidores = new Set<string>();
  for (const p of entrada.spec.steps) {
    const params = p.type === "action" ? ((p.params ?? {}) as { server?: unknown }) : {};
    if (typeof params.server === "string") servidores.add(params.server);
  }
  for (const servidor of servidores) {
    for (const f of (await mcpService.cachedTools(servidor))?.tools ?? []) {
      if (f.outputSchema !== undefined) ferramentas.set(`${servidor}/${f.name}`, f.outputSchema as EsquemaJson);
    }
  }

  let saidas: Record<string, unknown> = {};
  if (entrada.agentId !== undefined) {
    const runs = await runService.list({ agentId: entrada.agentId, limit: 3 });
    const detalhes = await Promise.all(runs.map((r) => runService.get(r.id)));
    saidas = saidasDosRuns(detalhes.filter((d) => d !== undefined));
  }

  const eventos = entrada.triggers.map((t) => ({ fonte: t.kind, esquema: esquemaDoEvento(t) }));
  return Object.fromEntries(
    entrada.spec.steps.map((p) => [
      p.key,
      catalogoDeReferencias({
        passos: entrada.spec.steps,
        chave: p.key,
        eventos,
        saidas,
        fontes: { acao: (kind) => acoes.get(kind), ferramenta: (s, t) => ferramentas.get(`${s}/${t}`), logica: esquemaDaLogica },
      }),
    ]),
  );
}
