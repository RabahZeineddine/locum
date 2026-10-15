import { test } from "node:test";
import assert from "node:assert/strict";
import { agruparPorOrigem, origemLegivel, pareceProducao } from "../renderer/lib/importacao-origem.js";

test("a origem de plugin vira o nome do plugin, sem o marketplace", () => {
  assert.deepEqual(origemLegivel("akad@akad"), { tipo: "plugin", nome: "akad" });
  assert.deepEqual(origemLegivel("usuário"), { tipo: "usuario", nome: "usuário" });
  assert.deepEqual(origemLegivel("Cursor"), { tipo: "ferramenta", nome: "Cursor" });
});

test("nome ou endereço com prod ou production parece produção", () => {
  assert.equal(pareceProducao({ name: "grafana-prod", destino: "https://g.example.com/mcp" }), true);
  assert.equal(pareceProducao({ name: "db", destino: "https://production.example.com/mcp" }), true);
  assert.equal(pareceProducao({ name: "api", destino: "npx x --host prod.db.internal" }), true);
  assert.equal(pareceProducao({ name: "product-docs", destino: "https://docs.example.com" }), false);
  assert.equal(pareceProducao({ name: "github", destino: "https://api.githubcopilot.com/mcp/" }), false);
});

test("agrupa por origem na ordem em que aparecem", () => {
  const grupos = agruparPorOrigem([
    { name: "a", origem: "akad@akad" },
    { name: "b", origem: "usuário" },
    { name: "c", origem: "akad@akad" },
  ]);
  assert.deepEqual(
    grupos.map((g) => [g.origem, g.itens.map((i) => i.name)]),
    [
      ["akad@akad", ["a", "c"]],
      ["usuário", ["b"]],
    ],
  );
});
