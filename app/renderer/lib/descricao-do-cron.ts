import { parseCron, type Cron } from "../../src/triggers/cron";

/**
 * A expressão cron dita em frase: "Toda segunda às 07:30", "Dias úteis às
 * 09:00", "A cada 15 min". Cobre o que se escreve na prática; o que foge disso
 * volta nulo e a tela mostra só a expressão, que nunca mente.
 *
 * Recebe `t` em vez de importar o i18n para ficar testável sem a tela.
 */

type Traduzir = (chave: string, valores?: Record<string, unknown>) => string;

const BASE = "automations.triggers.cron.describe";

export function descreverCron(expressao: string, t: Traduzir, idioma: string): string | null {
  let cron: Cron;
  try {
    cron = parseCron(expressao);
  } catch {
    return null;
  }
  const quando = parteDoDia(cron, t, idioma);
  const hora = parteDaHora(cron, t, idioma);
  if (quando === null || hora === null) return null;
  // "Às 08:00" sozinho soa incompleto; horário fixo sem restrição de dia é todo dia.
  const diario = quando === "" && cron.minutes.size === 1 && cron.hours.size < 24;
  const frase = diario ? `${t(`${BASE}.daily`)} ${hora}` : quando === "" ? hora : `${quando} ${hora}`;
  return frase.charAt(0).toUpperCase() + frase.slice(1);
}

function parteDoDia(cron: Cron, t: Traduzir, idioma: string): string | null {
  let dias: string;
  if (cron.daysRestricted && cron.weekdaysRestricted) return null;
  if (cron.daysRestricted) {
    dias = t(`${BASE}.monthDays`, { days: lista([...cron.days].sort((a, b) => a - b).map(String), idioma) });
  } else if (!cron.weekdaysRestricted || cron.weekdays.size === 7) {
    dias = "";
  } else {
    const semana = [...cron.weekdays].sort((a, b) => a - b);
    if (iguais(semana, [1, 2, 3, 4, 5])) dias = t(`${BASE}.weekdays`);
    else if (iguais(semana, [0, 6])) dias = t(`${BASE}.weekend`);
    else if (semana.length === 1) dias = t(`${BASE}.every.${semana[0]}`);
    else dias = lista(semana.map((d) => t(`${BASE}.days.${d}`)), idioma);
  }
  if (cron.months.size === 12) return dias;
  const meses = lista(
    [...cron.months]
      .sort((a, b) => a - b)
      .map((m) => new Date(2024, m - 1, 1).toLocaleString(idioma, { month: "short" }).replace(".", "")),
    idioma,
  );
  return dias === "" ? t(`${BASE}.months`, { months: meses }) : `${dias}, ${t(`${BASE}.months`, { months: meses })}`;
}

function parteDaHora(cron: Cron, t: Traduzir, idioma: string): string | null {
  const minutos = [...cron.minutes].sort((a, b) => a - b);
  const horas = [...cron.hours].sort((a, b) => a - b);
  const todasAsHoras = horas.length === 24;

  if (minutos.length === 1) {
    if (todasAsHoras) {
      return minutos[0] === 0 ? t(`${BASE}.hourly`) : t(`${BASE}.hourlyAt`, { minute: minutos[0] });
    }
    if (horas.length > 6) return null;
    const horarios = horas.map((h) => relogio(h, minutos[0]!, idioma));
    return t(`${BASE}.at`, { times: lista(horarios, idioma) });
  }

  const passo = passoRegular(minutos);
  if (passo === null) return null;
  const cada = t(`${BASE}.everyMinutes`, { minutes: passo });
  if (todasAsHoras) return cada;
  if (!contiguas(horas)) return null;
  return t(`${BASE}.between`, {
    every: cada,
    from: relogio(horas[0]!, 0, idioma),
    to: relogio(horas[horas.length - 1]!, 59, idioma),
  });
}

/** `0,15,30,45` é a cada 15; o passo precisa fechar a hora certinho. */
function passoRegular(minutos: number[]): number | null {
  if (minutos[0] !== 0 || minutos.length < 2) return null;
  const passo = minutos[1]!;
  if (60 % passo !== 0 || minutos.length !== 60 / passo) return null;
  return minutos.every((m, i) => m === i * passo) ? passo : null;
}

function contiguas(horas: number[]): boolean {
  return horas.every((h, i) => i === 0 || h === horas[i - 1]! + 1);
}

function relogio(hora: number, minuto: number, idioma: string): string {
  return new Date(2024, 0, 1, hora, minuto).toLocaleTimeString(idioma, { hour: "2-digit", minute: "2-digit" });
}

function lista(itens: string[], idioma: string): string {
  return new Intl.ListFormat(idioma, { style: "long", type: "conjunction" }).format(itens);
}

function iguais(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
