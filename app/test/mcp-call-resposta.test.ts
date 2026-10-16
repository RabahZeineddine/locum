import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mcpCallHandler } from "../src/actions/generic.js";
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

/** MCP falso: devolve o que o teste manda e anota a chamada. Nada sobe, nada sai. */
function montar(resposta: unknown) {
  const chamadas: unknown[][] = [];
  const prompts: string[] = [];
  const runtime: Runtime = {
    id: "native",
    run: async (req) => {
      prompts.push(req.prompt);
      return { text: "ok", promptTokens: 1, completionTokens: 1, costUsd: 0, billable: false, toolsUsed: [] };
    },
  };
  const gate = new ApprovalGate(new Map([["mcp.call", mcpCallHandler({ call: async (...a) => (chamadas.push(a), resposta) })]]));
  const executor = new Executor({ mcp: new McpRegistry(new Map()), runtimes: new Map([["native", runtime]]), gate, machineId: "m" });
  return { chamadas, prompts, gate, executor };
}

async function criar(executor: Executor, mode: "auto" | "approve") {
  const agentId = `leitura-${randomUUID()}`;
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: agentId,
      name: "Leitura",
      steps: [
        { type: "action", key: "ler", name: "Ler", action: "mcp.call", mode, params: { server: "s", tool: "get_total", args: {} } },
        { type: "model", key: "resumir", name: "Resumir", needs: ["ler"], model: "ollama/modelo", prompt: "total={{steps.ler.total}} primeiro={{steps.ler.itens.0}}" },
      ],
    }),
    undefined,
    "human",
  );
  const eventId = randomUUID();
  await db.insert(schema.events).values({ id: eventId, source: "manual", externalId: `e-${eventId}`, payload: {} });
  return executor.createRun(versao.id, eventId);
}

const RESPOSTA = { content: [{ type: "text", text: '{"total": 7, "itens": ["alfa", "beta"]}' }] };

test("a leitura em auto alimenta o prompt do passo de IA seguinte, e a saída fica gravada", async () => {
  const { executor, prompts, chamadas } = montar(RESPOSTA);
  const runId = await criar(executor, "auto");
  assert.equal(await executor.execute(runId), "done");
  assert.deepEqual(chamadas, [["s", "get_total", {}]]);
  assert.equal(prompts.at(-1), "total=7 primeiro=alfa");
  const ler = (await db.select().from(schema.steps).where(eq(schema.steps.runId, runId))).find((s) => s.stepKey === "ler");
  assert.deepEqual(ler?.output, { total: 7, itens: ["alfa", "beta"] });
});

test("a escrita aprovada guarda a resposta como saída do passo, e o run segue com ela", async () => {
  const { executor, prompts, gate } = montar(RESPOSTA);
  const runId = await criar(executor, "approve");
  assert.equal(await executor.execute(runId), "paused");
  const [pendencia] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId));
  await gate.decide(pendencia!.id, "approved");
  assert.equal(await executor.execute(runId), "done");
  assert.equal(prompts.at(-1), "total=7 primeiro=alfa");
  const ler = (await db.select().from(schema.steps).where(eq(schema.steps.runId, runId))).find((s) => s.stepKey === "ler");
  assert.deepEqual(ler?.output, { total: 7, itens: ["alfa", "beta"] });
});

test("resposta de ferramenta sem conteúdo mantém a saída { state } de sempre", async () => {
  const { executor } = montar({ content: [] });
  const runId = await criar(executor, "auto");
  await executor.execute(runId);
  const ler = (await db.select().from(schema.steps).where(eq(schema.steps.runId, runId))).find((s) => s.stepKey === "ler");
  assert.deepEqual(ler?.output, { state: "published" });
});
