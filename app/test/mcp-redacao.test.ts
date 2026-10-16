import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { buildMcpServer } from "../src/mcp-server/server.js";
import { agentService } from "../src/services/agent-service.js";
import { mcpService } from "../src/services/mcp-service.js";
import { secretService } from "../src/services/secret-service.js";

/**
 * A redação esconde segredo de verdade e deixa o resto voltar igual: o ciclo
 * ler, editar e gravar de volta não pode gravar texto mutilado nem perder valor.
 */

before(() => migrateDb());

/** Junta pedaços: um token de mentira inteiro no código acende a proteção de push do GitHub. */
const j = (...partes: string[]): string => partes.join("");

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

const SEGREDO_LITERAL = j("valor-literal-do-cabecalho-", randomUUID().slice(0, 8));
const PROMPT = "Missing null check on token: it can be undefined";
const INSTRUCAO = "const apiKey = process.env.API_KEY";
const TEXTO = `${PROMPT}\n${INSTRUCAO}`;

const HEADERS = {
  Authorization: "Bearer {{steps.auth.token}}",
  "X-Api-Key": "{{event.key}}",
  "X-Chave-De-Servico": SEGREDO_LITERAL,
  "Content-Type": "application/json",
};

const specCom = (agentId: string, nome = "Redacao") => ({
  id: agentId,
  name: nome,
  steps: [
    { type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt: TEXTO },
    { type: "action", key: "chamar", name: "Chamar", action: "http.request", needs: ["ler"], mode: "approve", params: { method: "POST", url: "https://api.exemplo.dev/x", headers: HEADERS } },
  ],
});

async function headersGravados(agentId: string): Promise<Record<string, string>> {
  const v = await agentService.getLatestVersion(agentId);
  const passo = v!.spec.steps.find((p) => p.key === "chamar") as { params?: { headers?: Record<string, string> } };
  return passo.params!.headers!;
}

async function lerSpec(client: Client, ferramenta: string, agentId: string) {
  const res = await client.callTool({ name: ferramenta, arguments: { agentId } });
  assert.ok(!texto(res).includes(SEGREDO_LITERAL), `${ferramenta} devolveu o segredo`);
  return ok<{ spec: ReturnType<typeof specCom> }>(res).spec;
}

function conferirLeitura(spec: ReturnType<typeof specCom>): void {
  assert.equal((spec.steps[0] as { prompt: string }).prompt, TEXTO);
  const headers = (spec.steps[1] as { params: { headers: Record<string, string> } }).params.headers;
  assert.equal(headers.Authorization, HEADERS.Authorization);
  assert.equal(headers["X-Api-Key"], HEADERS["X-Api-Key"]);
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["X-Chave-De-Servico"], "<oculto>");
}

test("get_agent e save_agent_edited: texto e templates voltam iguais, o literal volta ao original", async () => {
  const client = await ligarCliente();
  const agentId = id("ciclo");
  await agentService.upsert(specCom(agentId) as never, undefined, "human");

  const spec = await lerSpec(client, "get_agent", agentId);
  conferirLeitura(spec);
  ok(await client.callTool({ name: "save_agent_edited", arguments: { agentId, spec: { ...spec, name: "Renomeado" }, note: "renomeia" } }));
  assert.deepEqual(await headersGravados(agentId), HEADERS);
  const v = await agentService.getLatestVersion(agentId);
  assert.equal((v!.spec.steps[0] as { prompt: string }).prompt, TEXTO);
});

test("get_automation e save_automation: o mesmo ciclo, com os gatilhos", async () => {
  const client = await ligarCliente();
  const agentId = id("auto");
  await agentService.upsert(specCom(agentId) as never, undefined, "human");

  const spec = await lerSpec(client, "get_automation", agentId);
  conferirLeitura(spec);
  ok(await client.callTool({ name: "save_automation", arguments: { spec: { ...spec, name: "Renomeada" }, triggers: [], note: "renomeia" } }));
  assert.deepEqual(await headersGravados(agentId), HEADERS);
});

test("get_agent e upsert_agent: o mesmo ciclo", async () => {
  const client = await ligarCliente();
  const agentId = id("upsert");
  await agentService.upsert(specCom(agentId) as never, undefined, "human");

  const spec = await lerSpec(client, "get_agent", agentId);
  ok(await client.callTool({ name: "upsert_agent", arguments: { spec: { ...spec, name: "Outra" }, note: "renomeia" } }));
  assert.deepEqual(await headersGravados(agentId), HEADERS);
});

