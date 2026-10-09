import { z } from "zod";

/**
 * O relógio de horas úteis: quanto tempo de expediente passou entre dois
 * instantes. Função pura, sem relógio nem rede, para o agent nunca fazer essa
 * conta de cabeça (modelo erra fuso, fim de semana e virada de horário de
 * verão sem avisar).
 *
 * O deslocamento do fuso é calculado dia a dia pelo `Intl`, e não fixado: um
 * fuso com horário de verão tem janela de 9h local que cai em instantes UTC
 * diferentes ao longo do ano. Janela que cruza a meia-noite não é suportada.
 */

const HORA_MINUTO = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;
/** ISO 8601 com zona explícita: sem ela o instante dependeria da máquina. */
const ISO_COM_ZONA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
const TS_DO_SLACK = /^\d{9,11}(\.\d+)?$/;

const MS_POR_HORA = 3_600_000;
const MS_POR_DIA = 86_400_000;
const LIMITE_DE_ITENS = 500;

const fusoValido = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const dataReal = (s: string) => {
  if (!DATA.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
};

const minutos = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));

const HoraMinuto = z.string().regex(HORA_MINUTO, "use HH:mm, de 00:00 a 23:59");

export const WindowSchema = z
  .object({
    start: HoraMinuto,
    end: HoraMinuto,
    days: z.array(z.number().int().min(0).max(6)).min(1),
    timeZone: z.string().refine(fusoValido, "fuso desconhecido, use um nome IANA como America/Sao_Paulo"),
  })
  .refine((w) => !HORA_MINUTO.test(w.start) || !HORA_MINUTO.test(w.end) || minutos(w.start) < minutos(w.end), {
    path: ["start"],
    message: "start precisa ser antes de end: janela que cruza a meia-noite não é suportada",
  });
export type Window = z.infer<typeof WindowSchema>;

export const ThresholdsSchema = z
  .object({ p1: z.number().min(0), p0: z.number().min(0) })
  .refine((t) => t.p1 <= t.p0, { path: ["p1"], message: "p1 não pode passar de p0" });
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export const HolidaysSchema = z.array(z.string().refine(dataReal, "use uma data real no formato YYYY-MM-DD"));

export const ItemsSchema = z.array(z.object({ id: z.string(), since: z.string() })).max(LIMITE_DE_ITENS);

export const PADRAO_JANELA: Window = {
  start: "09:00",
  end: "18:00",
  days: [1, 2, 3, 4, 5],
  timeZone: "America/Sao_Paulo",
};
export const PADRAO_LIMITES: Thresholds = { p1: 4, p0: 8 };

const EntradaSchema = z.object({
  items: ItemsSchema,
  now: z.string().optional(),
  window: WindowSchema.optional(),
  thresholds: ThresholdsSchema.optional(),
  holidays: HolidaysSchema.optional(),
});

export type Faixa = "ok" | "p1" | "p0";
export type ResultadoDoItem = { id: string; hours: number; band: Faixa } | { id: string; error: string };

/** ISO 8601 com zona, ou ts do Slack em segundos epoch. Nulo quando não é nenhum. */
export function lerInstante(texto: string): number | null {
  const t = texto.trim();
  if (TS_DO_SLACK.test(t)) return Math.round(Number(t) * 1000);
  if (!ISO_COM_ZONA.test(t)) return null;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

const formatadores = new Map<string, Intl.DateTimeFormat>();

/** Relógio de parede do fuso, em ms como se fosse UTC. */
function paredeDoFuso(tz: string, ms: number): number {
  let f = formatadores.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatadores.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const parte of f.formatToParts(new Date(ms))) if (parte.type !== "literal") p[parte.type] = Number(parte.value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
}

/** O instante UTC em que o relógio do fuso marca `hm` no dia `dia` (YYYY-MM-DD). */
function instanteLocal(tz: string, dia: string, hm: string): number {
  const parede = Date.parse(`${dia}T${hm}:00Z`);
  // Duas passadas: o deslocamento medido no palpite pode ser o do outro lado
  // de uma virada de horário de verão.
  let ms = parede - (paredeDoFuso(tz, parede) - parede);
  ms = parede - (paredeDoFuso(tz, ms) - ms);
  return ms;
}

const diaLocal = (tz: string, ms: number) => new Date(paredeDoFuso(tz, ms)).toISOString().slice(0, 10);

/** Milissegundos de expediente entre `desde` e `ate`, com `desde < ate`. */
function msUteis(desde: number, ate: number, janela: Window, feriados: ReadonlySet<string>): number {
  const { timeZone: tz } = janela;
  const dias = new Set(janela.days);
  const ultimo = diaLocal(tz, ate);
  let total = 0;
  for (let ms = Date.parse(`${diaLocal(tz, desde)}T00:00:00Z`); ; ms += MS_POR_DIA) {
    const dia = new Date(ms).toISOString().slice(0, 10);
    if (dia > ultimo) break;
    if (!dias.has(new Date(ms).getUTCDay()) || feriados.has(dia)) continue;
    const abre = Math.max(desde, instanteLocal(tz, dia, janela.start));
    const fecha = Math.min(ate, instanteLocal(tz, dia, janela.end));
    if (fecha > abre) total += fecha - abre;
  }
  return total;
}

function descrever(err: z.ZodError): string {
  return `entrada invalida:\n${z.prettifyError(err)}`;
}

/**
 * Horas úteis desde `since` até `now` para cada item, e a faixa que isso dá.
 * Erro de configuração derruba o lote; item com `since` ilegível vira
 * `{id, error}` e os outros seguem.
 */
export function businessHours(entrada: unknown, agora: () => number = Date.now): { results: ResultadoDoItem[] } {
  const lido = EntradaSchema.safeParse(entrada);
  if (!lido.success) throw new Error(descrever(lido.error));
  const { items, window = PADRAO_JANELA, thresholds = PADRAO_LIMITES, holidays = [] } = lido.data;

  let now = agora();
  if (lido.data.now !== undefined) {
    const lida = lerInstante(lido.data.now);
    if (lida === null) throw new Error(`now ilegivel: "${lido.data.now}". Use ISO 8601 com zona (2026-10-08T15:00:00Z) ou ts do Slack.`);
    now = lida;
  }
  const feriados = new Set(holidays);

  const results = items.map((item): ResultadoDoItem => {
    const since = lerInstante(item.since);
    if (since === null) {
      return { id: item.id, error: `since ilegivel: "${item.since}". Use ISO 8601 com zona ou ts do Slack em segundos.` };
    }
    const ms = since >= now ? 0 : msUteis(since, now, window, feriados);
    const exato = ms / MS_POR_HORA;
    const band: Faixa = exato >= thresholds.p0 ? "p0" : exato >= thresholds.p1 ? "p1" : "ok";
    return { id: item.id, hours: Math.round(exato * 10) / 10, band };
  });
  return { results };
}
