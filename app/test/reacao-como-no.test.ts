import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ApprovalGate } from "../src/approval/gate.js";
import { AgentSpec } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { Executor } from "../src/executor/executor.js";
import { McpRegistry } from "../src/mcp/registry.js";
import type { Runtime } from "../src/runtimes/types.js";
import { AgentService } from "../src/services/agent-service.js";
import { slackReactHandler } from "../src/slack/react-action.js";
import { teamsReactHandler } from "../src/teams/react-action.js";

/** Reação como nó do fluxo: `teams.react` e `slack.react` pelo `Executor.execute`, com cliente falso. */

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

const GRAPH = "https://graph.test/v1.0";

/** Graph de mentira que anota o caminho e o corpo de cada reação. */
function graphFalso() {
  const pedidos: { caminho: string; emoji: string }[] = [];
  const opcoes = {
    token: async () => "t",
    graphUrl: GRAPH,
    fetchFn: (async (url: string, init: RequestInit) => {
      pedidos.push({ caminho: decodeURIComponent(String(url).replace(GRAPH, "")), emoji: JSON.parse(String(init.body)).reactionType });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch,
  };
  return { pedidos, opcoes };
}

const runtimeDoVeredito = (verdict: string): Runtime => ({
  id: "native",
  run: async () => ({
    text: "",
    structured: { text: "Revisei.", verdict },
    promptTokens: 1,
    completionTokens: 0,
    costUsd: 0,
    billable: false,
    toolsUsed: [],
  }),
});

const registroFalso = { missing: () => [], toolsFor: async () => ({ tools: {}, release: () => undefined }) } as unknown as McpRegistry;

async function agente(steps: unknown[]) {
  return new AgentService().upsert(AgentSpec.parse({ id: `reacao-${randomUUID().slice(0, 8)}`, name: "Reagir", steps }), undefined, "human");
}

async function evento(payload: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.events).values({ id, source: "teams", externalId: `t:${id}`, payload });
  return id;
}

const PR = { repo: "acme/api", changedFiles: [], prOwner: "acme", prRepo: "api", prNumber: 7 };

const reagir = (key: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "action",
  key,
  name: key,
  action: "teams.react",
  mode: "auto",
  params,
  ...extra,
});

const passo = async (runId: string, key: string) =>
  (await db.select().from(schema.steps).where(eq(schema.steps.runId, runId))).find((p) => p.stepKey === key)!;

/** Os quatro tipos de conversa e o caminho do Graph onde a reação cai. */
const CONVERSAS = [
  { nome: "chat 1:1", campos: { teamsChatId: "19:um@unq.gbl.spaces", teamsMessageId: "1700" }, caminho: "/chats/19:um@unq.gbl.spaces/messages/1700" },
  { nome: "chat em grupo", campos: { teamsChatId: "19:grupo@thread.v2", teamsMessageId: "1701" }, caminho: "/chats/19:grupo@thread.v2/messages/1701" },
  {
    nome: "raiz de canal",
    campos: { teamsTeamId: "T1", teamsChannelId: "19:canal@thread.tacv2", teamsMessageId: "300" },
    caminho: "/teams/T1/channels/19:canal@thread.tacv2/messages/300",
  },
  {
    nome: "resposta em thread de canal",
    campos: { teamsTeamId: "T1", teamsChannelId: "19:canal@thread.tacv2", teamsMessageId: "301", teamsReplyToId: "300" },
    caminho: "/teams/T1/channels/19:canal@thread.tacv2/messages/300/replies/301",
  },
];

for (const conversa of CONVERSAS) {
  test(`teams.react põe 👀 na mensagem do evento: ${conversa.nome}`, async () => {
    const g = graphFalso();
    const gate = new ApprovalGate(new Map([["teams.react", teamsReactHandler(g.opcoes)]]));
    const executor = new Executor({ mcp: registroFalso, runtimes: new Map(), gate, machineId: "m" });
    const versao = await agente([reagir("pegar", { emoji: "👀", operacao: "set" })]);
    const runId = await executor.createRun(versao.id, await evento({ ...PR, ...conversa.campos }));

    assert.equal(await executor.execute(runId), "done");
    assert.deepEqual(g.pedidos, [{ caminho: `${conversa.caminho}/setReaction`, emoji: "👀" }]);
  });
}

test("operacao unset tira a reação, e sem operacao o padrão é pôr", async () => {
  const g = graphFalso();
  const executor = new Executor({ mcp: registroFalso, runtimes: new Map(), gate: new ApprovalGate(new Map([["teams.react", teamsReactHandler(g.opcoes)]])), machineId: "m" });
  const versao = await agente([reagir("tirar", { emoji: "👀", operacao: "unset" }), reagir("pôr", { emoji: "✅" }, { needs: ["tirar"] })]);
  const runId = await executor.createRun(versao.id, await evento({ ...PR, ...CONVERSAS[0]!.campos }));

  assert.equal(await executor.execute(runId), "done");
  assert.deepEqual(g.pedidos.map((p) => [p.caminho.split("/").pop(), p.emoji]), [["unsetReaction", "👀"], ["setReaction", "✅"]]);
});

