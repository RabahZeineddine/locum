import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ApprovalGate } from "../src/approval/gate.js";
import { AgentSpec } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { Executor } from "../src/executor/executor.js";
import { dependenciaDeEvento } from "../src/executor/dependencia-de-evento.js";
import type { McpRegistry } from "../src/mcp/registry.js";
import type { Runtime, RuntimeRequest } from "../src/runtimes/types.js";
import { AgentService } from "../src/services/agent-service.js";
import { RunService } from "../src/services/run-service.js";

/** "Executar agora" em automação que depende de evento: recusa, ensaio e o passo que falhou. */

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

const registroFalso = { missing: () => [], toolsFor: async () => ({ tools: {}, release: () => undefined }) } as unknown as McpRegistry;

function runtime(pedidos: RuntimeRequest[], texto = '{"text":"Oi, revisei."}'): Runtime {
  return {
    id: "native",
    run: async (req) => {
      pedidos.push(req);
      return { text: texto, promptTokens: 1, completionTokens: 0, costUsd: 0, billable: true, toolsUsed: [] };
    },
  };
}

const modelo = (key: string, prompt: string, extra: Record<string, unknown> = {}) => ({ type: "model", key, name: key, model: "ollama/x", prompt, ...extra });

async function agente(steps: unknown[]) {
  const id = `exec-${randomUUID().slice(0, 8)}`;
  const versao = await new AgentService().upsert(AgentSpec.parse({ id, name: "Revisar PRs", steps }), undefined, "human");
  return { id, versao, spec: AgentSpec.parse(versao.spec) };
}

const passos = async (runId: string) =>
  (await db.select().from(schema.steps).where(eq(schema.steps.runId, runId))).sort((a, b) => a.idx - b.idx);
const run = async (runId: string) => (await db.select().from(schema.runs).where(eq(schema.runs.id, runId)))[0]!;

async function evento(payload: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.events).values({ id, source: "manual", externalId: `t:${id}`, payload });
  return id;
}

const SPEC_REVISAR = [
  modelo("revisar", "Revise {{event.repo}}#{{event.prNumber}}\n{{event.diff}}"),
  { type: "action", key: "responder", name: "responder", action: "teams.post", mode: "approve", input: "revisar", needs: ["revisar"] },
];

test("dependenciaDeEvento aponta o marcador ou a ação que exige conversa", async () => {
  const { spec } = await agente(SPEC_REVISAR);
  assert.match(dependenciaDeEvento(spec) ?? "", /usa \{\{event\.repo\}\}/);

  const soAcao = AgentSpec.parse({ id: "so-acao", name: "x", steps: [modelo("a", "oi"), { type: "action", key: "r", name: "r", action: "slack.post", input: "a", needs: ["a"] }] });
  assert.match(dependenciaDeEvento(soAcao) ?? "", /slack\.post/);

  const revisao = (params?: Record<string, unknown>) =>
    AgentSpec.parse({ id: "rev", name: "x", steps: [modelo("a", "oi"), { type: "action", key: "r", name: "r", action: "github.review_comment", input: "a", needs: ["a"], ...(params ? { params } : {}) }] });
  assert.match(dependenciaDeEvento(revisao()) ?? "", /github\.review_comment/);
  assert.equal(dependenciaDeEvento(revisao({ owner: "o", repo: "r", pull: 3 })), null);

  const livre = AgentSpec.parse({ id: "livre", name: "x", steps: [modelo("a", "Resuma o dia {{steps.b}}")] });
  assert.equal(dependenciaDeEvento(livre), null);
});

test("{{event.*}} sem evento recusa antes de gastar o modelo", async () => {
  const pedidos: RuntimeRequest[] = [];
  const executor = new Executor({ mcp: registroFalso, runtimes: new Map([["native", runtime(pedidos)]]), gate: new ApprovalGate(new Map()), machineId: "m" });
  const { versao } = await agente(SPEC_REVISAR);
  const runId = await executor.createRun(versao.id, null);

  assert.equal(await executor.execute(runId), "failed");
  assert.equal(pedidos.length, 0);
  assert.equal((await run(runId)).error, "esta automação precisa de um evento (usa {{event.repo}}); escolha um evento recente ou cole um link");
  assert.deepEqual((await passos(runId)).map((p) => [p.stepKey, p.status]), [["revisar", "skipped"], ["responder", "skipped"]]);
});

