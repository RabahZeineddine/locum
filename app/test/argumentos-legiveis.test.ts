import { test } from "node:test";
import assert from "node:assert/strict";
import { argumentosLegiveis } from "../renderer/lib/argumentos-legiveis.js";

const rotulos = { nulo: "nulo", vazio: "vazio" };

test("cada chave vira uma linha com o nome em palavras", () => {
  assert.deepEqual(argumentosLegiveis({ chat_id: "19:abc", messageText: "Oi, time" }, { rotulos }), [
    { chave: "chat id", valor: "19:abc" },
    { chave: "message text", valor: "Oi, time" },
  ]);
});

test("no cartão, null, vazio, lista vazia e objeto vazio aparecem escritos", () => {
  assert.deepEqual(argumentosLegiveis({ issue: "PROJ-1", assignee: null, labels: [], body: "", extra: {} }, { rotulos }), [
    { chave: "issue", valor: "PROJ-1" },
    { chave: "assignee", valor: "nulo" },
    { chave: "labels", valor: "vazio" },
    { chave: "body", valor: "vazio" },
    { chave: "extra", valor: "vazio" },
  ]);
});

test("o null dentro de objeto aninhado também aparece", () => {
  assert.deepEqual(argumentosLegiveis({ fields: { assignee: null, labels: [] } }, { rotulos }), [
    { chave: "fields", valor: "assignee: nulo\nlabels: vazio" },
  ]);
  assert.deepEqual(argumentosLegiveis({ itens: [{ nome: "Ana", fone: null }] }, { rotulos }), [
    { chave: "itens", valor: "nome: Ana, fone: nulo" },
  ]);
});

test("string que parece número ou booleano leva aspas, e o número e o booleano de verdade não", () => {
  assert.deepEqual(argumentosLegiveis({ a: "true", b: true, c: "5", d: 5, e: "null", f: "olá", g: "5 pessoas" }, { rotulos }), [
    { chave: "a", valor: '"true"' },
    { chave: "b", valor: "true" },
    { chave: "c", valor: '"5"' },
    { chave: "d", valor: "5" },
    { chave: "e", valor: '"null"' },
    { chave: "f", valor: "olá" },
    { chave: "g", valor: "5 pessoas" },
  ]);
  assert.equal(argumentosLegiveis({ lista: ["1", 2] }, { rotulos })[0]?.valor, '"1", 2');
});

test("false e zero não somem", () => {
  assert.deepEqual(argumentosLegiveis({ urgente: false, limite: 0 }, { rotulos }), [
    { chave: "urgente", valor: "false" },
    { chave: "limite", valor: "0" },
  ]);
});

test("lista de valores simples sai separada por vírgula", () => {
  assert.deepEqual(argumentosLegiveis({ labels: ["bug", "p1"] }, { rotulos }), [{ chave: "labels", valor: "bug, p1" }]);
});

test("objeto aninhado vira linhas chave: valor, sem JSON", () => {
  const [linha] = argumentosLegiveis({ corpo: { titulo: "Falha", prioridade: 2, dono: { nome: "Ana" } } }, { rotulos });
  assert.equal(linha?.chave, "corpo");
  assert.equal(linha?.valor, "titulo: Falha\nprioridade: 2\ndono: nome: Ana");
  assert.ok(!/[{}"]/.test(linha?.valor ?? ""));
});

test("lista de objetos tem uma linha por item", () => {
  const [linha] = argumentosLegiveis({ convidados: [{ nome: "Ana", email: "a@x.com" }, { nome: "Beto" }] }, { rotulos });
  assert.equal(linha?.valor, "nome: Ana, email: a@x.com\nnome: Beto");
});

test("omitirVazios tira o vazio em qualquer nível, para o resultado da ferramenta", () => {
  assert.deepEqual(argumentosLegiveis({ ok: null, itens: [], dono: { nome: "Ana", fone: null } }, { rotulos, omitirVazios: true }), [
    { chave: "dono", valor: "nome: Ana" },
  ]);
  assert.deepEqual(argumentosLegiveis({ ok: null }, { omitirVazios: true }), []);
  assert.deepEqual(argumentosLegiveis([], { omitirVazios: true }), []);
});

test("argumento que não é objeto vira uma linha sem chave, e sem argumento não há linha", () => {
  assert.deepEqual(argumentosLegiveis("só texto", { rotulos }), [{ chave: "", valor: "só texto" }]);
  assert.deepEqual(argumentosLegiveis("", { rotulos }), [{ chave: "", valor: "vazio" }]);
  assert.deepEqual(argumentosLegiveis(null, { rotulos }), []);
  assert.deepEqual(argumentosLegiveis({}, { rotulos }), []);
});
