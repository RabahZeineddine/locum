import type { LimiteLido } from "./limites-lidos.js";

/**
 * Os limites da assinatura do Claude Code, lidos do que o `claude -p` já diz.
 *
 * O `--output-format stream-json --verbose` emite uma linha `rate_limit_event`
 * em toda chamada por assinatura. Só `type`, `status`, `resetsAt` e
 * `utilization` estão no SDK; `rateLimitType` e `unifiedWindows` não são
 * documentados e podem mudar. Por isso nada aqui é obrigatório: o que não
 * bate com o esperado é ignorado, sem erro, e o resto da chamada segue.
 */

export type StatusDoLimite = "allowed" | "allowed_warning" | "rejected";

/** Uso de 0 a 1 e o reset em epoch de milissegundos, ou nulo quando não veio. */
export interface JanelaLida {
  uso: number;
  resetaEm: number | null;
}

export interface LeituraDeLimite {
  status?: StatusDoLimite;
  cincoHoras?: JanelaLida;
  semanal?: JanelaLida;
  /** Quando o bloqueio acaba, se o Claude Code disse. Só vem com `rejected`. */
  bloqueioAte?: number;
}

const STATUS: readonly string[] = ["allowed", "allowed_warning", "rejected"];

function numero(valor: unknown): number | null {
  return typeof valor === "number" && Number.isFinite(valor) ? valor : null;
}

function objeto(valor: unknown): Record<string, unknown> | null {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor) ? (valor as Record<string, unknown>) : null;
}

/** O Claude Code manda segundos; quem mandou milissegundos não é multiplicado de novo. */
function emMilissegundos(valor: unknown): number | null {
  const n = numero(valor);
  if (n === null || n <= 0) return null;
  return n >= 1e12 ? n : n * 1000;
}

function janela(uso: unknown, reset: unknown): JanelaLida | null {
  const u = numero(uso);
  if (u === null) return null;
  return { uso: Math.min(1, Math.max(0, u)), resetaEm: emMilissegundos(reset) };
}

/** Lê o objeto de um `rate_limit_event`. Nulo quando não sobra nada aproveitável. */
function lerEvento(info: Record<string, unknown>): LeituraDeLimite | null {
  const leitura: LeituraDeLimite = {};
  if (typeof info.status === "string" && STATUS.includes(info.status)) leitura.status = info.status as StatusDoLimite;

  const unidas = objeto(info.unifiedWindows);
  const cinco = janela(objeto(unidas?.five_hour)?.utilization, objeto(unidas?.five_hour)?.resetsAt);
  const semana = janela(objeto(unidas?.seven_day)?.utilization, objeto(unidas?.seven_day)?.resetsAt);
  if (cinco !== null) leitura.cincoHoras = cinco;
  if (semana !== null) leitura.semanal = semana;

  // Sem as janelas unificadas, o evento documentado fala de uma janela só, a de `rateLimitType`.
  const tipo = info.rateLimitType;
  const daqui = janela(info.utilization, info.resetsAt);
  if (daqui !== null) {
    if (tipo === "five_hour" && leitura.cincoHoras === undefined) leitura.cincoHoras = daqui;
    if (tipo === "seven_day" && leitura.semanal === undefined) leitura.semanal = daqui;
  }

  if (leitura.status === "rejected") {
    const ate = emMilissegundos(info.resetsAt);
    if (ate !== null) leitura.bloqueioAte = ate;
  }
  return Object.keys(leitura).length === 0 ? null : leitura;
}

const MESES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A hora de "resets 3:45pm" (ou "resets Oct 20, 3pm"), no relógio da máquina:
 * a próxima vez que ela acontece depois de `agora`. Nulo quando não dá para ler.
 */
