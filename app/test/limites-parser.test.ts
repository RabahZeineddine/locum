import { test } from "node:test";
import assert from "node:assert/strict";
import { lerLinhaDeLimite } from "../src/runtimes/claude-limites.js";

/** A linha como o Claude Code 2.1.301 emite em toda chamada por assinatura. */
const LINHA_REAL =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1792118400,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.89,"resetsAt":1792118400},"seven_day":{"utilization":0.15,"resetsAt":1792645200}}}}';

const AGORA = Date.UTC(2026, 9, 15, 12, 0, 0);

test("a linha real vira as duas janelas, com o reset em milissegundos", () => {
  assert.deepEqual(lerLinhaDeLimite(LINHA_REAL, AGORA), {
    status: "allowed",
    cincoHoras: { uso: 0.89, resetaEm: 1792118400_000 },
    semanal: { uso: 0.15, resetaEm: 1792645200_000 },
  });
});

test("só o que o SDK documenta: a janela vem de rateLimitType, utilization e resetsAt", () => {
  const linha = JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed_warning", resetsAt: 1792118400, rateLimitType: "seven_day", utilization: 0.82 },
  });
  assert.deepEqual(lerLinhaDeLimite(linha, AGORA), {
    status: "allowed_warning",
    semanal: { uso: 0.82, resetaEm: 1792118400_000 },
  });
});

test("rejected sem janela guarda o reset do evento como bloqueio", () => {
  const linha = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1792118400 } });
  assert.deepEqual(lerLinhaDeLimite(linha, AGORA), { status: "rejected", bloqueioAte: 1792118400_000 });
});

test("campo faltando: lê o que dá e ignora o resto", () => {
  const sem = (info: unknown) => lerLinhaDeLimite(JSON.stringify({ type: "rate_limit_event", rate_limit_info: info }), AGORA);
  assert.deepEqual(sem({ status: "allowed" }), { status: "allowed" });
  assert.deepEqual(sem({ unifiedWindows: { five_hour: { utilization: 0.4 } } }), { cincoHoras: { uso: 0.4, resetaEm: null } });
  assert.deepEqual(sem({ unifiedWindows: { five_hour: { resetsAt: 1792118400 } } }), null);
  assert.equal(sem({}), null);
});

test("utilization fora de 0..1 é cortada, e reset em milissegundos não é multiplicado", () => {
  const linha = JSON.stringify({
    type: "rate_limit_event",
    rate_limit_info: { unifiedWindows: { five_hour: { utilization: 1.7, resetsAt: 1792118400_000 }, seven_day: { utilization: -2, resetsAt: 1792645200 } } },
  });
  assert.deepEqual(lerLinhaDeLimite(linha, AGORA), {
    cincoHoras: { uso: 1, resetaEm: 1792118400_000 },
    semanal: { uso: 0, resetaEm: 1792645200_000 },
  });
});

test("formato estranho é ignorado sem erro", () => {
  const casos = [
    "",
    "isto não é json",
    "null",
    "[]",
    '{"type":"rate_limit_event"}',
    '{"type":"rate_limit_event","rate_limit_info":"x"}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":42,"unifiedWindows":[1,2]}}',
    '{"type":"rate_limit_event","rate_limit_info":{"status":"talvez","unifiedWindows":{"five_hour":{"utilization":"muito","resetsAt":"ontem"}}}}',
    '{"type":"assistant","message":{"content":[]}}',
  ];
  for (const caso of casos) assert.equal(lerLinhaDeLimite(caso, AGORA), null, caso);
});

test("a mensagem de limite atingido vira rejected, com a janela e o reset do relógio", () => {
  const resultado = JSON.stringify({ type: "result", is_error: true, result: "You've hit your session limit · resets 3:45pm" });
  const leitura = lerLinhaDeLimite(resultado, AGORA);
  assert.equal(leitura?.status, "rejected");
  assert.equal(leitura?.cincoHoras?.uso, 1);
  const reset = leitura?.cincoHoras?.resetaEm ?? 0;
  assert.ok(reset > AGORA && reset <= AGORA + 24 * 3600_000);
  const data = new Date(reset);
  assert.equal(data.getHours(), 15);
  assert.equal(data.getMinutes(), 45);
  assert.equal(leitura?.bloqueioAte, reset);
});

test("o limite semanal e o formato antigo com epoch também são reconhecidos", () => {
  const semanal = lerLinhaDeLimite(
    JSON.stringify({ type: "result", is_error: true, result: "You've hit your weekly limit · resets 9am" }),
    AGORA,
  );
  assert.equal(semanal?.status, "rejected");
  assert.equal(semanal?.semanal?.uso, 1);
  assert.equal(semanal?.cincoHoras, undefined);

  const antigo = lerLinhaDeLimite(
    JSON.stringify({ type: "result", is_error: true, result: "Claude AI usage limit reached|1792118400" }),
    AGORA,
  );
  assert.deepEqual(antigo, { status: "rejected", bloqueioAte: 1792118400_000 });
});

test("limite sem hora legível ainda é rejected, e erro comum não é", () => {
  const semHora = lerLinhaDeLimite(JSON.stringify({ type: "result", is_error: true, result: "You've hit your session limit" }), AGORA);
  assert.equal(semHora?.status, "rejected");
  assert.equal(semHora?.bloqueioAte, undefined);

  const outro = JSON.stringify({ type: "result", is_error: true, result: "API Error: 500 internal server error" });
  assert.equal(lerLinhaDeLimite(outro, AGORA), null);
  // resposta do modelo que só cita a frase não é erro de limite
  const citacao = JSON.stringify({ type: "result", is_error: false, result: "You've hit your session limit · resets 3pm" });
  assert.equal(lerLinhaDeLimite(citacao, AGORA), null);
});

import { limitesDaLeitura } from "../src/runtimes/claude-limites.js";

test("no modelo único a linha real vira as janelas 5h e semana, origem assinatura, reset em segundos", () => {
  const leitura = lerLinhaDeLimite(LINHA_REAL, AGORA)!;
  assert.deepEqual(limitesDaLeitura(leitura, AGORA), [
    { chave: "5h", tipo: "janela", uso: 0.89, unidade: "%", resetaEm: 1792118400, origem: "assinatura" },
    { chave: "semana", tipo: "janela", uso: 0.15, unidade: "%", resetaEm: 1792645200, origem: "assinatura" },
  ]);
});

test("rejected sem janela vira a de 5h cheia, com o reset do bloqueio ou meia hora de prazo", () => {
  const com = limitesDaLeitura({ status: "rejected", bloqueioAte: 1792118400_000 }, AGORA);
  assert.deepEqual(com.map((l) => [l.chave, l.uso, l.resetaEm]), [["5h", 1, 1792118400]]);
  const sem = limitesDaLeitura({ status: "rejected" }, AGORA);
  assert.equal(sem[0]!.resetaEm, Math.floor((AGORA + 30 * 60_000) / 1000));
  assert.deepEqual(limitesDaLeitura({ status: "allowed" }, AGORA), []);
});
