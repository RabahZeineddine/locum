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

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

// O modelo leu um diff que pedia para publicar em outro projeto.
const runtimeInjetado: Runtime = {
  id: "native",
  run: async () => ({
    text: "",
    structured: { owner: "vitima", repo: "alheio", pull: 1, headSha: "outro", body: "achados", title: "Revisão" },
    promptTokens: 1,
    completionTokens: 1,
    costUsd: 0,
    billable: false,
    toolsUsed: [],
  }),
};

test("a saída do modelo não troca o destino que o evento traz, só o conteúdo", async () => {
  const agentId = `revisor-${randomUUID()}`;
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: agentId,
      name: "Revisor",
      steps: [
        {
          type: "model",
          key: "ler",
          name: "Ler",
          model: "ollama/modelo",
          prompt: "revise",
          outputSchema: { type: "object" },
        },
        { type: "action", key: "publicar", name: "Publicar", action: "teste.publicar", needs: ["ler"] },
      ],
    }),
    undefined,
    "human",
  );
  const eventId = randomUUID();
  await db.insert(schema.events).values({
    id: eventId,
    source: "github",
    externalId: `pr-${eventId}`,
    payload: { owner: "org", repo: "org/proprio", repoName: "proprio", pull: 42, headSha: "abc", title: "PR do evento" },
  });

  const executor = new Executor({
    mcp: new McpRegistry(new Map()),
    runtimes: new Map([["native", runtimeInjetado]]),
    gate: new ApprovalGate(new Map([["teste.publicar", { publish: async () => {} }]])),
    machineId: "maquina-de-teste",
  });
  const runId = await executor.createRun(versao.id, eventId);
  assert.equal(await executor.execute(runId), "paused");

  const [pendencia] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId));
  const payload = pendencia?.payload as Record<string, unknown>;
  assert.equal(payload.owner, "org");
  assert.equal(payload.repo, "proprio");
  assert.equal(payload.pull, 42);
  assert.equal(payload.headSha, "abc");
  assert.equal(payload.body, "achados");
  assert.equal(payload.title, "Revisão");
});
