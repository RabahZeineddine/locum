import { test } from "node:test";
import assert from "node:assert/strict";
import { PollFilters } from "../src/config/types.js";
import {
  listaDoTexto,
  podarFiltros,
  revisaoComoTexto,
  revisaoDoTexto,
  textoDaLista,
} from "../renderer/lib/filtros-do-gatilho.js";

test("a lista digitada separa por vírgula ou quebra de linha, e o espaço fica no nome", () => {
  assert.deepEqual(listaDoTexto("ana, bia\ncaio,,"), ["ana", "bia", "caio"]);
  assert.deepEqual(listaDoTexto("help wanted, bug\nneeds review"), ["help wanted", "bug", "needs review"]);
  assert.deepEqual(listaDoTexto("  "), []);
  assert.equal(textoDaLista(["a", "b"]), "a, b");
  assert.equal(textoDaLista(undefined), "");
});

test("o @me e o org/slug passam inteiros", () => {
  assert.deepEqual(listaDoTexto("@me, acme/backend"), ["@me", "acme/backend"]);
});

test("review pedido separa pessoa de time pela barra", () => {
  assert.deepEqual(revisaoDoTexto("@me, acme/backend, ana"), { users: ["@me", "ana"], teams: ["acme/backend"] });
  assert.equal(revisaoComoTexto({ users: ["@me"], teams: ["acme/backend"] }), "@me, acme/backend");
  assert.equal(revisaoComoTexto(undefined), "");
});

test("podar tira o que está vazio e devolve nada quando não sobra filtro", () => {
  assert.equal(podarFiltros({ authors: { include: [], exclude: [] }, labels: {}, teamMembers: [] }), undefined);
  assert.deepEqual(podarFiltros({ authors: { include: ["ana"], exclude: [] }, maxChangedLines: undefined }), {
    authors: { include: ["ana"] },
  });
  assert.deepEqual(podarFiltros({ reviewRequested: { users: [], teams: ["a/b"] } }), { reviewRequested: { teams: ["a/b"] } });
});

test("o que a tela monta passa no schema do gatilho", () => {
  const filtros = podarFiltros({
    authors: { include: ["@me"] },
    reviewRequested: { users: [], teams: ["acme/backend"] },
    paths: { include: ["src/**", "!**/*.md"] },
    maxChangedLines: 300,
  });
  assert.doesNotThrow(() => PollFilters.parse(filtros));
});
