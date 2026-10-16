import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ApprovalGate } from "../src/approval/gate.js";
import { AgentSpec } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { Executor } from "../src/executor/executor.js";
import type { McpRegistry } from "../src/mcp/registry.js";
import type { LimiteLido } from "../src/runtimes/limites-lidos.js";
import type { Runtime, RuntimeRequest } from "../src/runtimes/types.js";
import { AgentService } from "../src/services/agent-service.js";
import { limitesService } from "../src/services/limites-service.js";
import { settingsService } from "../src/services/settings-service.js";

/** Troca por limite dentro do executor: só automático, só com a opção ligada e orçamento no substituto. */

const MAQUINA = "m-limites";

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
  process.env.OPENAI_API_KEY = "chave-falsa";
});
after(() => {
  delete process.env.OPENAI_API_KEY;
});

beforeEach(async () => {
  await settingsService.remove("limites.retrato");
  await settingsService.remove("limites.config");
  await db.delete(schema.modelFallbacks).where(eq(schema.modelFallbacks.machineId, MAQUINA));
});

const registro = { missing: () => [], toolsFor: async () => ({ tools: {}, release: () => undefined }) } as unknown as McpRegistry;

function runtimeQueRegistra(pedidos: RuntimeRequest[]): Runtime {
  return {
    id: "native",
    run: async (req) => {
      pedidos.push(req);
      return { text: "ok", promptTokens: 1, completionTokens: 0, costUsd: 0, billable: true, toolsUsed: [] };
    },
  };
}

async function montar(tipoDoGatilho: "schedule" | "manual" | null) {
  const id = `limite-${randomUUID().slice(0, 8)}`;
  const versao = await new AgentService().upsert(
    AgentSpec.parse({ id, name: "L", steps: [{ type: "model", key: "t", name: "t", model: "ollama/x", prompt: "Resuma." }] }),
    undefined,
    "human",
  );
  let triggerId: string | null = null;
  if (tipoDoGatilho !== null) {
    triggerId = `g-${randomUUID().slice(0, 8)}`;
    await db.insert(schema.triggers).values({ id: triggerId, agentId: id, kind: tipoDoGatilho, config: { kind: tipoDoGatilho }, enabled: true });
  }
  const pedidos: RuntimeRequest[] = [];
  const executor = new Executor({ mcp: registro, runtimes: new Map([["native", runtimeQueRegistra(pedidos)]]), gate: new ApprovalGate(new Map()), machineId: MAQUINA });
  const runId = await executor.createRun(versao.id, null, triggerId);
  return { executor, runId, pedidos };
}

const passo = async (runId: string) => (await db.select().from(schema.steps).where(and(eq(schema.steps.runId, runId), eq(schema.steps.stepKey, "t"))))[0];

const estourado: LimiteLido = { chave: "5h", tipo: "janela", uso: 1, unidade: "%", resetaEm: Math.floor(Date.now() / 1000) + 3600, origem: "assinatura" };

async function ollamaNoLimite(opcoes: { substituto: boolean; orcamento: boolean }) {
  await limitesService.registrar("ollama", [estourado]);
  await db.insert(schema.modelFallbacks).values({ id: randomUUID(), machineId: MAQUINA, fromModel: "ollama/x", toModel: "openai/gpt-y", order: 0 });
  await limitesService.gravarConfig({ usarSubstituto: opcoes.substituto });
  if (opcoes.orcamento) await limitesService.definirOrcamento("openai", { diaUsd: 10 });
}

test("opção ligada e orçamento no substituto: o automático troca, e o passo diz por quê", async () => {
  await ollamaNoLimite({ substituto: true, orcamento: true });
  const { executor, runId, pedidos } = await montar("schedule");
  await executor.execute(runId);
  assert.equal(pedidos[0]?.provider, "openai");
  const p = await passo(runId);
  assert.equal(p?.modelUsed, "openai/gpt-y");
  assert.equal(p?.modelRequested, "ollama/x");
  assert.equal(p?.substitutionReason, "feito com openai/gpt-y por limite do ollama");
});

test("sem orçamento local no substituto, não troca", async () => {
  await ollamaNoLimite({ substituto: true, orcamento: false });
  const { executor, runId, pedidos } = await montar("schedule");
  await executor.execute(runId);
  assert.equal(pedidos[0]?.provider, "ollama");
  assert.equal((await passo(runId))?.substitutionReason, null);
});

test("com a opção desligada (o padrão), não troca", async () => {
  await ollamaNoLimite({ substituto: false, orcamento: true });
  const { executor, runId, pedidos } = await montar("schedule");
  await executor.execute(runId);
  assert.equal(pedidos[0]?.provider, "ollama");
});

test("gatilho manual, run sem gatilho e reexecução de passo pedida por pessoa não trocam", async () => {
  await ollamaNoLimite({ substituto: true, orcamento: true });
  for (const tipo of ["manual", null] as const) {
    const { executor, runId, pedidos } = await montar(tipo);
    await executor.execute(runId);
    assert.equal(pedidos[0]?.provider, "ollama", `gatilho ${tipo}`);
  }
  const { executor, runId, pedidos } = await montar("schedule");
  await executor.execute(runId, { manual: true });
  assert.equal(pedidos[0]?.provider, "ollama", "reexecução manual de um run automático");
});
