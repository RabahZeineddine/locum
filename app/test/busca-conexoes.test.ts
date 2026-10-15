import { test } from "node:test";
import assert from "node:assert/strict";
import { buscarConexoes, type ItemDeBusca } from "../renderer/lib/busca-conexoes.js";

const itens: ItemDeBusca[] = [
  { id: "github", ligada: true, textos: ["GitHub", "gatilhos de pull request", "create_pull_request", "list_issues"] },
  { id: "slack", ligada: false, textos: ["Slack", "mensagens e canais"] },
  { id: "ms365", ligada: true, textos: ["ms365", "Claude Code", "send-mail"] },
  { id: "notion", ligada: false, textos: ["Notion", "páginas e bancos"] },
];

test("sem termo, devolve só as ligadas, na ordem", () => {
  assert.deepEqual(buscarConexoes(itens, "  "), { suas: ["github", "ms365"], catalogo: [] });
});

test("achar o GitHub que existe: aparece em suas, e não no catálogo", () => {
  assert.deepEqual(buscarConexoes(itens, "github"), { suas: ["github"], catalogo: [] });
});

test("o que não está ligado aparece no catálogo, para adicionar", () => {
  assert.deepEqual(buscarConexoes(itens, "slack"), { suas: [], catalogo: ["slack"] });
});

test("casa por origem e por ferramenta conhecida, sem ligar para caixa nem acento", () => {
  assert.deepEqual(buscarConexoes(itens, "CLAUDE").suas, ["ms365"]);
  assert.deepEqual(buscarConexoes(itens, "create_pull").suas, ["github"]);
  assert.deepEqual(buscarConexoes(itens, "paginas").catalogo, ["notion"]);
});

test("várias palavras precisam casar todas, cada uma em qualquer campo", () => {
  assert.deepEqual(buscarConexoes(itens, "github mail").suas, []);
  assert.deepEqual(buscarConexoes(itens, "github list_issues").suas, ["github"]);
});

test("sem resultado, as duas listas vêm vazias", () => {
  assert.deepEqual(buscarConexoes(itens, "zzz"), { suas: [], catalogo: [] });
});