test("o passo que falhou fica failed com o erro, e os seguintes ficam skipped como não rodou", async () => {
  const executor = new Executor({
    mcp: registroFalso,
    runtimes: new Map([["native", runtime([])]]),
    gate: new ApprovalGate(new Map()),
    machineId: "m",
  });
  const { versao } = await agente([
    modelo("revisar", "Revise {{event.repo}}"),
    { type: "action", key: "responder", name: "responder", action: "acao.inexistente", mode: "auto", input: "revisar", needs: ["revisar"] },
    modelo("fim", "depois {{steps.responder}}", { needs: ["responder"] }),
  ]);
  const eventoId = await evento({ repo: "o/r", changedFiles: [] });
  const runId = await executor.createRun(versao.id, eventoId);

  assert.equal(await executor.execute(runId), "failed");
  const [a, b, c] = await passos(runId);
  assert.equal(a!.status, "done");
  assert.equal(b!.status, "failed");
  assert.match(b!.error ?? "", /acao\.inexistente/);
  assert.equal(c!.status, "skipped");
  assert.equal(c!.error, "not_run");
  assert.equal((await run(runId)).error, b!.error ?? "");
});

const SPEC_RESPOSTA = (acao: string) => [
  modelo("revisar", "Revise {{event.repo}}"),
  { type: "action", key: "responder", name: "responder", action: acao, mode: "approve", input: "revisar", needs: ["revisar"] },
];

for (const acao of ["teams.post", "slack.post"]) {
  test(`${acao} sem conversa de origem vira ensaio e nada sai`, async () => {
    const publicados: unknown[] = [];
    const gate = new ApprovalGate(new Map([[acao, { publish: async (p: unknown) => void publicados.push(p) }]]));
    const executor = new Executor({ mcp: registroFalso, runtimes: new Map([["native", runtime([], '{"text":"Oi, revisei."}')]]), gate, machineId: "m" });
    const { versao } = await agente(SPEC_RESPOSTA(acao));
    const eventoId = await evento({ repo: "o/r", changedFiles: [], prOwner: "o", prRepo: "r", prNumber: 7, semConversa: true });
    const runId = await executor.createRun(versao.id, eventoId);

    assert.equal(await executor.execute(runId), "done");
    const resposta = (await passos(runId)).find((p) => p.stepKey === "responder")!;
    assert.equal(resposta.status, "done");
    assert.deepEqual(resposta.output, { state: "ensaio", motivo: "ensaio, sem conversa para responder", text: "Oi, revisei." });
    assert.equal((await db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId))).length, 0);
    assert.deepEqual(publicados, []);
  });
}

/** Toda ação que publica para fora vira ensaio no evento de link colado; a que só lê segue o modo do passo. */
const ACOES_EXTERNAS: { nome: string; acao: string; params?: Record<string, unknown>; target?: string; ensaio: boolean }[] = [
  { nome: "github.review_comment", acao: "github.review_comment", ensaio: true },
  { nome: "tracker.create_issue", acao: "tracker.create_issue", target: "jira", ensaio: true },
  { nome: "mcp.call de escrita", acao: "mcp.call", params: { server: "jira", tool: "create_issue", args: {} }, ensaio: true },
  { nome: "mcp.call de leitura", acao: "mcp.call", params: { server: "jira", tool: "get_issue", args: {} }, ensaio: false },
  { nome: "http.request POST", acao: "http.request", params: { method: "POST", url: "https://example.com/x" }, ensaio: true },
  { nome: "http.request sem método (o padrão é POST)", acao: "http.request", params: { url: "https://example.com/x" }, ensaio: true },
  { nome: "http.request GET", acao: "http.request", params: { method: "GET", url: "https://example.com/x" }, ensaio: false },
];

