import type { LimiteLido } from "./limites-lidos.js";

/** "6m0s", "1.5s", "20ms", "2h" ou segundos puros, como a OpenAI e os gateways mandam. */
export function duracaoEmSegundos(texto: string): number | null {
  const limpo = texto.trim();
  if (/^\d+(\.\d+)?$/.test(limpo)) return Number(limpo);
  const partes = [...limpo.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (partes.length === 0 || partes.map((p) => p[0]).join("") !== limpo) return null;
  const peso = { h: 3600, m: 60, s: 1, ms: 0.001 } as const;
  return partes.reduce((soma, p) => soma + Number(p[1]) * peso[p[2] as keyof typeof peso], 0);
}

function inteiro(v: string | undefined): number | null {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function taxa(chave: "rpm" | "tpm", unidade: "req" | "tokens", teto: number | null, restante: number | null, resetaEm: number | undefined): LimiteLido | null {
  if (teto === null || restante === null || teto <= 0) return null;
  const usado = Math.max(0, teto - restante);
  return { chave, tipo: "taxa", uso: Math.min(1, usado / teto), usado, teto, unidade, ...(resetaEm === undefined ? {} : { resetaEm }), origem: "cabecalho-api" };
}

/**
 * Os cabeçalhos de rate limit da resposta: `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`
 * (OpenAI e gateways compatíveis) e `anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset}`.
 * Resposta sem eles não gera limite nenhum, e valor ilegível é ignorado.
 */
export function lerCabecalhosDeTaxa(cabecalhos: Record<string, string | undefined> | undefined, agoraMs: number = Date.now()): LimiteLido[] {
  if (cabecalhos === undefined) return [];
  const h: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(cabecalhos)) h[k.toLowerCase()] = v;
  const reset = (v: string | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const dur = duracaoEmSegundos(v);
    if (dur !== null) return Math.ceil(agoraMs / 1000 + dur);
    const data = Date.parse(v);
    return Number.isNaN(data) ? undefined : Math.ceil(data / 1000);
  };
  const saida: (LimiteLido | null)[] = [];
  for (const [chave, unidade, ent] of [["rpm", "req", "requests"], ["tpm", "tokens", "tokens"]] as const) {
    const openai = taxa(chave, unidade, inteiro(h[`x-ratelimit-limit-${ent}`]), inteiro(h[`x-ratelimit-remaining-${ent}`]), reset(h[`x-ratelimit-reset-${ent}`]));
    const anthropic = taxa(chave, unidade, inteiro(h[`anthropic-ratelimit-${ent}-limit`]), inteiro(h[`anthropic-ratelimit-${ent}-remaining`]), reset(h[`anthropic-ratelimit-${ent}-reset`]));
    saida.push(openai ?? anthropic);
  }
  return saida.filter((l): l is LimiteLido => l !== null);
}
