import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentSpec } from "../src/config/types.js";
import { schema } from "../src/db/index.js";
import { AgentService } from "../src/services/agent-service.js";
import { RunService } from "../src/services/run-service.js";
import type { StepRunner } from "../src/services/run-service.js";
import { bancoDeTeste } from "./helpers/db.js";

async function montar(status: string) {
  const db = bancoDeTeste();
  const versao = await new AgentService(db).upsert(
    AgentSpec.parse({
      id: "revisor",
      name: "Revisor",
      steps: [{ type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt: "revise" }],
    }),
    undefined,
    "human",
  );
  await db.insert(schema.runs).values({ id: "r1", agentVersionId: versao.id, status });
  await db.insert(schema.steps).values({ id: "s1", runId: "r1", idx: 0, stepKey: "ler", name: "Ler", status: "done" });
  const execucoes: string[] = [];
  const runner = { execute: async (id: string) => (execucoes.push(id), "done" as const) } as unknown as StepRunner;
  return { db, execucoes, service: new RunService(db, async () => runner) };
}

for (const status of ["queued", "running"]) {
  test(`run ${status} não é reexecutado por cima do executor que já cuida dele`, async () => {
    const { service, execucoes, db } = await montar(status);
    await assert.rejects(service.rerunStep("r1", "ler"), /em andamento/);
    assert.deepEqual(execucoes, []);
    const [passo] = await db.select().from(schema.steps);
    assert.equal(passo?.status, "done");
  });
}

test("run terminado é reexecutado do passo pedido", async () => {
  const { service, execucoes } = await montar("done");
  assert.equal(await service.rerunStep("r1", "ler"), "done");
  assert.deepEqual(execucoes, ["r1"]);
});