for (const caso of ACOES_EXTERNAS) {
  test(`evento colado: ${caso.nome} ${caso.ensaio ? "vira ensaio e nada sai" : "segue o modo do passo"}`, async () => {
    const publicados: unknown[] = [];
    const gate = new ApprovalGate(new Map([[caso.acao, { publish: async (p: unknown) => void publicados.push(p) }]]));
    const executor = new Executor({ mcp: registroFalso, runtimes: new Map([["native", runtime([], '{"text":"Oi, revisei."}')]]), gate, machineId: "m" });
    const { versao } = await agente([
      modelo("revisar", "Revise {{event.repo}}"),
      { type: "action", key: "responder", name: "responder", action: caso.acao, mode: "approve", input: "revisar", needs: ["revisar"], ...(caso.params ? { params: caso.params } : {}), ...(caso.target ? { target: caso.target } : {}) },
    ]);
    const eventoId = await evento({ repo: "o/r", changedFiles: [], prOwner: "o", prRepo: "r", prNumber: 7, semConversa: true });
    const runId = await executor.createRun(versao.id, eventoId);

    const aprovacoes = async () => (await db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId))).length;
    if (caso.ensaio) {
      assert.equal(await executor.execute(runId), "done");
      const resposta = (await passos(runId)).find((p) => p.stepKey === "responder")!;
      assert.equal((resposta.output as { state: string }).state, "ensaio");
      assert.equal(await aprovacoes(), 0);
    } else {
      assert.equal(await executor.execute(runId), "paused");
      assert.equal(await aprovacoes(), 1);
    }
    assert.deepEqual(publicados, []);
  });
}

test("com evento de conversa de verdade a ação segue o modo do passo e vai para a Fila", async () => {
  const gate = new ApprovalGate(new Map([["teams.post", { publish: async () => undefined }]]));
  const executor = new Executor({ mcp: registroFalso, runtimes: new Map([["native", runtime([])]]), gate, machineId: "m" });
  const { versao } = await agente(SPEC_RESPOSTA("teams.post"));
  const eventoId = await evento({ repo: "teams/19:abc", changedFiles: [], chatId: "19:abc" });
  const runId = await executor.createRun(versao.id, eventoId);

  assert.equal(await executor.execute(runId), "paused");
  const aprovacoes = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId));
  assert.equal(aprovacoes.length, 1);
  assert.equal(aprovacoes[0]!.status, "pending");
});

test("a lista e o detalhe do run dizem qual passo falhou e qual evento foi usado", async () => {
  const executor = new Executor({ mcp: registroFalso, runtimes: new Map([["native", runtime([])]]), gate: new ApprovalGate(new Map()), machineId: "m" });
  const { id, versao } = await agente([
    modelo("revisar", "Revise {{event.repo}}"),
    { type: "action", key: "responder", name: "Responder no Teams", action: "acao.inexistente", mode: "auto", input: "revisar", needs: ["revisar"] },
  ]);
  const eventoId = await evento({ repo: "o/r", changedFiles: [], prOwner: "o", prRepo: "r", prNumber: 7, title: "Ajusta", author: "maria" });
  const runId = await executor.createRun(versao.id, eventoId);
  await executor.execute(runId);
  const semEvento = await executor.createRun(versao.id, null);
  await executor.execute(semEvento);

  const servico = new RunService();
  const [linha] = await servico.list({ agentId: id, limit: 1 + 1 }).then((l) => l.filter((r) => r.id === runId));
  assert.deepEqual(linha!.failedStep, { key: "responder", name: "Responder no Teams", error: linha!.error });
  assert.match(linha!.error ?? "", /acao\.inexistente/);

  const detalhe = (await servico.get(runId))!;
  assert.deepEqual(detalhe.event, { id: eventoId, source: "manual", author: "maria", trecho: "Ajusta", semConversa: false });
  assert.equal((await servico.get(semEvento))!.event, null);
  const recusado = (await servico.list({ agentId: id })).find((r) => r.id === semEvento)!;
  assert.equal(recusado.failedStep, null);
});
