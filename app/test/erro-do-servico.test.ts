import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { traduzirErroDoServico } from "../renderer/lib/erro-do-servico.js";
import { CODIGOS_DE_ERRO, erroComCodigo, lerErroComCodigo } from "../src/services/erro-com-codigo.js";

const t = (chave: string, v?: Record<string, unknown>) => `${chave}|${String(v?.argumento ?? "")}`;

test("a mensagem com código vira a chave de tradução, mesmo com o prefixo do Electron na frente", () => {
  const erro = erroComCodigo("run_nao_encontrado", "abc-1", "run abc-1 nao encontrado");
  assert.deepEqual(lerErroComCodigo(erro.message), { codigo: "run_nao_encontrado", argumento: "abc-1" });
  assert.equal(traduzirErroDoServico(t, erro.message), "erroDoServico.run_nao_encontrado|abc-1");
  assert.equal(traduzirErroDoServico(t, `Error: ${erro.message}`), "erroDoServico.run_nao_encontrado|abc-1");
  assert.equal(traduzirErroDoServico(t, erro.message, (_, v) => v.toUpperCase()), "erroDoServico.run_nao_encontrado|ABC-1");
});

test("mensagem sem código, ou com código desconhecido, passa como veio", () => {
  assert.equal(traduzirErroDoServico(t, "o disco encheu"), "o disco encheu");
  assert.equal(traduzirErroDoServico(t, "inventado:x: oi"), "inventado:x: oi");
});

test("todo código tem tradução em pt-BR e en", () => {
  for (const idioma of ["pt-BR", "en"]) {
    const chaves = (JSON.parse(readFileSync(new URL(`../locales/${idioma}.json`, import.meta.url), "utf8")) as { erroDoServico?: Record<string, string> }).erroDoServico ?? {};
    for (const codigo of CODIGOS_DE_ERRO) assert.ok(chaves[codigo], `${idioma}: falta erroDoServico.${codigo}`);
  }
});

test("o argumento com espaço, dois-pontos e símbolos vai e volta inteiro", () => {
  const cheio = "passo: a/b c (ç) 100% & x=1; \"y\"";
  const erro = erroComCodigo("derivacao_invalida", cheio, `derivaDe "${cheio}" nao e um passo`);
  assert.deepEqual(lerErroComCodigo(erro.message), { codigo: "derivacao_invalida", argumento: cheio });
  assert.equal(traduzirErroDoServico(t, erro.message), `erroDoServico.derivacao_invalida|${cheio}`);
  // Sem símbolo nenhum, a mensagem segue legível como antes.
  assert.match(erroComCodigo("run_nao_encontrado", "abc-1", "x").message, /^run_nao_encontrado:abc-1: /);
});
