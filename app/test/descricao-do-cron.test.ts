import { test } from "node:test";
import assert from "node:assert/strict";
import { criarI18n } from "../renderer/lib/i18n.js";
import { descreverCron } from "../renderer/lib/descricao-do-cron.js";

/** A frase que acompanha a expressão cron na tela. */

const pt = criarI18n({ idioma: "pt-BR", estrito: true });
const en = criarI18n({ idioma: "en", estrito: true });
const frase = (expressao: string) => descreverCron(expressao, pt.t.bind(pt), "pt-BR");

test("os horários de sempre viram frase", () => {
  assert.equal(frase("30 7 * * 1"), "Toda segunda às 07:30");
  assert.equal(frase("0 9 * * 1-5"), "Dias úteis às 09:00");
  assert.equal(frase("0 8 * * *"), "Todo dia às 08:00");
  assert.equal(frase("0 9 * * 6,0"), "Sábados e domingos às 09:00");
  assert.equal(frase("0 9,14 * * 1,3,5"), "Segunda, quarta e sexta às 09:00 e 14:00");
  assert.equal(frase("0 9 1 * *"), "Todo dia 1 do mês às 09:00");
  assert.equal(frase("@hourly"), "A cada hora");
  assert.equal(frase("*/15 * * * *"), "A cada 15 min");
  assert.equal(frase("*/30 9-18 * * 1-5"), "Dias úteis a cada 30 min, entre 09:00 e 18:59");
});

test("o que não cabe numa frase fica só com a expressão", () => {
  assert.equal(frase("0 9 1 * 1"), null, "dia do mês e da semana juntos");
  assert.equal(frase("5,17,40 * * * *"), null);
  assert.equal(frase("isso não é cron"), null);
});

test("em inglês também", () => {
  assert.equal(descreverCron("30 7 * * 1", en.t.bind(en), "en-US"), "Every Monday at 07:30 AM");
});
