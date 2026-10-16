import type { TFunction } from "i18next";

/** Hora do dia quando o reset é hoje; senão dia e mês. */
export function quandoReseta(resetaEmS: number, idioma: string, agoraMs: number = Date.now()): string {
  const data = new Date(resetaEmS * 1000);
  const hoje = new Date(agoraMs);
  const mesmoDia = data.getFullYear() === hoje.getFullYear() && data.getMonth() === hoje.getMonth() && data.getDate() === hoje.getDate();
  return mesmoDia
    ? data.toLocaleTimeString(idioma, { hour: "2-digit", minute: "2-digit" })
    : data.toLocaleDateString(idioma, { day: "2-digit", month: "2-digit" });
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
