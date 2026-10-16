import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentSpec } from "../src/config/types.js";
import { migrateDb } from "../src/db/migrate.js";
import { buildMcpServer } from "../src/mcp-server/server.js";
import { AgentService } from "../src/services/agent-service.js";
import { mcpService } from "../src/services/mcp-service.js";

before(() => {
  migrateDb();
});

const spec = (id: string, tools: { server: string; tool: string }[]) =>
  AgentSpec.parse({
    id,
    name: "Revisor",
    steps: [{ type: "model", key: "ler", name: "Ler", model: "ollama/modelo", prompt: "revise", tools }],
  });

test("upsert_agent grava ferramenta nova de servidor write, como a tela", async () => {
  const escrita = `srv-${randomUUID().slice(0, 8)}`;
  await mcpService.register({ name: escrita, transport: "stdio", command: ["true"], scope: "write" });
  const agents = new AgentService();
  const id = `agente-${randomUUID()}`;

  await agents.upsert(spec(id, [{ server: escrita, tool: "comment" }]), undefined, "agent");
  const mais = await agents.upsert(spec(id, [{ server: escrita, tool: "comment" }, { server: escrita, tool: "merge" }]), undefined, "agent");
  assert.equal(mais.version, 2);
});

test("pelo MCP servidor write baixa para read, e register_mcp_server é destrutiva", async () => {
  const name = `srv-${randomUUID().slice(0, 8)}`;
  await mcpService.register({ name, transport: "stdio", command: ["true"], scope: "write" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildMcpServer().connect(serverTransport);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(clientTransport);

  const baixar = await client.callTool({ name: "register_mcp_server", arguments: { name, transport: "stdio", scope: "read" } });
  assert.notEqual(baixar.isError, true);
  assert.equal((await mcpService.get(name))?.config.scope, "read");
  const { tools } = await client.listTools();
  assert.equal(tools.find((t) => t.name === "register_mcp_server")?.annotations?.destructiveHint, true);
  await client.close();
});
