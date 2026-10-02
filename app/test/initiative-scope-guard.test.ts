import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentSpec } from "../src/config/types.js";
import { migrateDb } from "../src/db/migrate.js";
import { buildMcpServer } from "../src/mcp-server/server.js";
import { AgentService } from "../src/services/agent-service.js";
import { InitiativeService } from "../src/services/initiative-service.js";
import { McpService } from "../src/services/mcp-service.js";

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

/** Uma iniciativa com srv-a e um agent sem servidor obrigatório, ainda solto. */
async function montar() {
  const mcp = new McpService();
  for (const name of ["srv-a", "srv-b"]) {
    if (!(await mcp.get(name))) await mcp.register({ name, transport: "stdio", command: ["true"] });
  }
  const initiatives = new InitiativeService();
  const slug = `frente-${randomUUID()}`;
  const outra = `frente-${randomUUID()}`;
  for (const s of [slug, outra]) {
    await initiatives.upsert({ slug: s, title: "T", objective: "o", doneCriteria: "d" });
    await initiatives.setServers(s, ["srv-a"]);
  }
  const agentId = `agente-${randomUUID()}`;
  await new AgentService().upsert(
    AgentSpec.parse({
      id: agentId,
      name: "Da frente",
      steps: [{ type: "model", key: "ler", name: "Ler", model: "ollama/modelo", prompt: "revise" }],
    }),
    undefined,
    "human",
  );
  return { initiatives, slug, outra, agentId };
}

test("pelo MCP o agent entra numa iniciativa, mas não sai nem muda de iniciativa", async () => {
  const { initiatives, slug, outra, agentId } = await montar();
  const client = await ligarCliente();

  const entrar = await client.callTool({ name: "link_agent_to_initiative", arguments: { agentId, slug } });
  assert.equal(entrar.isError, undefined);

  const sair = await client.callTool({ name: "link_agent_to_initiative", arguments: { agentId, slug: null } });
  assert.equal(sair.isError, true);
  assert.match(texto(sair), /decisão de uma pessoa/);

  const mudar = await client.callTool({ name: "link_agent_to_initiative", arguments: { agentId, slug: outra } });
  assert.equal(mudar.isError, true);

  // Na tela, que é a pessoa, as duas coisas continuam valendo.
  await initiatives.linkAgent(agentId, outra);
  await initiatives.linkAgent(agentId, null);
  await client.close();
});

test("pelo MCP a iniciativa com agent ligado só perde servidor, e a sem agent monta a lista à vontade", async () => {
  const { initiatives, slug, outra, agentId } = await montar();
  await initiatives.linkAgent(agentId, slug);
  const client = await ligarCliente();

  const incluir = await client.callTool({ name: "set_initiative_servers", arguments: { slug, names: ["srv-a", "srv-b"] } });
  assert.equal(incluir.isError, true);
  assert.match(texto(incluir), /srv-b/);

  const tirar = await client.callTool({ name: "set_initiative_servers", arguments: { slug, names: [] } });
  assert.equal(tirar.isError, undefined);

  const semAgent = await client.callTool({ name: "set_initiative_servers", arguments: { slug: outra, names: ["srv-a", "srv-b"] } });
  assert.equal(semAgent.isError, undefined);

  await initiatives.setServers(slug, ["srv-a", "srv-b"]);
  await client.close();
});
