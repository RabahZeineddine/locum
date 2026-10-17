import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { libraryService } from "../src/services/library-service.js";
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

test("describe_steps declara o destino de cada ação de conversa, lido do registro", async () => {
  const client = await ligarCliente();
  const catalogo = resultado(await client.callTool({ name: "describe_steps", arguments: {} })) as {
    steps: { action: { destino: { porAcao: Record<string, { app: string; destinos: string[] }> } } };
  };
  const porAcao = catalogo.steps.action.destino.porAcao;
  assert.deepEqual(porAcao["teams.post"], { app: "teams", efeito: "responder", destinos: ["evento", "fixo", "novo"] });
  assert.deepEqual(porAcao["slack.react"]?.destinos, ["evento"]);
});

test("describe_steps diz quem sobe o modo e quem liga o gatilho, como as ferramentas fazem hoje", async () => {
  const client = await ligarCliente();
  const catalogo = JSON.stringify(resultado(await client.callTool({ name: "describe_steps", arguments: {} })));
  assert.doesNotMatch(catalogo, /only a person raises the mode/);
  assert.match(catalogo, /upsert_agent[^"]*approve/);
  assert.match(catalogo, /save_automation[^"]*save_agent_edited|save_agent_edited[^"]*save_automation/);
  assert.match(catalogo, /set_trigger_enabled/);
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

test("ferramenta nova de servidor write é gravada, direto ou pelo toolset, e as duas ferramentas são destrutivas", async () => {
  const client = await ligarCliente();
  const sufixo = randomUUID().slice(0, 8);
  const servidor = `escrita-${sufixo}`;
  await mcpService.register({ name: servidor, transport: "http", url: "http://127.0.0.1:9/mcp", scope: "write" });

  const { tools } = await client.listTools();
  for (const nome of ["upsert_library_agent", "upsert_toolset"]) {
    assert.equal(tools.find((t) => t.name === nome)?.annotations?.destructiveHint, true, nome);
    assert.match(tools.find((t) => t.name === nome)?.description ?? "", /write/);
  }

  resultado(await client.callTool({
    name: "upsert_library_agent",
    arguments: { spec: { id: `a-${sufixo}`, name: "A", model: "a/b", tools: [{ server: servidor, tool: "comentar" }] } },
  }));
  resultado(await client.callTool({
    name: "upsert_toolset",
    arguments: { toolset: { id: `t-${sufixo}`, name: "T", tools: [{ server: servidor, tool: "comentar" }] } },
  }));
  const lido = resultado(await client.callTool({ name: "get_library_agent", arguments: { id: `a-${sufixo}` } })) as {
    spec: { tools: { tool: string }[] };
  };
  assert.deepEqual(lido.spec.tools.map((t) => t.tool), ["comentar"]);
});

test("o agent grava e devolve conexões, skills e orçamento pelo MCP", async () => {
  const client = await ligarCliente();
  const id = `completo-${randomUUID().slice(0, 8)}`;
  const spec = {
    id,
    name: "Completo",
    model: "anthropic/claude-sonnet-5",
    connections: [{ connectionId: "github", tools: { list_commits: false } }],
    skills: ["revisao"],
    budget: { perDayUsd: 2 },
  };
  resultado(await client.callTool({ name: "upsert_library_agent", arguments: { spec } }));
  const lido = resultado(await client.callTool({ name: "get_library_agent", arguments: { id } })) as {
    spec: { connections: unknown; skills: unknown; budget: unknown };
  };
  assert.deepEqual(lido.spec.connections, spec.connections);
  assert.deepEqual(lido.spec.skills, [{ skill: "revisao", when: { always: true } }]);
  assert.deepEqual(lido.spec.budget, { perDayUsd: 2 });
});

test("pelo MCP, liberar escrita numa conexão grava como na tela", async () => {
  const client = await ligarCliente();
  const sufixo = randomUUID().slice(0, 8);
  const servidor = `conexao-escrita-${sufixo}`;
  await mcpService.register({ name: servidor, transport: "http", url: "http://127.0.0.1:9/mcp", scope: "write" });
  // O que a última leitura do servidor guardou: nome de leitura anotado como escrita.
  await db.insert(schema.settings).values({
    key: `mcp.ferramentas.${servidor}`,
    value: JSON.stringify({
      at: Date.now(),
      tools: [{ name: "get_report", description: "", estimatedTokens: 0, readOnlyHint: false }],
    }),
  });
  const base = { id: `w-${sufixo}`, name: "W", model: "a/b" };
  const grava = (connections: unknown) =>
    client.callTool({ name: "upsert_library_agent", arguments: { spec: { ...base, connections } } });

  resultado(await grava([{ connectionId: servidor }]));
  resultado(await grava([{ connectionId: servidor, tools: { buscar: true, get_report: true } }]));
  resultado(await grava([{ connectionId: "github", tools: { create_comment: true, "github/get_report": "read" } }]));
  const lido = resultado(await client.callTool({ name: "get_library_agent", arguments: { id: base.id } })) as {
    spec: { connections: { connectionId: string; tools: Record<string, unknown> }[] };
  };
  assert.equal(lido.spec.connections[0]?.connectionId, "github");
  assert.equal(lido.spec.connections[0]?.tools.create_comment, true);
});
