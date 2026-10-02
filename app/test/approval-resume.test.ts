import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ApprovalGate, type ActionHandler } from "../src/approval/gate.js";
import { AgentSpec } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { Executor } from "../src/executor/executor.js";
import { McpRegistry } from "../src/mcp/registry.js";
import type { Runtime } from "../src/runtimes/types.js";
import { AgentService } from "../src/services/agent-service.js";

// O executor e a gate falam com o banco do módulo, e não com um banco passado
// por fora. O `setup.ts` já apontou esse banco para uma pasta temporária; aqui
// ele só recebe o esquema.
before(() => {
  migrateDb();
  // O executor resolve o modelo pelo registro de verdade, que olha o ambiente.
  // O Ollama é o único provedor que fica disponível sem chave; nada sai para
  // esse endereço, porque quem responde é o runtime falso abaixo.
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

const runtimeFalso: Runtime = {
  id: "native",
  run: async (req) => ({
    text: `respondeu a: ${req.prompt}`,
    promptTokens: 1,
    completionTokens: 1,
    costUsd: 0,
    billable: false,
    toolsUsed: [],
  }),
};

/** Pipeline com um passo depois da ação, para provar que ele roda. */
async function montar() {
  const agentId = `revisor-${randomUUID()}`;
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: agentId,
      name: "Revisor",
      steps: [
        { type: "model", key: "ler", name: "Ler", model: "ollama/modelo", prompt: "revise" },
        { type: "action", key: "publicar", name: "Publicar", action: "teste.publicar", needs: ["ler"] },
        {
          type: "model",
          key: "depois",
          name: "Depois",
          model: "ollama/modelo",
          prompt: "resuma",
          needs: ["publicar"],
        },
      ],
    }),
    undefined,
    "human",
  );

  const publicados: string[] = [];
  const handler: ActionHandler = {
    publish: async (_payload, externalId) => {
      publicados.push(externalId);
    },
  };
  const gate = new ApprovalGate(new Map([["teste.publicar", handler]]));
  const executor = new Executor({
    mcp: new McpRegistry(new Map()),
    runtimes: new Map([["native", runtimeFalso]]),
    gate,
    machineId: "maquina-de-teste",
  });

  const runId = await executor.createRun(versao.id, null);
  assert.equal(await executor.execute(runId), "paused");

  const [pendencia] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId));
  assert.ok(pendencia);
  return { runId, approvalId: pendencia.id, gate, executor, publicados };
}

const passo = async (runId: string, stepKey: string) => {
  const [row] = await db
    .select()
    .from(schema.steps)
    .where(and(eq(schema.steps.runId, runId), eq(schema.steps.stepKey, stepKey)));
  return row;
};

const estadoDoRun = async (runId: string) =>
  (await db.select().from(schema.runs).where(eq(schema.runs.id, runId)))[0]?.status;

test("execução aprovada publica uma vez, roda o passo seguinte e termina em done", async () => {
  const { runId, approvalId, executor, publicados } = await montar();

  assert.deepEqual(await executor.decide(approvalId, "approved"), { status: "approved", run: "done" });

  assert.equal(await estadoDoRun(runId), "done");
  assert.equal((await passo(runId, "publicar"))?.status, "done");
  assert.equal((await passo(runId, "depois"))?.status, "done");
  assert.deepEqual(publicados, [`${runId}:${(await passo(runId, "publicar"))!.id}`]);
});

test("execução rejeitada sai de paused sem publicar, com a ação pulada", async () => {
  const { runId, approvalId, executor, publicados } = await montar();

  assert.deepEqual(await executor.decide(approvalId, "rejected"), { status: "rejected", run: "done" });

  assert.equal(await estadoDoRun(runId), "done");
  assert.equal((await passo(runId, "publicar"))?.status, "skipped");
  assert.equal((await passo(runId, "depois"))?.status, "done");
  assert.deepEqual(publicados, []);
});

test("decisão tomada direto na gate também deixa o run retomável", async () => {
  // É o caminho de quem decidiu e caiu antes de retomar: a pendência fechou, e
  // o passo tem que refletir a decisão para a retomada não pausar de novo.
  const { runId, approvalId, gate, executor, publicados } = await montar();

  await gate.decide(approvalId, "approved");
  assert.equal((await passo(runId, "publicar"))?.status, "done");

  assert.equal(await executor.execute(runId), "done");
  assert.equal(publicados.length, 1);
});

test("passo parado em aguardando com a pendência já fechada é reconciliado na retomada", async () => {
  // Queda entre fechar a pendência e atualizar o passo. A retomada lê a decisão
  // gravada na pendência, e não publica de novo.
  const { runId, approvalId, executor, publicados } = await montar();

  await db
    .update(schema.approvals)
    .set({ status: "rejected", decidedAt: Math.floor(Date.now() / 1000) })
    .where(eq(schema.approvals.id, approvalId));

  assert.equal(await executor.execute(runId), "done");
  assert.equal((await passo(runId, "publicar"))?.status, "skipped");
  assert.deepEqual(publicados, []);
});

test("pendência ainda aberta continua pausando a retomada", async () => {
  const { runId, executor, publicados } = await montar();

  assert.equal(await executor.execute(runId), "paused");
  assert.equal((await passo(runId, "publicar"))?.status, "awaiting_approval");
  assert.deepEqual(publicados, []);
});

test("dois cliques de aprovar ao mesmo tempo publicam uma vez só", async () => {
  const { runId, approvalId, gate, publicados } = await montar();

  const resultados = await Promise.allSettled([
    gate.decide(approvalId, "approved"),
    gate.decide(approvalId, "approved"),
  ]);

  assert.equal(publicados.length, 1);
  assert.deepEqual(
    resultados.map((r) => r.status).sort(),
    ["fulfilled", "rejected"],
  );
  assert.equal((await passo(runId, "publicar"))?.status, "done");
});

test("publicação que falha devolve a pendência para a fila, e queda no meio pausa a retomada", async () => {
  const { runId, approvalId, gate, executor } = await montar();
  const [linha] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));

  const falha = new ApprovalGate(
    new Map([["teste.publicar", { publish: async () => Promise.reject(new Error("rede")) }]]),
  );
  await assert.rejects(falha.decide(approvalId, "approved"), /rede/);
  const [depois] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
  assert.equal(depois?.status, "pending");
  assert.equal(linha?.status, "pending");

  await db.update(schema.approvals).set({ status: "publishing" }).where(eq(schema.approvals.id, approvalId));
  assert.equal(await executor.execute(runId), "paused");
  await assert.rejects(gate.decide(approvalId, "approved"), /ja resolvida: publishing/);
});