test("export_agent sai sem o literal, e import_agent no mesmo agent devolve o que estava", async () => {
  const client = await ligarCliente();
  const agentId = id("export");
  await agentService.upsert(specCom(agentId) as never, undefined, "human");

  const exportado = ok<{ text: string }>(await client.callTool({ name: "export_agent", arguments: { agentId } }));
  assert.ok(!exportado.text.includes(SEGREDO_LITERAL));
  assert.ok(exportado.text.includes("{{steps.auth.token}}"));
  assert.ok(exportado.text.includes(PROMPT));

  const editado = JSON.stringify({ ...JSON.parse(exportado.text), name: "Reimportado" });
  const volta = ok<{ created: boolean; hiddenWithoutValue?: string[] }>(await client.callTool({ name: "import_agent", arguments: { text: editado } }));
  assert.equal(volta.created, false);
  assert.equal(volta.hiddenWithoutValue, undefined);
  assert.deepEqual(await headersGravados(agentId), HEADERS);

  // Em outra máquina (sem o agent), o literal não existe: cai fora, e a resposta diz qual.
  const outro = id("outra-maquina");
  const novo = ok<{ created: boolean; hiddenWithoutValue?: string[] }>(
    await client.callTool({ name: "import_agent", arguments: { text: JSON.stringify({ ...JSON.parse(exportado.text), id: outro }) } }),
  );
  assert.equal(novo.created, true);
  assert.deepEqual(novo.hiddenWithoutValue, ["chamar.headers.X-Chave-De-Servico"]);
  const { "X-Chave-De-Servico": _fora, ...resto } = HEADERS;
  assert.deepEqual(await headersGravados(outro), resto);
});

test("get_approval, edit_approval_findings e a leitura seguinte: o achado volta igual", async () => {
  const client = await ligarCliente();
  const agentId = id("revisao");
  const versao = await agentService.upsert({ id: agentId, name: "Rev", steps: [{ type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt: "x" }, { type: "action", key: "publicar", name: "P", action: "github.review_comment", needs: ["ler"] }] } as never, undefined, "human");
  const run = id("run");
  const passo = id("passo");
  const aprovacao = id("apr");
  await db.insert(schema.runs).values({ id: run, agentVersionId: versao.id, status: "paused" });
  await db.insert(schema.steps).values({ id: passo, runId: run, idx: 1, stepKey: "publicar", name: "P", status: "awaiting_approval" });
  const achado = { file: "a.ts", line: 3, severity: "high", problem: PROMPT, fix: INSTRUCAO };
  await db.insert(schema.approvals).values({ id: aprovacao, runId: run, stepId: passo, kind: "github.review_comment", payload: { owner: "o", repo: "r", pull: 1, findings: [achado] } });

  const lido = ok<{ payload: { findings: unknown[] } }>(await client.callTool({ name: "get_approval", arguments: { approvalId: aprovacao } }));
  assert.deepEqual(lido.payload.findings, [achado]);
  ok(await client.callTool({ name: "edit_approval_findings", arguments: { approvalId: aprovacao, findings: lido.payload.findings, summary: "ok" } }));
  const depois = ok<{ payload: { findings: unknown[] } }>(await client.callTool({ name: "get_approval", arguments: { approvalId: aprovacao } }));
  assert.deepEqual(depois.payload.findings, [achado]);
});

test("o valor que está no cofre sai oculto de qualquer leitura, em qualquer texto", async () => {
  secretService.useBackend({ available: () => true, encrypt: (p) => Buffer.from(p), decrypt: (b) => b.toString() });
  const client = await ligarCliente();
  const guardado = j("valor-do-cofre-", randomUUID().slice(0, 8));
  secretService.set(`teste/${id("cofre")}`, guardado);
  const agentId = id("cofre");
  await agentService.upsert({ id: agentId, name: "Cofre", steps: [{ type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt: `use ${guardado} aqui` }] } as never, undefined, "human");
  const saida = texto(await client.callTool({ name: "get_agent", arguments: { agentId } }));
  assert.ok(!saida.includes(guardado));
  assert.match(saida, /use <oculto> aqui/);
  for (const ref of secretService.list().filter((r) => r.startsWith("teste/"))) secretService.remove(ref);
});

test("argumento de comando que carrega credencial sai oculto e volta ao original na escrita", async () => {
  const client = await ligarCliente();
  const nome = id("srv");
  const command = ["npx", "x-mcp", "--api-key", "abc123opaco", "--modo", "leitura"];
  ok(await client.callTool({ name: "register_mcp_server", arguments: { name: nome, transport: "stdio", command, env: { REGIAO: "{{event.regiao}}" } } }));

  const listados = ok<{ name: string; command: string[]; env: Record<string, string> }[]>(await client.callTool({ name: "list_mcp_servers", arguments: {} }));
  const meu = listados.find((s) => s.name === nome)!;
  assert.deepEqual(meu.command, ["npx", "x-mcp", "--api-key", "<oculto>", "--modo", "leitura"]);
  assert.equal(meu.env.REGIAO, "{{event.regiao}}");
  assert.ok(!JSON.stringify(listados).includes("abc123opaco"));

  // Devolver o comando como veio, só mudando o escopo, mantém o argumento original.
  ok(await client.callTool({ name: "register_mcp_server", arguments: { name: nome, transport: "stdio", command: meu.command, scope: "write" } }));
  assert.deepEqual((await mcpService.get(nome))!.config.command, command);
});