function resetDoTexto(texto: string, agora: number): number | null {
  const m = /resets?\s+(?:(?:on\s+)?([a-z]{3})[a-z]*\s+(\d{1,2})\s*(?:,|at)?\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(texto);
  if (m === null) return null;
  let hora = Number(m[3]) % 12;
  if (m[5]!.toLowerCase() === "pm") hora += 12;
  const minuto = Number(m[4] ?? 0);
  if (minuto > 59 || Number(m[3]) > 12) return null;
  const base = new Date(agora);
  const mes = m[1] === undefined ? -1 : MESES.indexOf(m[1].toLowerCase());
  if (m[1] !== undefined && mes < 0) return null;
  const alvo = new Date(base);
  if (mes >= 0) {
    alvo.setMonth(mes, Number(m[2]));
    alvo.setHours(hora, minuto, 0, 0);
    if (alvo.getTime() <= agora) alvo.setFullYear(alvo.getFullYear() + 1);
  } else {
    alvo.setHours(hora, minuto, 0, 0);
    if (alvo.getTime() <= agora) alvo.setDate(alvo.getDate() + 1);
  }
  return alvo.getTime();
}

/** A mensagem que o Claude Code devolve quando a cota acabou, em vez do evento. */
function lerMensagemDeLimite(texto: string, agora: number): LeituraDeLimite | null {
  const antigo = /usage limit reached\|(\d{9,13})/i.exec(texto);
  if (antigo !== null) return { status: "rejected", bloqueioAte: emMilissegundos(Number(antigo[1]))! };
  if (!/(hit|reached) your (?:[\w-]+\s+){0,3}limit/i.test(texto) && !/usage limit reached/i.test(texto)) return null;

  const reset = resetDoTexto(texto, agora);
  const leitura: LeituraDeLimite = { status: "rejected" };
  const semanal = /week|7[- ]?day/i.test(texto);
  const janelaCheia: JanelaLida = { uso: 1, resetaEm: reset };
  if (semanal) leitura.semanal = janelaCheia;
  else if (/session|5[- ]?hour|five[- ]hour/i.test(texto)) leitura.cincoHoras = janelaCheia;
  if (reset !== null) leitura.bloqueioAte = reset;
  return leitura;
}

/**
 * Uma linha do stream do Claude Code: o evento de limite, ou o resultado de
 * erro que diz que a cota acabou. Qualquer outra coisa devolve nulo.
 */
export function lerLinhaDeLimite(linha: string, agora: number = Date.now()): LeituraDeLimite | null {
  if (linha.trim() === "") return null;
  let bruto: unknown;
  try {
    bruto = JSON.parse(linha);
  } catch {
    return null;
  }
  const dado = objeto(bruto);
  if (dado === null) return null;
  if (dado.type === "rate_limit_event") {
    const info = objeto(dado.rate_limit_info);
    return info === null ? null : lerEvento(info);
  }
  if (dado.type === "result" && dado.is_error === true && typeof dado.result === "string") {
    return lerMensagemDeLimite(dado.result, agora);
  }
  return null;
}

/** O texto solto de um erro (a saída de erro do processo, por exemplo) que diz que a cota acabou. */
export function lerTextoDeLimite(texto: string, agora: number = Date.now()): LeituraDeLimite | null {
  return lerMensagemDeLimite(texto, agora);
}

/**
 * A leitura do Claude Code no modelo único. `rejected` sem janela vira uma
 * janela de 5 horas cheia, com o reset que o evento deu ou, na falta dele,
 * meia hora adiante: sem prazo nenhum a pausa nunca soltaria.
 */
export function limitesDaLeitura(leitura: LeituraDeLimite, agora: number = Date.now()): LimiteLido[] {
  const saida: LimiteLido[] = [];
  const janela = (chave: string, j: JanelaLida): LimiteLido => ({
    chave,
    tipo: "janela",
    uso: j.uso,
    unidade: "%",
    ...(j.resetaEm === null ? {} : { resetaEm: Math.floor(j.resetaEm / 1000) }),
    origem: "assinatura",
  });
  if (leitura.cincoHoras !== undefined) saida.push(janela("5h", leitura.cincoHoras));
  if (leitura.semanal !== undefined) saida.push(janela("semana", leitura.semanal));
  if (leitura.status === "rejected") {
    const ate = Math.floor((leitura.bloqueioAte ?? agora + 30 * 60_000) / 1000);
    // A janela que o bloqueio aponta está cheia; sem pista, é a de 5 horas.
    const cheia = saida.some((l) => l.uso >= 0.999);
    const alvo = saida.find((l) => l.resetaEm === ate) ?? saida.find((l) => l.chave === "5h") ?? null;
    if (!cheia && alvo !== null) alvo.uso = 1;
    if (!cheia && alvo === null) saida.push(janela("5h", { uso: 1, resetaEm: ate * 1000 }));
    for (const l of saida) if (l.uso >= 0.999 && l.resetaEm === undefined) l.resetaEm = ate;
  }
  return saida;
}
