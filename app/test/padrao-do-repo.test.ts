import { test } from "node:test";
import assert from "node:assert/strict";
import { nomeDoPadrao, padraoDoRepo } from "../renderer/lib/padrao-do-repo.js";

test("nome solto vira o repositório exato", () => {
  assert.equal(padraoDoRepo(" meu-servico "), "^meu-servico$");
  assert.equal(padraoDoRepo("site.io"), "^site\\.io$");
});

test("asterisco vira qualquer coisa, e vírgula junta nomes", () => {
  assert.equal(padraoDoRepo("api-*"), "^api-.*$");
  assert.equal(padraoDoRepo("api-*, portal"), "^(api-.*|portal)$");
});

test("expressão regular passa sem mudança", () => {
  assert.equal(padraoDoRepo("^locum-smoke-1a2b$"), "^locum-smoke-1a2b$");
  assert.equal(padraoDoRepo("^(a|b)"), "^(a|b)");
});

test("o padrão gerado volta para o que a pessoa escreveu", () => {
  for (const texto of ["meu-servico", "api-*", "api-*, portal", "site.io"]) {
    assert.equal(nomeDoPadrao(padraoDoRepo(texto)), texto);
  }
});

test("expressão escrita à mão aparece como foi escrita", () => {
  assert.equal(nomeDoPadrao("^api-"), "^api-");
  assert.equal(nomeDoPadrao("^(a|b+)$"), "^(a|b+)$");
});
