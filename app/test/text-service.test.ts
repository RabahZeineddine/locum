import { test } from "node:test";
import assert from "node:assert/strict";
import { translate } from "../src/services/text-service.js";

test("chave de initiatives.contextTemplate resolve nos dois idiomas", () => {
  for (const idioma of ["en", "pt-BR"] as const) {
    const texto = translate(idioma, "initiatives.contextTemplate.initial", { title: "Minha frente" });
    assert.ok(texto.includes("Minha frente"));
    assert.notEqual(texto, "initiatives.contextTemplate.initial");
  }
});

test("interpolacao troca {{title}} pelo valor", () => {
  const texto = translate("en", "initiatives.contextTemplate.initial", { title: "X" });
  assert.ok(texto.startsWith("# X"));
});

test("os dois idiomas nao se misturam", () => {
  const en = translate("en", "initiatives.contextTemplate.initial", { title: "T" });
  const ptBR = translate("pt-BR", "initiatives.contextTemplate.initial", { title: "T" });
  assert.ok(en.includes("Objective"));
  assert.ok(!en.includes("Objetivo"));
  assert.ok(ptBR.includes("Objetivo"));
  assert.ok(!ptBR.includes("Done criteria"));
});

test("chave ausente estoura, em vez de devolver a propria chave", () => {
  assert.throws(() => translate("en", "initiatives.contextTemplate.naoExiste"));
});