const POR_VEREDITO = { de: "{{steps.revisar.verdict}}", mapa: { APPROVE: "✅", REQUEST_CHANGES: "⚠️", COMMENT: "💬" }, padrao: "💬" };
const REVISAR = {
  type: "model",
  key: "revisar",
  name: "Revisar",
  model: "ollama/m",
  prompt: "revise",
  outputSchema: { type: "object", properties: { text: { type: "string" }, verdict: { type: "string" } } },
};

for (const [verdict, emoji] of [["APPROVE", "✅"], ["REQUEST_CHANGES", "⚠️"], ["COMMENT", "💬"], ["OUTRO", "💬"]] as const) {
  test(`reação pelo veredito ${verdict} troca o 👀 por ${emoji}`, async () => {
    const g = graphFalso();
    const executor = new Executor({
      mcp: registroFalso,
      runtimes: new Map([["native", runtimeDoVeredito(verdict)]]),
      gate: new ApprovalGate(new Map([["teams.react", teamsReactHandler(g.opcoes)]])),
      machineId: "m",
    });
    const versao = await agente([REVISAR, reagir("veredito", { operacao: "set", tirar: "👀", porValor: POR_VEREDITO }, { needs: ["revisar"] })]);
    const runId = await executor.createRun(versao.id, await evento({ ...PR, ...CONVERSAS[2]!.campos }));

    assert.equal(await executor.execute(runId), "done");
    assert.deepEqual(g.pedidos.map((p) => [p.caminho.split("/").pop(), p.emoji]), [["unsetReaction", "👀"], ["setReaction", emoji]]);
  });
}

test("o modelo não troca a mensagem onde a reação cai", async () => {
  const g = graphFalso();
  const executor = new Executor({
    mcp: registroFalso,
    runtimes: new Map([["native", { ...runtimeDoVeredito("APPROVE"), run: async () => ({ text: "", structured: { verdict: "APPROVE", teamsMessageId: "INVENTADA", teamsChatId: "19:outro" }, promptTokens: 1, completionTokens: 0, costUsd: 0, billable: false, toolsUsed: [] }) }]]),
    gate: new ApprovalGate(new Map([["teams.react", teamsReactHandler(g.opcoes)]])),
    machineId: "m",
  });
  const versao = await agente([REVISAR, reagir("veredito", { porValor: POR_VEREDITO }, { needs: ["revisar"] })]);
  const runId = await executor.createRun(versao.id, await evento({ ...PR, ...CONVERSAS[0]!.campos }));
  assert.equal(await executor.execute(runId), "done");
  assert.deepEqual(g.pedidos.map((p) => p.caminho), ["/chats/19:um@unq.gbl.spaces/messages/1700/setReaction"]);
});

test("evento colado (semConversa) vira ensaio: nada reage e o passo diz o que faria", async () => {
  const g = graphFalso();
  const gate = new ApprovalGate(new Map([["teams.react", teamsReactHandler(g.opcoes)]]));
  const executor = new Executor({ mcp: registroFalso, runtimes: new Map([["native", runtimeDoVeredito("REQUEST_CHANGES")]]), gate, machineId: "m" });
  const versao = await agente([REVISAR, reagir("veredito", { operacao: "set", tirar: "👀", porValor: POR_VEREDITO }, { needs: ["revisar"] })]);
  const runId = await executor.createRun(versao.id, await evento({ ...PR, semConversa: true }));

  assert.equal(await executor.execute(runId), "done");
  assert.deepEqual((await passo(runId, "veredito")).output, { state: "ensaio", motivo: "sem-conversa", text: "unset 👀, set ⚠️" });
  assert.deepEqual(g.pedidos, []);
  assert.equal((await db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId))).length, 0);
});

test("em modo approve a reação vai para a Fila com o alvo e o emoji, e só sai na decisão", async () => {
  const g = graphFalso();
  const gate = new ApprovalGate(new Map([["teams.react", teamsReactHandler(g.opcoes)]]));
  const executor = new Executor({ mcp: registroFalso, runtimes: new Map(), gate, machineId: "m" });
  const versao = await agente([reagir("pegar", { emoji: "👀" }, { mode: "approve" })]);
  const runId = await executor.createRun(versao.id, await evento({ ...PR, ...CONVERSAS[3]!.campos }));

  assert.equal(await executor.execute(runId), "paused");
  assert.deepEqual(g.pedidos, []);
  const [pendencia] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId));
  assert.deepEqual(pendencia!.payload, {
    operacao: "set",
    emoji: "👀",
    alvo: { tipo: "canal", teamId: "T1", channelId: "19:canal@thread.tacv2", messageId: "301", replyToId: "300" },
  });
  await executor.decide(pendencia!.id, "approved");
  assert.equal(g.pedidos.length, 1);
});

