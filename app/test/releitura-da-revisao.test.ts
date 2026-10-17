import { test } from "node:test";
import assert from "node:assert/strict";
import { acaoDaReleitura, devoGravar } from "../renderer/lib/releitura-da-revisao.js";

test("releitura com o mesmo payload não mexe em nada", () => {
  assert.equal(acaoDaReleitura({ hashBase: "a", hashAtual: "a", edicaoPendente: false }), "manter");
  assert.equal(acaoDaReleitura({ hashBase: "a", hashAtual: "a", edicaoPendente: true }), "manter");
});

test("payload diferente e nada editado aqui: recarrega o estado local", () => {
  assert.equal(acaoDaReleitura({ hashBase: "a", hashAtual: "b", edicaoPendente: false }), "recarregar");
});

test("payload diferente com edição local pendente: avisa e não grava por cima", () => {
  assert.equal(acaoDaReleitura({ hashBase: "a", hashAtual: "b", edicaoPendente: true }), "avisar");
});

test("releitura atrasada de um conteúdo que esta janela já conheceu (antes da própria gravação) não conta como mudança de fora", () => {
  assert.equal(acaoDaReleitura({ hashBase: "b", hashAtual: "a", edicaoPendente: false, conhecidos: ["a", "b"] }), "manter");
  assert.equal(acaoDaReleitura({ hashBase: "b", hashAtual: "c", edicaoPendente: false, conhecidos: ["a", "b"] }), "recarregar");
});

test("sem base ainda (estado local não carregado), a releitura não decide nada", () => {
  assert.equal(acaoDaReleitura({ hashBase: null, hashAtual: "b", edicaoPendente: false }), "manter");
});

test("o autosave só grava depois de uma interação da pessoa, e nunca com o aviso à vista", () => {
  assert.equal(devoGravar({ edicaoPendente: false, avisando: false }), false);
  assert.equal(devoGravar({ edicaoPendente: true, avisando: false }), true);
  assert.equal(devoGravar({ edicaoPendente: true, avisando: true }), false);
});
