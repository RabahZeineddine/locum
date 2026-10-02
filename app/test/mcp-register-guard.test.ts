import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { migrateDb } from "../src/db/migrate.js";
import { mcpService } from "../src/services/mcp-service.js";
import { buildMcpServer } from "../src/mcp-server/server.js";

before(() => {
  migrateDb();
});

async function ligarCliente(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildMcpServer().connect(serverTransport);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

const texto = (res: Awaited<ReturnType<Client["callTool"]>>): string =>
  (res.content as { type: string; text: string }[])[0]?.text ?? "";

test("servidor cadastrado pelo MCP nasce desligado e não sobe pelo teste", async () => {
  const client = await ligarCliente();
  const name = `srv-${randomUUID().slice(0, 8)}`;

  const gravado = await client.callTool({
    name: "register_mcp_server",
    arguments: { name, transport: "stdio", command: ["sh", "-c", "exit 0"] },
  });
  assert.equal(gravado.isError, undefined);
  assert.equal((JSON.parse(texto(gravado)) as { enabled: boolean }).enabled, false);
  assert.equal((await mcpService.get(name))?.enabled, false);

  const teste = await client.callTool({ name: "test_mcp_server", arguments: { name } });
  assert.equal(teste.isError, true);
  assert.match(texto(teste), /desligado/);
  const lista = await client.callTool({ name: "list_server_tools", arguments: { name } });
  assert.equal(lista.isError, true);

  const ligar = await client.callTool({ name: "register_mcp_server", arguments: { name, transport: "stdio", enabled: true } });
  assert.equal(ligar.isError, true);
  assert.equal((await mcpService.get(name))?.enabled, false);
  await client.close();
});

test("trocar o comando de um servidor que a pessoa ligou desliga de novo, e mudar só o resto não", async () => {
  const client = await ligarCliente();
  const name = `srv-${randomUUID().slice(0, 8)}`;
  await mcpService.register({ name, transport: "stdio", command: ["gh-mcp"] });
  assert.equal((await mcpService.get(name))?.enabled, true);

  await client.callTool({ name: "register_mcp_server", arguments: { name, transport: "stdio", scope: "write" } });
  assert.equal((await mcpService.get(name))?.enabled, true);

  await client.callTool({ name: "register_mcp_server", arguments: { name, transport: "stdio", command: ["outro"] } });
  assert.equal((await mcpService.get(name))?.enabled, false);
  await client.close();
});
