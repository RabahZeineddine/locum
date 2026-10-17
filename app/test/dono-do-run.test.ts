import { before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { eq } from "drizzle-orm";
import { ApprovalGate } from "../src/approval/gate.js";
import { AgentSpec } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { Executor } from "../src/executor/executor.js";
import { McpRegistry } from "../src/mcp/registry.js";
import type { Runtime } from "../src/runtimes/types.js";
import { AgentService } from "../src/services/agent-service.js";

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

const runtime: Runtime = {
  id: "native",
  run: async () => ({ text: "ok", promptTokens: 1, completionTokens: 1, costUsd: 0, billable: false, toolsUsed: [] }),
};

const agora = () => Math.floor(Date.now() / 1000);
/** Um pid que existiu e já saiu: morto de verdade, sem chutar número. */
const pidMorto = () => spawnSync(process.execPath, ["-e", "0"]).pid!;

/** Run que o app deixou em `running`, com o dono que o teste manda. */
async function runEmAndamento(dono: { host: string | null; pid: number | null; batimento: number | null }) {
  const executor = new Executor({ mcp: new McpRegistry(new Map()), runtimes: new Map([["native", runtime]]), gate: new ApprovalGate(new Map()), machineId: "m" });
  const versao = await new AgentService().upsert(
    AgentSpec.parse({ id: `a-${randomUUID()}`, name: "A", steps: [{ type: "model", key: "ler", name: "Ler", model: "ollama/m", prompt: "x" }] }),
    undefined,
    "human",
  );
  const runId = await executor.createRun(versao.id, null);
  await db
    .update(schema.runs)
    .set({ status: "running", ownerHost: dono.host, ownerPid: dono.pid, heartbeatAt: dono.batimento })
    .where(eq(schema.runs.id, runId));
  const estado = async () => (await db.select().from(schema.runs).where(eq(schema.runs.id, runId)))[0]!;
  return { executor, runId, estado };
}

test("running de outro processo vivo, com batimento recente, não é reassumido", async () => {
  const { executor, runId, estado } = await runEmAndamento({ host: hostname(), pid: process.ppid, batimento: agora() });
  await executor.resume([runId]);
  assert.equal((await estado()).status, "running");
  assert.equal((await estado()).ownerPid, process.ppid);
});

test("running de outra máquina com batimento recente também fica com o dono", async () => {
  const { executor, runId, estado } = await runEmAndamento({ host: "outra-maquina", pid: 1, batimento: agora() });
  await executor.resume([runId]);
  assert.equal((await estado()).status, "running");
});

test("running sem batimento recente é reassumido", async () => {
  const { executor, runId, estado } = await runEmAndamento({ host: hostname(), pid: process.ppid, batimento: agora() - 600 });
  await executor.resume([runId]);
  assert.equal((await estado()).status, "done");
});

test("running com pid morto na mesma máquina é reassumido, mesmo com batimento recente", async () => {
  const { executor, runId, estado } = await runEmAndamento({ host: hostname(), pid: pidMorto(), batimento: agora() });
  await executor.resume([runId]);
  assert.equal((await estado()).status, "done");
  assert.equal((await estado()).ownerPid, process.pid);
});

test("running de antes do dono existir (sem batimento) é reassumido", async () => {
  const { executor, runId, estado } = await runEmAndamento({ host: null, pid: null, batimento: null });
  await executor.resume([runId]);
  assert.equal((await estado()).status, "done");
});

test("execute e decide nunca assumem running, nem de dono morto: só a retomada", async () => {
  const { executor, runId, estado } = await runEmAndamento({ host: hostname(), pid: pidMorto(), batimento: agora() - 600 });
  await executor.execute(runId);
  assert.equal((await estado()).status, "running");
});
