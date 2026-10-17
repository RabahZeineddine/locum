import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { AgentSpec } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { Executor } from "../src/executor/executor.js";
import { ApprovalGate } from "../src/approval/gate.js";
import { McpRegistry } from "../src/mcp/registry.js";
import type { Runtime } from "../src/runtimes/types.js";
import { AgentService } from "../src/services/agent-service.js";
import { ExecutionService } from "../src/services/execution-service.js";
import { RunService } from "../src/services/run-service.js";

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

const runtimeFalso: Runtime = {
  id: "native",
  run: async () => ({ text: "ok", promptTokens: 1, completionTokens: 1, costUsd: 0, billable: false, toolsUsed: [] }),
};

const executor = () =>
  new Executor({ mcp: new McpRegistry(new Map()), runtimes: new Map([["native", runtimeFalso]]), gate: new ApprovalGate(new Map()), machineId: "m" });

async function montar() {
  const agentId = `arq-${randomUUID().slice(0, 8)}`;
  const agents = new AgentService();
  const versao = await agents.upsert(
    AgentSpec.parse({ id: agentId, name: "A", steps: [{ type: "model", key: "ler", name: "Ler", model: "ollama/modelo", prompt: "x" }] }),
    undefined,
    "human",
  );
  const arquivar = () => db.update(schema.agents).set({ archivedAt: 1 }).where(eq(schema.agents.id, agentId)).run();
  return { agentId, versao, arquivar };
}
const runsDe = (versaoId: string) => db.select().from(schema.runs).where(eq(schema.runs.agentVersionId, versaoId)).all();

test("createRun recusa a automação arquivada e não grava o run", async () => {
  const { versao, arquivar } = await montar();
  arquivar();
  await assert.rejects(executor().createRun(versao.id, null), /esta arquivada/);
  assert.equal(runsDe(versao.id).length, 0);
});

test("run_agent (ExecutionService.start) recusa a arquivada", async () => {
  const { agentId, versao, arquivar } = await montar();
  arquivar();
  const servico = new ExecutionService(db, new AgentService(), async () => executor());
  await assert.rejects(servico.start({ target: "sintetico", agentId, wait: true }), /esta arquivada/);
  assert.equal(runsDe(versao.id).length, 0);
});

test("run_automation_now (startForEvent) recusa a arquivada", async () => {
  const { agentId, versao, arquivar } = await montar();
  arquivar();
  const servico = new ExecutionService(db, new AgentService(), async () => executor());
  await assert.rejects(servico.startForEvent({ agentId, eventId: null, wait: true }), /esta arquivada/);
  assert.equal(runsDe(versao.id).length, 0);
});

test("o run que já existia não retoma depois de arquivada, e fica como estava", async () => {
  const { versao, arquivar } = await montar();
  const ex = executor();
  const runId = await ex.createRun(versao.id, null);
  arquivar();
  await assert.rejects(ex.execute(runId), /esta arquivada/);
  assert.equal(runsDe(versao.id)[0]!.status, "queued");
});

test("rerun_step recusa a arquivada antes de zerar passo nenhum", async () => {
  const { versao, arquivar } = await montar();
  const ex = executor();
  const runId = await ex.createRun(versao.id, null);
  assert.equal(await ex.execute(runId), "done");
  const antes = db.select().from(schema.steps).where(eq(schema.steps.runId, runId)).all();
  arquivar();
  await assert.rejects(new RunService(db, async () => ex).rerunStep(runId, "ler"), /esta arquivada/);
  assert.deepEqual(db.select().from(schema.steps).where(eq(schema.steps.runId, runId)).all(), antes);
});

test("createRun com gatilho que não existe mais recusa e não grava o run", async () => {
  const { versao } = await montar();
  await assert.rejects(executor().createRun(versao.id, null, "gatilho-que-sumiu"), /nao existe mais/);
  assert.equal(runsDe(versao.id).length, 0);
});
