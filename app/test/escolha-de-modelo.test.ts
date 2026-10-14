import { test } from "node:test";
import assert from "node:assert/strict";
import { modeloInicial, partirModelo } from "../src/config/escolha-de-modelo.js";

/** O default da escolha de modelo na instalação de um template. */

const catalogo = [
  { provedor: "claude-code", modelos: ["claude-sonnet-5", "claude-opus-5"] },
  { provedor: "ollama", modelos: [], erro: "fora do ar" },
  { provedor: "openai", modelos: ["gpt-5"] },
];

test("mantém o modelo do template quando o provedor existe na máquina", () => {
  assert.equal(modeloInicial("claude-code/claude-opus-5", catalogo), "claude-code/claude-opus-5");
});

test("provedor presente mas sem o modelo: primeiro modelo do mesmo provedor", () => {
  assert.equal(modeloInicial("openai/gpt-4", catalogo), "openai/gpt-5");
});

test("provedor ausente: primeiro provedor e modelo disponíveis", () => {
  assert.equal(modeloInicial("aihub/glm-5.3-flash", catalogo), "claude-code/claude-sonnet-5");
});

test("provedor sem modelo listado não conta como disponível", () => {
  assert.equal(modeloInicial("ollama/llama", catalogo), "claude-code/claude-sonnet-5");
});

test("sem provedor nenhum não há default", () => {
  assert.equal(modeloInicial("claude-code/claude-sonnet-5", []), null);
});

test("parte provedor e modelo no primeiro barra", () => {
  assert.deepEqual(partirModelo("openai/ft:gpt/x"), { provedor: "openai", modelo: "ft:gpt/x" });
});
