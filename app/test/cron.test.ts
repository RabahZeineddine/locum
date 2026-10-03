import { test } from "node:test";
import assert from "node:assert/strict";
import { cronValida, parseCron, proximaOcorrencia } from "../src/triggers/cron.js";

/**
 * A expressão cron do gatilho de relógio. As datas são montadas no horário
 * local, que é o horário em que o cron da máquina pensa.
 */

const local = (ano: number, mes: number, dia: number, hora = 0, minuto = 0) =>
  new Date(ano, mes - 1, dia, hora, minuto).getTime();

test("todo dia às 9h: depois das 9h, a próxima é amanhã", () => {
  assert.equal(proximaOcorrencia("0 9 * * *", local(2026, 10, 3, 10, 0)), local(2026, 10, 4, 9, 0));
  assert.equal(proximaOcorrencia("0 9 * * *", local(2026, 10, 3, 8, 59)), local(2026, 10, 3, 9, 0));
});

test("a ocorrência é estritamente depois do instante dado", () => {
  assert.equal(proximaOcorrencia("*/15 * * * *", local(2026, 10, 3, 9, 15)), local(2026, 10, 3, 9, 30));
});

test("dia útil às 8h30 pula o fim de semana", () => {
  // 3 de outubro de 2026 é sábado.
  assert.equal(proximaOcorrencia("30 8 * * 1-5", local(2026, 10, 3, 12)), local(2026, 10, 5, 8, 30));
  assert.equal(proximaOcorrencia("30 8 * * mon-fri", local(2026, 10, 3, 12)), local(2026, 10, 5, 8, 30));
});

test("dia do mês e dia da semana juntos: basta um casar", () => {
  // Dia 1 ou segunda. Depois do sábado 3, a próxima é a segunda 5.
  assert.equal(proximaOcorrencia("0 9 1 * 1", local(2026, 10, 3, 12)), local(2026, 10, 5, 9, 0));
});

test("atalho e domingo como 7", () => {
  assert.equal(proximaOcorrencia("@daily", local(2026, 10, 3, 12)), local(2026, 10, 4, 0, 0));
  assert.equal(proximaOcorrencia("0 0 * * 7", local(2026, 10, 3, 12)), local(2026, 10, 4, 0, 0));
});

test("data que não existe não trava: devolve nulo", () => {
  assert.equal(proximaOcorrencia("0 0 31 2 *", local(2026, 10, 3)), null);
});

test("expressão inválida explica o campo", () => {
  assert.throws(() => parseCron("0 9 * *"), /5 campos/);
  assert.throws(() => parseCron("0 25 * * *"), /hora/);
  assert.throws(() => parseCron("x * * * *"), /minuto/);
  assert.equal(cronValida("*/5 9-18 * * 1-5"), true);
  assert.equal(cronValida("nada"), false);
});