test("evento sem mensagem do Teams, ou valor sem emoji nem padrão, falham o passo com o motivo", async () => {
  const g = graphFalso();
  const gate = new ApprovalGate(new Map([["teams.react", teamsReactHandler(g.opcoes)]]));
  const executor = new Executor({ mcp: registroFalso, runtimes: new Map(), gate, machineId: "m" });

  const versao = await agente([reagir("pegar", { emoji: "👀" })]);
  const semMensagem = await executor.createRun(versao.id, await evento({ ...PR }));
  assert.equal(await executor.execute(semMensagem), "failed");
  assert.match((await passo(semMensagem, "pegar")).error ?? "", /evento de conversa/);

  const semPadrao = await agente([reagir("veredito", { porValor: { de: "{{event.prNumber}}", mapa: { "1": "✅" } } })]);
  const run = await executor.createRun(semPadrao.id, await evento({ ...PR, ...CONVERSAS[0]!.campos }));
  assert.equal(await executor.execute(run), "failed");
  assert.match((await passo(run, "veredito")).error ?? "", /não tem emoji para o valor "7"/);
  assert.deepEqual(g.pedidos, []);
});

test("slack.react usa o canal e o carimbo do evento, tira o 👀 antes e aceita o nome do emoji", async () => {
  const chamadas: { server: string; tool: string; args: Record<string, unknown> }[] = [];
  const handler = slackReactHandler({
    slack: { get: async () => ({ server: "slack" }) } as never,
    post: { call: async (server, tool, args) => (chamadas.push({ server, tool, args }), {}) },
  });
  const executor = new Executor({ mcp: registroFalso, runtimes: new Map([["native", runtimeDoVeredito("APPROVE")]]), gate: new ApprovalGate(new Map([["slack.react", handler]])), machineId: "m" });
  const versao = await agente([
    REVISAR,
    { ...reagir("veredito", { tirar: "👀", porValor: POR_VEREDITO }, { needs: ["revisar"] }), action: "slack.react" },
    { ...reagir("marcar", { emoji: ":rocket:" }, { needs: ["veredito"] }), action: "slack.react" },
  ]);
  const slack = await db.insert(schema.events).values({ id: randomUUID(), source: "slack", externalId: `s:${randomUUID()}`, payload: { repo: "slack/C1", changedFiles: [], channel: "C1", ts: "1700.01", threadTs: "1700.01" } }).returning();
  const runId = await executor.createRun(versao.id, slack[0]!.id);

  assert.equal(await executor.execute(runId), "done");
  assert.deepEqual(chamadas, [
    { server: "slack", tool: "slack_remove_reaction", args: { channel_id: "C1", timestamp: "1700.01", name: "eyes" } },
    { server: "slack", tool: "slack_add_reaction", args: { channel_id: "C1", timestamp: "1700.01", name: "white_check_mark" } },
    { server: "slack", tool: "slack_add_reaction", args: { channel_id: "C1", timestamp: "1700.01", name: "rocket" } },
  ]);
});

test("reação marcada optional que o Graph recusa não derruba o run, e a sem optional derruba", async () => {
  const recusa = { token: async () => "t", graphUrl: GRAPH, fetchFn: (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch };
  const gate = new ApprovalGate(new Map([["teams.react", teamsReactHandler(recusa)]]));
  const executor = new Executor({ mcp: registroFalso, runtimes: new Map([["native", runtimeDoVeredito("COMMENT")]]), gate, machineId: "m" });

  const tolerante = await agente([reagir("pegar", { emoji: "👀" }, { optional: true }), { ...REVISAR, needs: ["pegar"] }]);
  const run = await executor.createRun(tolerante.id, await evento({ ...PR, ...CONVERSAS[0]!.campos }));
  assert.equal(await executor.execute(run), "done");
  assert.equal((await passo(run, "pegar")).status, "failed");
  assert.equal((await passo(run, "revisar")).status, "done");

  const rigido = await agente([reagir("pegar", { emoji: "👀" }), { ...REVISAR, needs: ["pegar"] }]);
  const falho = await executor.createRun(rigido.id, await evento({ ...PR, ...CONVERSAS[0]!.campos }));
  assert.equal(await executor.execute(falho), "failed");
  assert.equal((await passo(falho, "revisar")).status, "skipped");
});
