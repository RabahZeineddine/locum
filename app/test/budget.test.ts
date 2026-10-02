import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { MockLanguageModelV3 } from "ai/test";
import { ApprovalGate } from "../src/approval/gate.js";
import { AgentSpec } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { today } from "../src/executor/budget.js";
import { Executor } from "../src/executor/executor.js";
import { McpRegistry } from "../src/mcp/registry.js";
import type { ProviderEntry } from "../src/providers/registry.js";
import { NativeRuntime } from "../src/runtimes/native.js";
import type { Runtime } from "../src/runtimes/types.js";
import { AgentService } from "../src/services/agent-service.js";
import { PriceService } from "../src/services/price-service.js";

before(() => {
  migrateDb();
  // Mesmo arranjo do teste de aprovação: o Ollama resolve sem chave, e quem
  // responde é o modelo falso, então nada sai para este endereço.
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

const precos = new PriceService(db);

/** Modelo do AI SDK que responde sempre o mesmo uso, contando as chamadas. */
function modeloFalso(entrada: number, saida: number) {
  const modelo = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: entrada, noCache: entrada, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: saida, text: saida, reasoning: undefined },
      },
      warnings: [],
    }),
  });
  return modelo;
}

/** O runtime nativo de verdade, com o provedor apontando para o modelo falso. */
function runtimeNativo(modelo: MockLanguageModelV3, provedor: string): NativeRuntime {
  const entrada: ProviderEntry = { available: () => true, requires: [], model: () => modelo };
  return new NativeRuntime({ [provedor]: entrada }, precos);
}

async function executorCom(runtime: Runtime) {
  return new Executor({
    mcp: new McpRegistry(new Map()),
    runtimes: new Map([["native", runtime]]),
    gate: new ApprovalGate(new Map([["teste.publicar", { publish: async () => undefined }]])),
    machineId: "maquina-de-teste",
  });
}

async function gravarAgent(steps: unknown[], budget: Record<string, number> = {}) {
  const agentId = `orcado-${randomUUID()}`;
  const versao = await new AgentService().upsert(
    AgentSpec.parse({ id: agentId, name: "Orçado", steps, budget }),
    undefined,
    "human",
  );
  return { agentId, versionId: versao.id };
}

const gastoDoDia = async (agentId: string) =>
  (
    await db
      .select()
      .from(schema.usageDaily)
      .where(and(eq(schema.usageDaily.day, today()), eq(schema.usageDaily.agentId, agentId)))
  )[0];

const passo = async (runId: string, stepKey: string) =>
  (
    await db
      .select()
      .from(schema.steps)
      .where(and(eq(schema.steps.runId, runId), eq(schema.steps.stepKey, stepKey)))
  )[0];

const modelo = (key: string, needs: string[] = []) => ({
  type: "model",
  key,
  name: key,
  model: "ollama/tarifado",
  prompt: "responda",
  needs,
});

test("runtime nativo cobra tokens vezes o preço cadastrado do modelo", async () => {
  const provedor = `prov-${randomUUID()}`;
  await precos.set({ provider: provedor, model: "m", inputUsdPerMtok: 3, outputUsdPerMtok: 15 });
  const runtime = runtimeNativo(modeloFalso(1_000_000, 200_000), provedor);

  const resultado = await runtime.run({ provider: provedor, model: "m", prompt: "oi", tools: {}, maxSteps: 1 });

  assert.equal(resultado.billable, true);
  assert.equal(resultado.priced, true);
  assert.ok(Math.abs(resultado.costUsd - 6) < 1e-9, `custo ${resultado.costUsd}`);
});

test("runtime nativo sem preço cadastrado não inventa custo e avisa que não tem preço", async () => {
  const provedor = `prov-${randomUUID()}`;
  const runtime = runtimeNativo(modeloFalso(1000, 1000), provedor);

  const resultado = await runtime.run({ provider: provedor, model: "m", prompt: "oi", tools: {}, maxSteps: 1 });

  assert.equal(resultado.costUsd, 0);
  assert.equal(resultado.priced, false);
  assert.equal(resultado.promptTokens + resultado.completionTokens, 2000);
});

test("execução que pausa na fila grava o gasto do dia, e a retomada soma só o trecho novo", async () => {
  await precos.set({ provider: "ollama", model: "tarifado", inputUsdPerMtok: 1, outputUsdPerMtok: 1 });
  const { agentId, versionId } = await gravarAgent([
    modelo("ler"),
    { type: "action", key: "publicar", name: "Publicar", action: "teste.publicar", needs: ["ler"] },
    modelo("depois", ["publicar"]),
  ]);
  const executor = await executorCom(runtimeNativo(modeloFalso(500_000, 500_000), "ollama"));

  const runId = await executor.createRun(versionId, null);
  assert.equal(await executor.execute(runId), "paused");

  const pausado = await gastoDoDia(agentId);
  assert.ok(pausado, "pausar tem que gravar o gasto do dia");
  assert.ok(Math.abs(pausado.costUsd - 1) < 1e-9, `gasto ${pausado.costUsd}`);
  assert.equal(pausado.tokens, 1_000_000);
  assert.equal(pausado.runs, 1);

  const [pendencia] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId));
  assert.deepEqual(await executor.decide(pendencia!.id, "approved"), { status: "approved", run: "done" });

  const terminado = await gastoDoDia(agentId);
  assert.ok(Math.abs(terminado!.costUsd - 2) < 1e-9, `gasto ${terminado!.costUsd}`);
  assert.equal(terminado!.tokens, 2_000_000);
  assert.equal(terminado!.runs, 1, "retomar não é execução nova");
});

