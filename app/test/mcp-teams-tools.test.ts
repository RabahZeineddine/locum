import { before, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { migrateDb } from "../src/db/migrate.js";
import { buildMcpServer } from "../src/mcp-server/server.js";

before(() => migrateDb());

async function notas() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildMcpServer().connect(serverTransport);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(clientTransport);
  return (await client.listTools()).tools;
}

test("o Teams pelo MCP: ler é leitura, importar o servidor liga e fala com fora", async () => {
  const tools = await notas();
  const nota = (n: string) => tools.find((t) => t.name === n)?.annotations;
  assert.equal(nota("get_teams_mcp")?.readOnlyHint, true);
  assert.equal(nota("use_claude_teams_server")?.readOnlyHint, false);
  assert.equal(nota("use_claude_teams_server")?.destructiveHint, true);
  assert.equal(nota("use_claude_teams_server")?.openWorldHint, true);
});

test("os limites seguem o padrão de anotação: ler é leitura, atualizar fala com fora, configurar grava", async () => {
  const tools = await notas();
  const nota = (n: string) => tools.find((t) => t.name === n)?.annotations;
  assert.equal(nota("get_provider_limits")?.readOnlyHint, true);
  assert.equal(nota("refresh_provider_limits")?.openWorldHint, true);
  assert.equal(nota("refresh_provider_limits")?.readOnlyHint, false);
  for (const n of ["set_provider_budget", "set_limits_config"]) {
    assert.equal(nota(n)?.readOnlyHint, false, n);
    assert.equal(nota(n)?.openWorldHint, false, n);
  }
});
