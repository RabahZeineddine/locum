import { test } from "node:test";
import assert from "node:assert/strict";
import { passosDoComeco, type ConexaoParaOPasso } from "../renderer/lib/comece-aqui.js";

const conexao = (extra: Partial<ConexaoParaOPasso>): ConexaoParaOPasso => ({
  id: "github",
  state: "connected",
  reason: null,
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
  assert.deepEqual(feitos({ conexoes: [conexao({ id: "locum-ferramentas", reason: "untested" })] }), ["model"]);
});

test("servidor importado desligado ou ainda sem teste não conta", () => {
  assert.deepEqual(feitos({ conexoes: [conexao({ id: "ms365", state: "off", reason: "disabled" })] }), ["model"]);
  assert.deepEqual(feitos({ conexoes: [conexao({ id: "ms365", reason: "untested" })] }), ["model"]);
  // ms365 importado vira o item "teams" do catálogo: o estado decide, e não o custom.
  assert.deepEqual(feitos({ conexoes: [conexao({ id: "teams", reason: "untested" })] }), ["model"]);
});

test("conexão autorizada ou servidor testado conta", () => {
  assert.deepEqual(feitos({ conexoes: [conexao({ id: "notion" })] }), ["model", "connection"]);
  assert.deepEqual(feitos({ conexoes: [conexao({ id: "teams" })] }), ["model", "connection"]);
});

test("agent criado marca o passo do agent", () => {
  assert.deepEqual(feitos({ agents: 1 }), ["model", "agent"]);
});

test("automação criada e desligada: o último passo é ligar, não criar", () => {
  const base = { modelo: true, conexoes: [], agents: 1 };
  assert.equal(passosDoComeco({ ...base, gatilho: false, temGatilho: true }).at(-1)?.id, "enable");
  assert.equal(passosDoComeco({ ...base, gatilho: false, temGatilho: false }).at(-1)?.id, "trigger");
  assert.deepEqual(passosDoComeco({ ...base, gatilho: true, temGatilho: true }).at(-1), { id: "trigger", feito: true });
});