test("execução que falha grava o gasto do que já rodou", async () => {
  await precos.set({ provider: "ollama", model: "tarifado", inputUsdPerMtok: 1, outputUsdPerMtok: 1 });
  const { agentId, versionId } = await gravarAgent([modelo("ler"), modelo("quebra", ["ler"])]);
  let chamadas = 0;
  const falso = modeloFalso(250_000, 250_000);
  const base = runtimeNativo(falso, "ollama");
  const runtime: Runtime = {
    id: "native",
    run: async (req) => {
      chamadas += 1;
      if (chamadas === 2) throw new Error("provedor caiu");
      return base.run(req);
    },
  };
  const executor = await executorCom(runtime);

  const runId = await executor.createRun(versionId, null);
  assert.equal(await executor.execute(runId), "failed");

  const gasto = await gastoDoDia(agentId);
  assert.ok(gasto, "falhar tem que gravar o gasto do dia");
  assert.ok(Math.abs(gasto.costUsd - 0.5) < 1e-9, `gasto ${gasto.costUsd}`);
});

test("teto baixo em dólar interrompe execução de provedor por chave", async () => {
  await precos.set({ provider: "ollama", model: "tarifado", inputUsdPerMtok: 1, outputUsdPerMtok: 1 });
  const { versionId } = await gravarAgent([modelo("um"), modelo("dois", ["um"])], { perRunUsd: 0.5 });
  const falso = modeloFalso(500_000, 500_000);
  const executor = await executorCom(runtimeNativo(falso, "ollama"));

  const runId = await executor.createRun(versionId, null);
  assert.equal(await executor.execute(runId), "paused");

  assert.equal(falso.doGenerateCalls.length, 1, "o segundo passo não pode chegar ao provedor");
  assert.equal((await passo(runId, "dois"))?.status ?? "pending", "pending");
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  assert.match(run!.error ?? "", /orçamento/);
});

test("teto diário conta o que o dia já gastou em outra execução", async () => {
  await precos.set({ provider: "ollama", model: "tarifado", inputUsdPerMtok: 1, outputUsdPerMtok: 1 });
  const { versionId } = await gravarAgent([modelo("um")], { perDayUsd: 0.9 });
  const falso = modeloFalso(500_000, 500_000);
  const executor = await executorCom(runtimeNativo(falso, "ollama"));

  assert.equal(await executor.execute(await executor.createRun(versionId, null)), "done");
  assert.equal(await executor.execute(await executor.createRun(versionId, null)), "paused");
  assert.equal(falso.doGenerateCalls.length, 1);
});

test("sem preço cadastrado, o teto em tokens interrompe", async () => {
  const { versionId } = await gravarAgent(
    [{ ...modelo("um"), model: "ollama/sem-preco" }, { ...modelo("dois", ["um"]), model: "ollama/sem-preco" }],
    { perRunTokens: 1000 },
  );
  const falso = modeloFalso(800, 400);
  const executor = await executorCom(runtimeNativo(falso, "ollama"));

  const runId = await executor.createRun(versionId, null);
  assert.equal(await executor.execute(runId), "paused");
  assert.equal(falso.doGenerateCalls.length, 1);
});

test("runs simultâneos do mesmo agent veem o gasto um do outro a cada passo", async () => {
  // Gatilho que acha vários eventos abre vários runs de uma vez. Cada um passa
  // no máximo um passo do teto, e não o run inteiro.
  await precos.set({ provider: "ollama", model: "tarifado", inputUsdPerMtok: 1, outputUsdPerMtok: 1 });
  const { agentId, versionId } = await gravarAgent([modelo("um"), modelo("dois", ["um"])], { perDayUsd: 1.5 });
  const falso = modeloFalso(500_000, 500_000);
  const executor = await executorCom(runtimeNativo(falso, "ollama"));

  const runs = await Promise.all([executor.createRun(versionId, null), executor.createRun(versionId, null)]);
  assert.deepEqual(await Promise.all(runs.map((id) => executor.execute(id))), ["paused", "paused"]);
  assert.equal(falso.doGenerateCalls.length, 2);
  const gasto = await gastoDoDia(agentId);
  assert.ok(Math.abs(gasto!.costUsd - 2) < 1e-9, `gasto ${gasto!.costUsd}`);
  assert.equal(gasto!.runs, 2);
});
