import { test } from "node:test";
import assert from "node:assert/strict";
import { argumentosLegiveis } from "../renderer/lib/argumentos-legiveis.js";

test("cada chave vira uma linha com o nome em palavras", () => {
  assert.deepEqual(argumentosLegiveis({ chat_id: "19:abc", messageText: "Oi, time" }), [
    { chave: "chat id", valor: "19:abc" },
    { chave: "message text", valor: "Oi, time" },
  ]);
});

test("número e booleano saem como texto, e vazio e nulo não ocupam linha", () => {
  assert.deepEqual(argumentosLegiveis({ limite: 5, urgente: false, nada: null, solto: undefined, vazio: "" }), [
    { chave: "limite", valor: "5" },
    { chave: "urgente", valor: "false" },
  ]);
});

test("lista de valores simples sai separada por vírgula", () => {
  assert.deepEqual(argumentosLegiveis({ labels: ["bug", "p1"] }), [{ chave: "labels", valor: "bug, p1" }]);
});

test("objeto aninhado vira linhas chave: valor, sem JSON", () => {
  const [linha] = argumentosLegiveis({ corpo: { titulo: "Falha", prioridade: 2, dono: { nome: "Ana" } } });
  assert.equal(linha?.chave, "corpo");
  assert.equal(linha?.valor, "titulo: Falha\nprioridade: 2\ndono: nome: Ana");
  assert.ok(!/[{}"]/.test(linha?.valor ?? ""));
});

test("lista de objetos tem uma linha por item", () => {
  const [linha] = argumentosLegiveis({ convidados: [{ nome: "Ana", email: "a@x.com" }, { nome: "Beto" }] });
  assert.equal(linha?.valor, "nome: Ana, email: a@x.com\nnome: Beto");
});

test("argumento que não é objeto vira uma linha sem chave", () => {
  assert.deepEqual(argumentosLegiveis("só texto"), [{ chave: "", valor: "só texto" }]);
  assert.deepEqual(argumentosLegiveis(null), []);
  assert.deepEqual(argumentosLegiveis({}), []);
});
