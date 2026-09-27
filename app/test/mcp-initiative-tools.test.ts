import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { mcpService } from "../src/services/mcp-service.js";
import { buildMcpServer } from "../src/mcp-server/server.js";

before(() => {
  migrateDb();
});

/** Sobe cliente e servidor ligados no mesmo processo, como InMemoryTransport permite. */
async function ligarCliente(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer();
  await server.connect(serverTransport);

  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function resultado(res: Awaited<ReturnType<Client["callTool"]>>): unknown {
  assert.equal(res.isError, undefined, `ferramenta devolveu erro: ${JSON.stringify(res.content)}`);
  const texto = (res.content as { type: string; text: string }[])[0]?.text;
  return texto ? JSON.parse(texto) : null;
}

test("list_initiatives lista o que upsert_initiative grava", async () => {
  const client = await ligarCliente();
  const slug = `frente-${randomUUID().slice(0, 8)}`;

  const criada = resultado(
    await client.callTool({
      name: "upsert_initiative",
      arguments: { slug, title: "Frente de teste", objective: "objetivo", doneCriteria: "criterio" },
    }),
  ) as { slug: string };
  assert.equal(criada.slug, slug);

  const lista = resultado(await client.callTool({ name: "list_initiatives", arguments: {} })) as { slug: string }[];
  assert.ok(lista.some((i) => i.slug === slug));

  const detalhe = resultado(
    await client.callTool({ name: "get_initiative", arguments: { slug } }),
  ) as { slug: string; servers: string[] };
  assert.equal(detalhe.slug, slug);
  assert.deepEqual(detalhe.servers, []);

  await client.close();
});

test("read_initiative_context devolve o context.md inicial com hash", async () => {
  const client = await ligarCliente();
  const slug = `frente-${randomUUID().slice(0, 8)}`;

  await client.callTool({
    name: "upsert_initiative",
    arguments: { slug, title: "Frente de leitura", objective: "objetivo", doneCriteria: "criterio" },
  });

  const contexto = resultado(
    await client.callTool({ name: "read_initiative_context", arguments: { slug } }),
  ) as { content: string; hash: string };
  assert.ok(contexto.content.length > 0);
  assert.ok(contexto.hash.length > 0);

  await client.close();
});

test("set_initiative_servers grava a lista validada contra o cadastro", async () => {
  const client = await ligarCliente();
  const slug = `frente-${randomUUID().slice(0, 8)}`;
  const servidor = `srv-${randomUUID().slice(0, 8)}`;

  await client.callTool({
    name: "upsert_initiative",
    arguments: { slug, title: "Frente com servidor", objective: "objetivo", doneCriteria: "criterio" },
  });
  await mcpService.register({ name: servidor, transport: "stdio", command: ["true"] });

  const resposta = resultado(
    await client.callTool({ name: "set_initiative_servers", arguments: { slug, names: [servidor] } }),
  ) as { affectedAgents: unknown[] };
  assert.deepEqual(resposta.affectedAgents, []);

  const detalhe = resultado(
    await client.callTool({ name: "get_initiative", arguments: { slug } }),
  ) as { servers: string[] };
  assert.deepEqual(detalhe.servers, [servidor]);

  await client.close();
});

test("propose_context_update cria pendencia e nao muda o context.md", async () => {
  const client = await ligarCliente();
  const slug = `frente-${randomUUID().slice(0, 8)}`;

  await client.callTool({
    name: "upsert_initiative",
    arguments: { slug, title: "Frente com proposta", objective: "objetivo", doneCriteria: "criterio" },
  });

  const antes = resultado(
    await client.callTool({ name: "read_initiative_context", arguments: { slug } }),
  ) as { content: string };

  const proposta = resultado(
    await client.callTool({
      name: "propose_context_update",
      arguments: { slug, mode: "append", content: "bloco novo" },
    }),
  ) as { approvalId: string };
  assert.ok(proposta.approvalId.length > 0);

  const depois = resultado(
    await client.callTool({ name: "read_initiative_context", arguments: { slug } }),
  ) as { content: string };
  assert.equal(depois.content, antes.content, "propose_context_update nao pode escrever no arquivo");

  const [pendencia] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, proposta.approvalId));
  assert.equal(pendencia?.status, "pending");
  assert.equal(pendencia?.kind, "context.update");

  await client.close();
});
