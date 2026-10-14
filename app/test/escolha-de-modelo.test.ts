import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ESCOLHA_VAZIA,
  escolhaCompleta,
  montarSubstituicoes,
  trocarProvedor,
  validarSubstituicoes,
} from "../src/config/escolha-de-modelo.js";

/** A escolha de provedor e modelo na instalação de um template: nada vem pré-selecionado. */

// Os modelos do claude-code são os de `fixedModels` em src/providers/registry.ts.
const catalogo = [
  { provedor: "claude-code", modelos: ["opus", "sonnet", "haiku"] },
  { provedor: "ollama", modelos: [], erro: "fora do ar" },
  { provedor: "openrouter", modelos: ["anthropic/claude-sonnet-4", "openai/gpt-5"] },
];

test("a escolha começa vazia e incompleta", () => {
  assert.deepEqual(ESCOLHA_VAZIA, { provedor: "", modelo: "" });
  assert.equal(escolhaCompleta(ESCOLHA_VAZIA, catalogo), false);
  assert.equal(montarSubstituicoes([1, 2], ESCOLHA_VAZIA, null, catalogo), null);
});

test("escolher o provedor deixa o modelo vazio", () => {
  const depois = trocarProvedor({ provedor: "claude-code", modelo: "opus" }, "openrouter");
  assert.deepEqual(depois, { provedor: "openrouter", modelo: "" });
  assert.equal(escolhaCompleta(depois, catalogo), false);
});

test("a escolha geral vale para todos os passos de modelo", () => {
  const geral = { provedor: "claude-code", modelo: "sonnet" };
  assert.deepEqual(montarSubstituicoes([0, 2], geral, null, catalogo), {
    0: "claude-code/sonnet",
    2: "claude-code/sonnet",
  });
});

test("por passo sobrescreve a geral, e só habilita com todos completos", () => {
  const geral = { provedor: "claude-code", modelo: "sonnet" };
  const porPasso = { 0: geral, 2: { provedor: "openrouter", modelo: "" } };
  assert.equal(montarSubstituicoes([0, 2], geral, porPasso, catalogo), null);
  porPasso[2] = { provedor: "openrouter", modelo: "anthropic/claude-sonnet-4" };
  assert.deepEqual(montarSubstituicoes([0, 2], geral, porPasso, catalogo), {
    0: "claude-code/sonnet",
    2: "openrouter/anthropic/claude-sonnet-4",
  });
});

test("provedor sem modelo listado ou modelo fora da lista não completa", () => {
  assert.equal(escolhaCompleta({ provedor: "ollama", modelo: "llama" }, catalogo), false);
  assert.equal(escolhaCompleta({ provedor: "claude-code", modelo: "gpt-5" }, catalogo), false);
});

const passos = [{ model: "claude-code/claude-sonnet-5" }, { type: "action" }];

test("valida aceitando modelo com barra depois do provedor", () => {
  validarSubstituicoes(passos, { 0: "openrouter/anthropic/claude-sonnet-4" }, catalogo);
});

test("escolha inválida dá erro claro em vez de ser descartada", () => {
  assert.throws(() => validarSubstituicoes(passos, { 0: "aihub/glm" }, catalogo), /provedor.*não está disponível/);
  assert.throws(() => validarSubstituicoes(passos, { 0: "claude-code/gpt-5" }, catalogo), /não está na lista/);
  assert.throws(() => validarSubstituicoes(passos, { 0: "semprovedor" }, catalogo), /não está disponível/);
});

test("índice inexistente ou de passo que não é de modelo é erro", () => {
  assert.throws(() => validarSubstituicoes(passos, { 5: "claude-code/opus" }, catalogo), /não tem o passo 5/);
  assert.throws(() => validarSubstituicoes(passos, { 1: "claude-code/opus" }, catalogo), /não escolhe modelo/);
  assert.throws(() => validarSubstituicoes(passos, { x: "claude-code/opus" } as never, catalogo), /não tem o passo x/);
});
