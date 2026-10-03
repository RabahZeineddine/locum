import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { migrateDb } from "../src/db/migrate.js";
import { mcpService } from "../src/services/mcp-service.js";
import { buildMcpServer } from "../src/mcp-server/server.js";

/** A biblioteca e o catálogo de passos pelo servidor MCP do Locum. */

before(() => migrateDb());

async function ligarCliente(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildMcpServer().connect(serverTransport);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function texto(res: Awaited<ReturnType<Client["callTool"]>>): string {
  return (res.content as { type: string; text: string }[])[0]?.text ?? "";
}

function resultado(res: Awaited<ReturnType<Client["callTool"]>>): unknown {
  assert.equal(res.isError, undefined, `ferramenta devolveu erro: ${texto(res)}`);
  return JSON.parse(texto(res));
}

test("describe_steps traz lógica, comparações e os modos de cada ação", async () => {
  const client = await ligarCliente();
  const catalogo = resultado(await client.callTool({ name: "describe_steps", arguments: {} })) as {
    steps: { logic: { ops: Record<string, string>; compares: string[] } };
    actions: { kind: string; modes: string[] }[];
  };
  assert.ok("switch" in catalogo.steps.logic.ops);
  assert.ok(catalogo.steps.logic.compares.includes("matches"));
  const slack = catalogo.actions.find((a) => a.kind === "slack.post");
  assert.deepEqual(slack?.modes, ["approve", "auto"]);
});

test("toolset e agent da biblioteca gravados pelo MCP aparecem na lista", async () => {
  const client = await ligarCliente();
  const sufixo = randomUUID().slice(0, 8);
  const toolset = `leitura-${sufixo}`;
  resultado(
    await client.callTool({
      name: "upsert_toolset",
      arguments: { toolset: { id: toolset, name: "Leitura", tools: [{ server: "x", tool: "ler" }] }, create: true },
    }),
  );
  const agent = `triador-${sufixo}`;
  const gravado = resultado(
    await client.callTool({
      name: "upsert_library_agent",
      arguments: {
        spec: { id: agent, name: "Triador", model: "anthropic/claude-sonnet-5", temperature: 0.2, toolsets: [toolset] },
        note: "primeira",
      },
    }),
  ) as { version: number };
  assert.equal(gravado.version, 1);

  const lido = resultado(await client.callTool({ name: "get_library_agent", arguments: { id: agent } })) as {
    spec: { temperature: number; toolsets: string[] };
    versions: unknown[];
  };
  assert.equal(lido.spec.temperature, 0.2);
  assert.deepEqual(lido.spec.toolsets, [toolset]);
  assert.equal(lido.versions.length, 1);

  const toolsets = resultado(await client.callTool({ name: "list_toolsets", arguments: {} })) as { id: string; usedBy: string[] }[];
  assert.deepEqual(toolsets.find((t) => t.id === toolset)?.usedBy, [agent]);
});

test("ferramenta nova de servidor write é recusada, direto ou pelo toolset", async () => {
  const client = await ligarCliente();
  const sufixo = randomUUID().slice(0, 8);
  const servidor = `escrita-${sufixo}`;
  await mcpService.register({ name: servidor, transport: "http", url: "http://127.0.0.1:9/mcp", scope: "write" });

  const direto = await client.callTool({
    name: "upsert_library_agent",
    arguments: { spec: { id: `a-${sufixo}`, name: "A", model: "a/b", tools: [{ server: servidor, tool: "comentar" }] } },
  });
  assert.equal(direto.isError, true);
  assert.match(texto(direto), /escopo write/);

  const pelo = await client.callTool({
    name: "upsert_toolset",
    arguments: { toolset: { id: `t-${sufixo}`, name: "T", tools: [{ server: servidor, tool: "comentar" }] } },
  });
  assert.equal(pelo.isError, true);
});
