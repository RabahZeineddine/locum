import { test } from "node:test";
import assert from "node:assert/strict";
import { precisaRelerEstado } from "../renderer/lib/releitura-da-conversa.js";

const parado = { ocupada: false, versao: "v1" };

test("sem marca anterior, a primeira consulta pede o estado completo", () => {
  assert.equal(precisaRelerEstado({ marca: parado, anterior: null, outroProcesso: false }), true);
});

test("a mesma marca, sem ninguém na conversa, não pede o estado completo", () => {
  assert.equal(precisaRelerEstado({ marca: parado, anterior: parado, outroProcesso: false }), false);
});

test("a versão mudou (fala nova, alvo trocado, gasto): pede o estado completo", () => {
  assert.equal(precisaRelerEstado({ marca: { ocupada: false, versao: "v2" }, anterior: parado, outroProcesso: false }), true);
});

test("a conversa passou a ficar ocupada, ou deixou de ficar: pede o estado completo", () => {
  assert.equal(precisaRelerEstado({ marca: { ocupada: true, versao: "v1" }, anterior: parado, outroProcesso: false }), true);
  assert.equal(precisaRelerEstado({ marca: parado, anterior: { ocupada: true, versao: "v1" }, outroProcesso: true }), true);
});

test("com outro processo na vez e a conversa ainda ocupada, segue lendo o estado completo", () => {
  const ocupada = { ocupada: true, versao: "v1" };
  assert.equal(precisaRelerEstado({ marca: ocupada, anterior: ocupada, outroProcesso: true }), true);
  assert.equal(precisaRelerEstado({ marca: ocupada, anterior: ocupada, outroProcesso: false }), false);
});
