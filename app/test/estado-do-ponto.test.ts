import { test } from "node:test";
import assert from "node:assert/strict";
import { ESTADOS } from "../renderer/lib/rotulos.js";
import { PONTOS, pontoDaFerramenta, pontoDoEstado, pontoDoProvedor } from "../renderer/lib/estado-do-ponto.js";

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

test("provedor só é ok com modelos lidos; lendo é ocioso, erro ou lista vazia é erro", () => {
  const ligado = { available: true, disabled: false };
  assert.equal(pontoDoProvedor(ligado, { modelos: ["a"] }), "ok");
  assert.equal(pontoDoProvedor(ligado, null), "ocioso");
  assert.equal(pontoDoProvedor(ligado, { modelos: [] }), "erro");
  assert.equal(pontoDoProvedor(ligado, { modelos: [], erro: "401" }), "erro");
});

test("provedor desligado pela pessoa ou sem chave é ocioso, mesmo com modelos", () => {
  assert.equal(pontoDoProvedor({ available: false, disabled: true }, { modelos: ["a"] }), "ocioso");
  assert.equal(pontoDoProvedor({ available: true, disabled: true }, { modelos: ["a"] }), "ocioso");
  assert.equal(pontoDoProvedor({ available: false, disabled: false }, null), "ocioso");
});

test("o Locum numa ferramenta de código: ligado é ok, desatualizado é aviso, ausente é ocioso", () => {
  assert.equal(pontoDaFerramenta("connected"), "ok");
  assert.equal(pontoDaFerramenta("stale"), "aviso");
  assert.equal(pontoDaFerramenta("absent"), "ocioso");
  assert.equal(pontoDaFerramenta(null), "ocioso");
});
