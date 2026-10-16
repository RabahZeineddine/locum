import type { LimiteLido } from "./limites-lidos.js";

function numero(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function objeto(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 300 min é a janela de 5 horas, 10080 a semanal; outra duração vira "<n>min". */
function chaveDaJanela(minutos: number | null, indice: "primary" | "secondary"): string {
  if (minutos === null) return indice === "primary" ? "5h" : "semana";
  if (minutos === 300) return "5h";
  if (minutos === 10080) return "semana";
  return `${Math.round(minutos)}min`;
}

/**
 * O `rate_limits` que o Codex põe nos eventos: `primary` e `secondary`, cada um
 * com `used_percent` (0 a 100), `window_minutes` e o reset em `resets_at`
 * (epoch) ou `resets_in_seconds`. Formato conhecido de versões recentes, e não
 * documentado: tudo é opcional e o que não bate é ignorado.
 */
export function lerRateLimitsDoCodex(bruto: unknown, agoraMs: number = Date.now()): LimiteLido[] {
  const limites = objeto(bruto);
  if (limites === null) return [];
  const saida: LimiteLido[] = [];
  for (const indice of ["primary", "secondary"] as const) {
    const j = objeto(limites[indice]);
    const pct = numero(j?.used_percent);
    if (j === null || pct === null) continue;
    const emSegundos = numero(j.resets_in_seconds);
    const em = numero(j.resets_at);
    const resetaEm = em !== null && em > 0 ? Math.floor(em >= 1e12 ? em / 1000 : em) : emSegundos !== null ? Math.floor(agoraMs / 1000 + emSegundos) : undefined;
    saida.push({
      chave: chaveDaJanela(numero(j.window_minutes), indice),
      tipo: "janela",
      uso: Math.min(1, Math.max(0, pct / 100)),
      unidade: "%",
      ...(resetaEm === undefined ? {} : { resetaEm }),
      origem: "assinatura",
    });
  }
  return saida;
}

/** Procura `rate_limits` no evento e nos envelopes em que o Codex costuma embrulhá-lo. */
export function limitesDoEventoDoCodex(evento: unknown, agoraMs: number = Date.now()): LimiteLido[] {
  const e = objeto(evento);
  if (e === null) return [];
  for (const raiz of [e, objeto(e.msg), objeto(e.payload), objeto(e.info), objeto(e.usage)]) {
    if (raiz?.rate_limits !== undefined) return lerRateLimitsDoCodex(raiz.rate_limits, agoraMs);
  }
  return [];
}
