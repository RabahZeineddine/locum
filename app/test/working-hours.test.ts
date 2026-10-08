import test from "node:test";
import assert from "node:assert/strict";
import {
  parseHoraMinuto,
  estaDentroDoHorario,
  proximoInicioDeJanela,
  ajustarPorHorario,
} from "../src/triggers/working-hours.js";
import type { WorkingHoursConfig } from "../src/config/types.js";

const configPadrao: WorkingHoursConfig = {
  enabled: true,
  start: "08:00",
  end: "20:00",
  days: [1, 2, 3, 4, 5], // Seg a Sex
  offHoursBehavior: "pause",
  slowCadenceMinutes: 60,
};

test("parseHoraMinuto converte HH:mm para minutos corretamente", () => {
  assert.equal(parseHoraMinuto("00:00"), 0);
  assert.equal(parseHoraMinuto("08:30"), 510);
  assert.equal(parseHoraMinuto("20:00"), 1200);
  assert.equal(parseHoraMinuto("23:59"), 1439);
});

test("estaDentroDoHorario: dia útil dentro da janela", () => {
  // Quarta-feira 14:30
  const d = new Date("2026-10-07T14:30:00");
  assert.equal(estaDentroDoHorario(d, configPadrao), true);
});

test("estaDentroDoHorario: dia útil fora da janela (madrugada/noite)", () => {
  // Quarta-feira 21:00
  const noite = new Date("2026-10-07T21:00:00");
  assert.equal(estaDentroDoHorario(noite, configPadrao), false);

  // Quarta-feira 05:00
  const madrugada = new Date("2026-10-07T05:00:00");
  assert.equal(estaDentroDoHorario(madrugada, configPadrao), false);
});

test("estaDentroDoHorario: final de semana", () => {
  // Sábado 14:00 (2026-10-10)
  const sabado = new Date("2026-10-10T14:00:00");
  assert.equal(sabado.getDay(), 6);
  assert.equal(estaDentroDoHorario(sabado, configPadrao), false);
});

test("proximoInicioDeJanela calcula o início do próximo dia útil", () => {
  // Quarta-feira 21:00 -> Próxima janela é Quinta 08:00
  const quartaNoite = new Date("2026-10-07T21:00:00");
  const proxima = proximoInicioDeJanela(quartaNoite, configPadrao);
  assert.equal(proxima.getHours(), 8);
  assert.equal(proxima.getMinutes(), 0);
  assert.equal(proxima.getDate(), 8); // dia 8 (quinta)

  // Sexta-feira 22:00 (2026-10-09) -> Próxima janela é Segunda 08:00 (2026-10-12)
  const sextaNoite = new Date("2026-10-09T22:00:00");
  const proximaSegunda = proximoInicioDeJanela(sextaNoite, configPadrao);
  assert.equal(proximaSegunda.getDay(), 1); // Segunda
  assert.equal(proximaSegunda.getHours(), 8);
});

test("ajustarPorHorario respeita pause e slow", () => {
  const agora = new Date("2026-10-07T21:00:00").getTime();
  const devido = agora + 3 * 60_000; // 21:03

  // Em modo pause: deve saltar para Quinta 08:00
  const ajustadoPause = ajustarPorHorario(devido, agora, agora, configPadrao);
  const dataAjustada = new Date(ajustadoPause);
  assert.equal(dataAjustada.getHours(), 8);
  assert.equal(dataAjustada.getDate(), 8);

  // Em modo slow (60 min): deve vencer em 60 min (22:00)
  const configSlow: WorkingHoursConfig = { ...configPadrao, offHoursBehavior: "slow", slowCadenceMinutes: 60 };
  const ajustadoSlow = ajustarPorHorario(devido, agora, agora, configSlow);
  assert.equal(ajustadoSlow, agora + 60 * 60_000);

  // Em modo unrestricted: vence na cadência normal de 3 min
  const configUnrestricted: WorkingHoursConfig = { ...configPadrao, offHoursBehavior: "unrestricted" };
  const ajustadoUnrestricted = ajustarPorHorario(devido, agora, agora, configUnrestricted);
  assert.equal(ajustadoUnrestricted, devido);
});
