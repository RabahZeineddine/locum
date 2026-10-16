import { afterEach, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ApprovalGate, type ActionHandler } from "../src/approval/gate.js";
import { AgentSpec } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { Executor } from "../src/executor/executor.js";
import { McpRegistry } from "../src/mcp/registry.js";
import type { Runtime } from "../src/runtimes/types.js";
import { AgentService } from "../src/services/agent-service.js";
import { githubReviewHandler, type ReviewClient } from "../src/sources/github.js";

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

const ORIGEM = { teamsChatId: "19:chat@thread.v2", teamsMessageId: "1700" };
const REVIEW = { owner: "acme", repo: "api", pull: 7, findings: [], ...ORIGEM };

/** Tudo que sai pela rede durante o teste: se alguma reação escapar, ela aparece aqui. */
const saidas: string[] = [];
const fetchOriginal = globalThis.fetch;
beforeEach(() => {
  saidas.length = 0;
  globalThis.fetch = (async (url: string | URL) => {
    saidas.push(String(url));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

const clienteDoGithub = {
  rest: { pulls: { createReview: async () => ({}), listReviews: async () => ({ data: [] }) } },
} as unknown as ReviewClient;

async function agentEPasso(actionKind: string) {
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: `revisor-${randomUUID()}`,
      name: "Revisor",
      steps: [
        { type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt: "revise" },
        { type: "action", key: "publicar", name: "Publicar", action: actionKind, needs: ["ler"] },
      ],
    }),
    undefined,
    "human",
  );
  const runId = randomUUID();
  const stepId = randomUUID();
  await db.insert(schema.runs).values({ id: runId, agentVersionId: versao.id, status: "running" });
  await db
    .insert(schema.steps)
    .values({ id: stepId, runId, idx: 1, stepKey: "publicar", name: "Publicar", status: "awaiting_approval" });
  return { runId, stepId, versionId: versao.id };
}

test("rascunho do review não reage", async () => {
  await githubReviewHandler(() => clienteDoGithub).draft!({ ...REVIEW, verdict: "APPROVE" }, "ext-d");
  assert.deepEqual(saidas, []);
});

test("rejeitar na fila e aprovar não reagem: a reação é de um nó do fluxo", async () => {
  const gate = new ApprovalGate(new Map([["github.review_comment", githubReviewHandler(() => clienteDoGithub)]]));
  for (const decisao of ["rejected", "approved"] as const) {
    const { runId, stepId } = await agentEPasso("github.review_comment");
    await gate.submit({ runId, stepId, kind: "github.review_comment", payload: { ...REVIEW, verdict: "REQUEST_CHANGES" } }, "approve");
    const [pendencia] = await db.select().from(schema.approvals).where(eq(schema.approvals.stepId, stepId));
    await gate.decide(pendencia!.id, decisao);
  }
  assert.deepEqual(saidas, []);
});

test("propose que devolve nulo chama o descarte da ação", async () => {
  const descartados: unknown[] = [];
  const handler: ActionHandler = {
    propose: async () => null,
    publish: async () => undefined,
    discard: async (payload) => {
      descartados.push(payload);
    },
  };
  await new ApprovalGate(new Map([["x.acao", handler]])).prepare("x.acao", { a: 1 }, "approve");
  assert.deepEqual(descartados, [{ a: 1 }]);
});

test("run que falha não mexe na mensagem do Teams", async () => {
  const runtime: Runtime = {
    run: async () => {
      throw new Error("modelo fora do ar");
    },
  } as unknown as Runtime;
  const agentId = `falho-${randomUUID()}`;
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: agentId,
      name: "Falho",
      steps: [{ type: "model", key: "ler", name: "Ler", model: "ollama/m", prompt: "revise" }],
    }),
    undefined,
    "human",
  );
  const eventId = randomUUID();
  await db.insert(schema.events).values({
    id: eventId,
    source: "teams",
    externalId: `teams:g:${eventId}`,
    payload: { repo: "acme/api", changedFiles: [], ...ORIGEM },
  });
  const executor = new Executor({
    mcp: new McpRegistry(new Map()),
    runtimes: new Map([["native", runtime]]),
    gate: new ApprovalGate(new Map()),
    machineId: "maquina-de-teste",
  });
  const runId = await executor.createRun(versao.id, eventId);
  assert.equal(await executor.execute(runId), "failed");
  assert.deepEqual(saidas, []);
});

test("run pausado e retomado: a review publica e nada reage", async () => {
  const criadas: unknown[] = [];
  const cliente = {
    rest: { pulls: { createReview: async (p: unknown) => void criadas.push(p), listReviews: async () => ({ data: [] }) } },
  } as unknown as ReviewClient;
  const runtime: Runtime = {
    id: "native",
    run: async () => ({
      text: "",
      structured: { findings: [], verdict: "COMMENT" },
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0,
      billable: false,
      toolsUsed: [],
    }),
  };
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: `revisor-${randomUUID()}`,
      name: "Revisor",
      steps: [
        {
          type: "model",
          key: "ler",
          name: "Ler",
          model: "ollama/m",
          prompt: "revise",
          outputSchema: { type: "object" },
        },
        { type: "action", key: "publicar", name: "Publicar", action: "github.review_comment", needs: ["ler"], mode: "approve" },
      ],
    }),
    undefined,
    "human",
  );
  const eventId = randomUUID();
  await db.insert(schema.events).values({
    id: eventId,
    source: "teams",
    externalId: `teams:g:${eventId}`,
    payload: { repo: "acme/api", repoName: "api", owner: "acme", pull: 7, headSha: "abc", changedFiles: [], ...ORIGEM },
  });
  const executor = new Executor({
    mcp: new McpRegistry(new Map()),
    runtimes: new Map([["native", runtime]]),
    gate: new ApprovalGate(new Map([["github.review_comment", githubReviewHandler(() => cliente)]])),
    machineId: "maquina-de-teste",
  });

  const runId = await executor.createRun(versao.id, eventId);
  const estado = await executor.execute(runId);
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  assert.equal(estado, "paused", String(run?.error));
  assert.deepEqual(saidas, []);

  const [pendencia] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId));
  assert.deepEqual(await executor.decide(pendencia!.id, "approved"), { status: "approved", run: "done" });
  assert.equal(criadas.length, 1);
  assert.deepEqual(saidas, []);
});
