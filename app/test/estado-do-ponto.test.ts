import { test } from "node:test";
import assert from "node:assert/strict";
import { ESTADOS } from "../renderer/lib/rotulos.js";
import { PONTOS, pontoDoEstado } from "../renderer/lib/estado-do-ponto.js";

test("cada estado de execução tem um ponto", () => {
  for (const e of ESTADOS) assert.ok(Object.hasOwn(PONTOS, e), `${e} sem entrada própria`);
});

test("concluída é ok, falha é erro, e o que espera alguém é aviso", () => {
  assert.equal(pontoDoEstado("done"), "ok");
  assert.equal(pontoDoEstado("running"), "ok");
  assert.equal(pontoDoEstado("failed"), "erro");
  assert.equal(pontoDoEstado("paused"), "aviso");
  assert.equal(pontoDoEstado("awaiting_approval"), "aviso");
  assert.equal(pontoDoEstado("queued"), "ocioso");
  assert.equal(pontoDoEstado("cancelled"), "ocioso");
});

test("nome herdado do Object não vira ponto", () => {
  assert.equal(pontoDoEstado("constructor"), "ocioso");
  assert.equal(pontoDoEstado("toString"), "ocioso");
});

test("estado desconhecido vira ocioso, sem quebrar", () => {
  assert.equal(pontoDoEstado("algo-novo"), "ocioso");
});
