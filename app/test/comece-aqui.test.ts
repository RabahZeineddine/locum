import { test } from "node:test";
import assert from "node:assert/strict";
import { passosDoComeco, type ConexaoParaOPasso } from "../renderer/lib/comece-aqui.js";

const conexao = (extra: Partial<ConexaoParaOPasso>): ConexaoParaOPasso => ({
  id: "github",
  state: "connected",
  reason: null,
  custom: false,
  ...extra,
});

const feitos = (entrada: Partial<Parameters<typeof passosDoComeco>[0]> = {}) =>
  passosDoComeco({ modelo: true, conexoes: [], agents: 0, gatilho: false, ...entrada })
    .filter((p) => p.feito)
    .map((p) => p.id);

test("os passos vêm na ordem: modelo, conexão, agent, automação", () => {
  assert.deepEqual(
    passosDoComeco({ modelo: false, conexoes: [], agents: 0, gatilho: false }).map((p) => p.id),
    ["model", "connection", "agent", "trigger"],
  );
});

test("perfil sem conexão real não marca 'conectar'", () => {
  assert.deepEqual(feitos({ conexoes: [] }), ["model"]);
});

test("o servidor interno do Locum não conta como conexão", () => {
  assert.deepEqual(feitos({ conexoes: [conexao({ id: "locum-ferramentas", custom: true, reason: "untested" })] }), ["model"]);
});

test("servidor importado desligado ou ainda sem teste não conta", () => {
  assert.deepEqual(feitos({ conexoes: [conexao({ id: "ms365", custom: true, state: "off", reason: "disabled" })] }), ["model"]);
  assert.deepEqual(feitos({ conexoes: [conexao({ id: "ms365", custom: true, reason: "untested" })] }), ["model"]);
});

test("conexão autorizada ou servidor testado conta", () => {
  assert.deepEqual(feitos({ conexoes: [conexao({ id: "notion", reason: "untested" })] }), ["model", "connection"]);
  assert.deepEqual(feitos({ conexoes: [conexao({ id: "ms365", custom: true })] }), ["model", "connection"]);
});

test("agent criado marca o passo do agent", () => {
  assert.deepEqual(feitos({ agents: 1 }), ["model", "agent"]);
});
