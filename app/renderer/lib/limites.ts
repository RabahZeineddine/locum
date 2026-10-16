import type { TFunction } from "i18next";

/**
 * Quando o limite volta. Janela curta (a de 5h) diz quanto falta e a hora:
 * "em 42 min · 23:10", "em 3h12 · 02:13". Mais longe, dia e hora: "sex 16/10 02:13".
 */
export function quandoReseta(t: TFunction, resetaEmS: number, idioma: string, agoraMs: number = Date.now()): string {
  const ms = resetaEmS * 1000;
  const min = Math.max(0, Math.ceil((ms - agoraMs) / 60_000));
  if (min >= 24 * 60) return quandoSolta(ms, idioma, agoraMs);
  const hora = horaDoDia(ms, idioma);
  // Retrato um pouco velho, com o reset já passado: "em 0 min" soaria parado.
  if (min === 0) return t("limits.justNow");
  if (min < 60) return t("limits.inMinutes", { count: min, time: hora });
  const h = Math.floor(min / 60);
  const resto = min % 60;
  return t("limits.inHours", { hours: h, minutes: String(resto).padStart(2, "0"), time: hora });
}

export function horaDoDia(ms: number, idioma: string): string {
  return new Date(ms).toLocaleTimeString(idioma, { hour: "2-digit", minute: "2-digit" });
}

/** "agora", "há 5 min", "há 3 h", "há 2 d". */
export function haQuantoTempo(t: TFunction, quandoS: number, agoraMs: number = Date.now()): string {
  const min = Math.max(0, Math.floor((agoraMs / 1000 - quandoS) / 60));
  if (min < 1) return t("limits.justNow");
  if (min < 60) return t("limits.minutesAgo", { count: min });
  if (min < 24 * 60) return t("limits.hoursAgo", { count: Math.floor(min / 60) });
  return t("limits.daysAgo", { count: Math.floor(min / 1440) });
}

export function percentual(uso: number): string {
  return `${Math.round(uso * 100)}%`;
}

const PIOR: Record<"ok" | "aviso" | "erro", number> = { ok: 0, aviso: 1, erro: 2 };

export function piorEstado<T extends { estado: "ok" | "aviso" | "erro" }>(limites: T[]): "ok" | "aviso" | "erro" {
  return limites.reduce<"ok" | "aviso" | "erro">((pior, l) => (PIOR[l.estado] > PIOR[pior] ? l.estado : pior), "ok");
}

/** "14:00" quando é hoje; "qui 22/10 14:00" quando não. */
export function quandoSolta(ms: number, idioma: string, agoraMs: number = Date.now()): string {
  const data = new Date(ms);
  const hora = horaDoDia(ms, idioma);
  if (data.toDateString() === new Date(agoraMs).toDateString()) return hora;
  const dia = data.toLocaleDateString(idioma, { weekday: "short", day: "2-digit", month: "2-digit" }).replace(".", "");
  return `${dia} ${hora}`;
}
