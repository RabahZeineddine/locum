/**
 * Expressão cron de cinco campos, no horário local da máquina.
 *
 * Escrita aqui em vez de vir de biblioteca porque o agendador só precisa de
 * duas perguntas, "a expressão é válida?" e "qual a próxima ocorrência depois
 * deste instante?", e as duas cabem em pouco código testável. Segundo, ano e
 * os atalhos `L`, `W` e `#` ficam de fora; `@daily` e parentes entram porque
 * são o que quem não lembra a ordem dos campos escreve.
 *
 * Dia do mês e dia da semana seguem a regra do cron clássico: quando os dois
 * estão restritos, basta um casar. É o que faz `0 9 1 * 1` rodar no dia 1 e
 * também em toda segunda.
 */

export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Campo de dia do mês veio diferente de `*`. */
  daysRestricted: boolean;
  /** Campo de dia da semana veio diferente de `*`. */
  weekdaysRestricted: boolean;
}

const ATALHOS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const MESES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DIAS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Lê a expressão. Lança com o campo que não fechou. */
export function parseCron(expressao: string): Cron {
  const texto = ATALHOS[expressao.trim().toLowerCase()] ?? expressao.trim();
  const campos = texto.split(/\s+/);
  if (campos.length !== 5) {
    throw new Error(`expressão cron precisa de 5 campos (minuto hora dia mês dia-da-semana), veio ${campos.length}`);
  }
  const [min, hora, dia, mes, semana] = campos as [string, string, string, string, string];

  const weekdays = campo(semana, 0, 7, "dia da semana", DIAS);
  // 7 também é domingo, como no cron do sistema.
  if (weekdays.delete(7)) weekdays.add(0);

  return {
    minutes: campo(min, 0, 59, "minuto"),
    hours: campo(hora, 0, 23, "hora"),
    days: campo(dia, 1, 31, "dia do mês"),
    months: campo(mes, 1, 12, "mês", MESES, 1),
    weekdays,
    daysRestricted: dia !== "*" && dia !== "?",
    weekdaysRestricted: semana !== "*" && semana !== "?",
  };
}

/** A expressão é aceita. Para validar formulário sem tratar exceção. */
export function cronValida(expressao: string): boolean {
  try {
    parseCron(expressao);
    return true;
  } catch {
    return false;
  }
}

/**
 * A primeira ocorrência estritamente depois de `depoisDe`, em epoch de
 * milissegundos. Nula quando não há nenhuma em cinco anos, que é o caso de
 * `0 0 31 2 *`: anda devagar por mês e por dia para não varrer minuto a minuto
 * um ano inteiro.
 */
export function proximaOcorrencia(expressao: string | Cron, depoisDe: number): number | null {
  const cron = typeof expressao === "string" ? parseCron(expressao) : expressao;
  const d = new Date(depoisDe);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limite = depoisDe + 5 * 366 * 24 * 60 * 60_000;

  while (d.getTime() <= limite) {
    if (!cron.months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!casaDia(cron, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hours.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minutes.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }
  return null;
}

function casaDia(cron: Cron, d: Date): boolean {
  const doMes = cron.days.has(d.getDate());
  const daSemana = cron.weekdays.has(d.getDay());
  if (cron.daysRestricted && cron.weekdaysRestricted) return doMes || daSemana;
  if (cron.daysRestricted) return doMes;
  if (cron.weekdaysRestricted) return daSemana;
  return true;
}

function campo(
  texto: string,
  min: number,
  max: number,
  nome: string,
  nomes?: string[],
  base = 0,
): Set<number> {
  const valores = new Set<number>();
  for (const parte of texto.split(",")) {
    const [faixa, passoTexto] = parte.split("/") as [string, string | undefined];
    const passo = passoTexto === undefined ? 1 : Number(passoTexto);
    if (!Number.isInteger(passo) || passo < 1) throw new Error(`passo inválido no campo ${nome}: "${parte}"`);

    let inicio: number;
    let fim: number;
    if (faixa === "*" || faixa === "?") {
      inicio = min;
      fim = max;
    } else if (faixa.includes("-")) {
      const [a, b] = faixa.split("-") as [string, string];
      inicio = numero(a, nome, nomes, base);
      fim = numero(b, nome, nomes, base);
    } else {
      inicio = numero(faixa, nome, nomes, base);
      // `5/15` vale de 5 até o fim, como no cron do sistema.
      fim = passoTexto === undefined ? inicio : max;
    }
    if (inicio < min || fim > max || inicio > fim) {
      throw new Error(`valor fora do intervalo ${min}-${max} no campo ${nome}: "${parte}"`);
    }
    for (let v = inicio; v <= fim; v += passo) valores.add(v);
  }
  return valores;
}

function numero(texto: string, nome: string, nomes: string[] | undefined, base: number): number {
  const porNome = nomes?.indexOf(texto.toLowerCase()) ?? -1;
  if (porNome >= 0) return porNome + base;
  const valor = Number(texto);
  if (texto === "" || !Number.isInteger(valor)) throw new Error(`valor inválido no campo ${nome}: "${texto}"`);
  return valor;
}
