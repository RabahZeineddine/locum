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

test("quem não é pessoa não põe em passo ferramenta nova de servidor write, mas mantém a que já estava", async () => {
  const escrita = `srv-${randomUUID().slice(0, 8)}`;
  const leitura = `srv-${randomUUID().slice(0, 8)}`;
  await mcpService.register({ name: escrita, transport: "stdio", command: ["true"], scope: "write" });
  await mcpService.register({ name: leitura, transport: "stdio", command: ["true"] });
  const agents = new AgentService();
  const id = `agente-${randomUUID()}`;

  await assert.rejects(
    agents.upsert(spec(id, [{ server: escrita, tool: "comment" }]), undefined, "agent"),
    /escopo write/,
  );
  await agents.upsert(spec(id, [{ server: leitura, tool: "ler" }]), undefined, "agent");

  // A pessoa põe; daí em diante a edição pelo MCP pode manter a ferramenta.
  await agents.upsert(spec(id, [{ server: escrita, tool: "comment" }]), undefined, "human");
  const mantida = await agents.upsert(
    { ...spec(id, [{ server: escrita, tool: "comment" }]), name: "Revisor 2" },
    undefined,
    "agent",
  );
  assert.equal(mantida.spec.name, "Revisor 2");
  await assert.rejects(
    agents.upsert(spec(id, [{ server: escrita, tool: "comment" }, { server: escrita, tool: "merge" }]), undefined, "agent"),
    new RegExp(`${escrita}\\.merge`),
  );
});

test("pelo MCP servidor write não baixa para read", async () => {
  const name = `srv-${randomUUID().slice(0, 8)}`;
  await mcpService.register({ name, transport: "stdio", command: ["true"], scope: "write" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildMcpServer().connect(serverTransport);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(clientTransport);

  const baixar = await client.callTool({ name: "register_mcp_server", arguments: { name, transport: "stdio", scope: "read" } });
  assert.equal(baixar.isError, true);
  assert.equal((await mcpService.get(name))?.config.scope, "write");
  await client.close();
});
