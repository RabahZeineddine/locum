import type { WorkingHoursConfig } from "../config/types.js";

/** Converte "HH:mm" em minutos desde a meia-noite (0..1439). */
export function parseHoraMinuto(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Verifica se um instante está dentro da janela de horário ativo. */
export function estaDentroDoHorario(date: Date, config: WorkingHoursConfig): boolean {
  if (!config.enabled || config.offHoursBehavior === "unrestricted") return true;

  const diaDaSemana = date.getDay(); // 0 = Domingo, 1 = Segunda, ...
  if (!config.days.includes(diaDaSemana)) return false;

  const minutosAtuais = date.getHours() * 60 + date.getMinutes();
  const inicio = parseHoraMinuto(config.start);
  const fim = parseHoraMinuto(config.end);

  if (inicio < fim) {
    // Ex: 08:00 até 20:00
    return minutosAtuais >= inicio && minutosAtuais < fim;
  }
  // Ex: 22:00 até 06:00 (cruza meia-noite)
  return minutosAtuais >= inicio || minutosAtuais < fim;
}

/** Encontra o início exato da próxima janela de trabalho a partir de uma data. */
export function proximoInicioDeJanela(from: Date, config: WorkingHoursConfig): Date {
  const inicioMinutos = parseHoraMinuto(config.start);
  const inicioHora = Math.floor(inicioMinutos / 60);
  const inicioMin = inicioMinutos % 60;

  // Busca no dia atual ou nos próximos até 14 dias
  for (let offset = 0; offset <= 14; offset++) {
    const candidata = new Date(from);
    candidata.setDate(from.getDate() + offset);
    candidata.setHours(inicioHora, inicioMin, 0, 0);

    const diaSemana = candidata.getDay();
    if (config.days.includes(diaSemana) && candidata.getTime() > from.getTime()) {
      return candidata;
    }
  }

  // Fallback seguro: 24h depois
  return new Date(from.getTime() + 24 * 3600 * 1000);
}

/**
 * Ajusta um instante de vencimento calculado respeitando as regras de horário ativo.
 * 
 * @param devidoMs Instante em que o gatilho naturalmente venceria
 * @param lastFireAt Última batida executada ou null
 * @param at Instante de referência da batida (Date.now())
 * @param config Configuração de working hours (se ativa)
 */
export function ajustarPorHorario(
  devidoMs: number,
  lastFireAt: number | null,
  at: number,
  config?: WorkingHoursConfig,
): number {
  if (!config || !config.enabled || config.offHoursBehavior === "unrestricted") {
    return devidoMs;
  }

  const dataDevida = new Date(devidoMs);
  if (estaDentroDoHorario(dataDevida, config)) {
    return devidoMs;
  }

  // Fora do horário ativo:
  if (config.offHoursBehavior === "pause") {
    // Salta diretamente para o início da próxima janela ativa
    return proximoInicioDeJanela(dataDevida, config).getTime();
  }

  if (config.offHoursBehavior === "slow") {
    // Cadência reduzida fora do horário
    const cadenciaMs = (config.slowCadenceMinutes ?? 60) * 60_000;
    const proximaLenta = lastFireAt === null ? at : lastFireAt + cadenciaMs;

    // Não deixa a cadência lenta passar do início da próxima janela normal
    const proximaJanelaNormal = proximoInicioDeJanela(new Date(at), config).getTime();
    return Math.min(Math.max(proximaLenta, at), proximaJanelaNormal);
  }

  return devidoMs;
}
