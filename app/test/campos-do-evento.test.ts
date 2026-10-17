import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ApprovalGate, type ActionHandler } from "../src/approval/gate.js";
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

// O modelo escreve um headSha que o evento não tem: ele leu o diff, não é fonte do commit.
const runtime: Runtime = {
  id: "native",
  run: async () => ({
    text: "",
    structured: { findings: [], headSha: "inventado-pelo-modelo" },
    promptTokens: 1,
    completionTokens: 1,
    costUsd: 0,
    billable: false,
    toolsUsed: [],
  }),
};

async function rodar(acao: string, handler: ActionHandler) {
  const recebidos: Record<string, unknown>[] = [];
  const gate = new ApprovalGate(new Map([[acao, { ...handler, propose: async (p: unknown) => (recebidos.push(p as Record<string, unknown>), p) }]]));
  const executor = new Executor({ mcp: new McpRegistry(new Map()), runtimes: new Map([["native", runtime]]), gate, machineId: "m" });
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: `a-${randomUUID()}`,
      name: "A",
      steps: [
        { type: "model", key: "ler", name: "Ler", model: "ollama/m", prompt: "revise", outputSchema: { type: "object" } },
        { type: "action", key: "publicar", name: "Publicar", action: acao, needs: ["ler"], mode: "approve" },
      ],
    }),
    undefined,
    "human",
  );
  const eventId = randomUUID();
  // O evento não traz headSha.
  await db.insert(schema.events).values({ id: eventId, source: "github", externalId: `pr:${eventId}`, payload: { repo: "acme/api", repoName: "api", owner: "acme", pull: 7, changedFiles: [] } });
  await executor.execute(await executor.createRun(versao.id, eventId));
  return recebidos[0]!;
}

test("campo que o handler declara como do evento: o headSha do modelo é apagado", async () => {
  const payload = await rodar("teste.declara", { publish: async () => undefined, camposDoEvento: ["headSha"] });
  assert.equal(payload.headSha, undefined);
});

test("handler que não declara: o headSha da saída segue intocado", async () => {
  const payload = await rodar("teste.livre", { publish: async () => undefined });
  assert.equal(payload.headSha, "inventado-pelo-modelo");
});
