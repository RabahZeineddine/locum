import { test } from "node:test";
import assert from "node:assert/strict";
import { criarPorteiroDeAvisos, estadoAoComecarLeitura, estadoAoLerDados, estadoAoFalharLeitura, type EstadoDeLeitura } from "../renderer/lib/leitura.js";

/** Releitura por invalidação troca os dados sem passar por "carregando". */

const carregando: EstadoDeLeitura<number[]> = { status: "loading", data: undefined, error: undefined };
const pronto = (data: number[]): EstadoDeLeitura<number[]> => ({ status: "ready", data, error: undefined });

test("a primeira leitura mostra carregando", () => {
  assert.equal(estadoAoComecarLeitura(carregando, true).status, "loading");
});

test("releitura por invalidação mantém os dados atuais", () => {
  const atual = pronto([1, 2]);
  assert.equal(estadoAoComecarLeitura(atual, true), atual);
});

test("argumento novo é outra leitura: volta a carregar", () => {
  assert.equal(estadoAoComecarLeitura(pronto([1]), false).status, "loading");
});

test("dado igual ao que já está na tela mantém a mesma referência", () => {
  const atual = pronto([1, 2]);
  assert.equal(estadoAoLerDados(atual, [1, 2]), atual);
  const novo = estadoAoLerDados(atual, [1, 2, 3]);
  assert.deepEqual(novo.data, [1, 2, 3]);
});

test("falha na releitura não derruba o que já estava na tela, falha na primeira vira erro", () => {
  const atual = pronto([1]);
  assert.equal(estadoAoFalharLeitura(atual, new Error("x")), atual);
  assert.equal(estadoAoFalharLeitura(carregando, new Error("x")).status, "error");
});

test("aviso com a janela escondida espera ela voltar, e só então relê uma vez", () => {
  let visivel = false;
  let leituras = 0;
  const p = criarPorteiroDeAvisos(() => visivel, () => void leituras++);
  p.avisar();
  p.avisar();
  assert.equal(leituras, 0);
  visivel = true;
  p.voltou();
  p.voltou();
  assert.equal(leituras, 1);
});

test("aviso com a janela à vista relê na hora", () => {
  let leituras = 0;
  const p = criarPorteiroDeAvisos(() => true, () => void leituras++);
  p.avisar();
  assert.equal(leituras, 1);
});
