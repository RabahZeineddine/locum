import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ApprovalGate, type ActionHandler } from "../src/approval/gate.js";
import { AgentSpec, type McpServerConfig } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { Executor } from "../src/executor/executor.js";
import { McpRegistry } from "../src/mcp/registry.js";
import type { Runtime } from "../src/runtimes/types.js";
import { AgentService } from "../src/services/agent-service.js";
import { InitiativeService } from "../src/services/initiative-service.js";
import { McpService } from "../src/services/mcp-service.js";

// Mesmo banco do módulo dos outros testes de executor, como approval-resume.test.ts.
before(() => {
  migrateDb();
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

/** Cadastro fisico dos dois servidores, para o `missing()` nunca ser o motivo. */
function registro(): McpRegistry {
  const cfg = (name: string): McpServerConfig =>
    ({ name, transport: "stdio", command: ["true"], scope: "read", idleTimeoutMs: 300_000 }) as McpServerConfig;
  return new McpRegistry(new Map([["srv-a", cfg("srv-a")], ["srv-b", cfg("srv-b")]]));
}

/** Cadastra srv-a e srv-b no cadastro de verdade, que `setServers` valida contra. */
async function cadastrarServidores(): Promise<void> {
  const mcp = new McpService();
  for (const name of ["srv-a", "srv-b"]) {
    if (await mcp.get(name)) continue;
    await mcp.register({ name, transport: "stdio", command: ["true"] });
  }
}

const passo = async (runId: string, stepKey: string) => {
  const [row] = await db
    .select()
    .from(schema.steps)
    .where(and(eq(schema.steps.runId, runId), eq(schema.steps.stepKey, stepKey)));
  return row;
};

const estadoDoRun = async (runId: string) =>
  (await db.select().from(schema.runs).where(eq(schema.runs.id, runId)))[0];

test("agent sem iniciativa executa igual, sem checagem de escopo", async () => {
  const agentId = `agente-${randomUUID()}`;
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: agentId,
      name: "Global",
      steps: [
        {
          type: "model",
          key: "ler",
          name: "Ler",
          model: "ollama/modelo",
          prompt: "revise",
          requiresServers: ["srv-a"],
        },
      ],
    }),
    undefined,
    "human",
  );

  const executor = new Executor({
    mcp: registro(),
    runtimes: new Map([["native", runtimeFalso]]),
    gate: new ApprovalGate(new Map()),
    machineId: "maquina-de-teste",
  });

  const runId = await executor.createRun(versao.id, null);
  assert.equal((await estadoDoRun(runId))?.initiativeId, null);
  assert.equal(await executor.execute(runId), "done");
  assert.equal((await passo(runId, "ler"))?.status, "done");
});

test("passo obrigatorio com servidor fora da iniciativa falha com outside_initiative", async () => {
  const initiatives = new InitiativeService();
  const slug = `frente-${randomUUID()}`;
  await initiatives.upsert({ slug, title: "T", objective: "o", doneCriteria: "d" });
  await cadastrarServidores();
  await initiatives.setServers(slug, ["srv-a"]);

  const agentId = `agente-${randomUUID()}`;
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: agentId,
      name: "Da frente",
      steps: [
        {
          type: "model",
          key: "ler",
          name: "Ler",
          model: "ollama/modelo",
          prompt: "revise",
          requiresServers: ["srv-a"],
        },
      ],
    }),
    undefined,
    "human",
  );
  // Liga enquanto o passo ainda usa so servidor da frente: linkAgent aceita.
  await initiatives.linkAgent(agentId, slug);
  // A frente troca de servidor depois: setServers nao desliga ninguem, so avisa.
  await initiatives.setServers(slug, ["srv-b"]);

  const executor = new Executor({
    mcp: registro(),
    runtimes: new Map([["native", runtimeFalso]]),
    gate: new ApprovalGate(new Map()),
    machineId: "maquina-de-teste",
  });

  const runId = await executor.createRun(versao.id, null);
  const linha = await initiatives.get(slug);
  assert.equal((await estadoDoRun(runId))?.initiativeId, linha!.id);

  assert.equal(await executor.execute(runId), "failed");
  assert.equal((await passo(runId, "ler"))?.status, "failed");
  assert.equal((await passo(runId, "ler"))?.error, "outside_initiative");
});

test("passo opcional com servidor fora da iniciativa e pulado com o mesmo motivo", async () => {
  const initiatives = new InitiativeService();
  const slug = `frente-${randomUUID()}`;
  await initiatives.upsert({ slug, title: "T", objective: "o", doneCriteria: "d" });
  await cadastrarServidores();
  await initiatives.setServers(slug, ["srv-a"]);

  const agentId = `agente-${randomUUID()}`;
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: agentId,
      name: "Da frente opcional",
      steps: [
        {
          type: "model",
          key: "ler",
          name: "Ler",
          model: "ollama/modelo",
          prompt: "revise",
          requiresServers: ["srv-a"],
          optional: true,
        },
      ],
    }),
    undefined,
    "human",
  );
  await initiatives.linkAgent(agentId, slug);
  await initiatives.setServers(slug, ["srv-b"]);

  const executor = new Executor({
    mcp: registro(),
    runtimes: new Map([["native", runtimeFalso]]),
    gate: new ApprovalGate(new Map()),
    machineId: "maquina-de-teste",
  });

  const runId = await executor.createRun(versao.id, null);
  assert.equal(await executor.execute(runId), "done");
  assert.equal((await passo(runId, "ler"))?.status, "skipped");
  assert.equal((await passo(runId, "ler"))?.error, "outside_initiative");
});

test("retomada usa a fotografia do run, nao o agent atual, e a lista de servidores lida de novo", async () => {
  const initiatives = new InitiativeService();
  const slug = `frente-${randomUUID()}`;
  await initiatives.upsert({ slug, title: "T", objective: "o", doneCriteria: "d" });
  await cadastrarServidores();
  await initiatives.setServers(slug, ["srv-a"]);
  const linha = (await initiatives.get(slug))!;

  const agentId = `agente-${randomUUID()}`;
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: agentId,
      name: "Da frente retomavel",
      steps: [
        {
          type: "model",
          key: "ler",
          name: "Ler",
          model: "ollama/modelo",
          prompt: "revise",
          requiresServers: ["srv-a"],
        },
        { type: "action", key: "publicar", name: "Publicar", action: "teste.publicar", needs: ["ler"] },
        {
          type: "model",
          key: "depois",
          name: "Depois",
          model: "ollama/modelo",
          prompt: "resuma",
          needs: ["publicar"],
          requiresServers: ["srv-a"],
          optional: true,
        },
      ],
    }),
    undefined,
    "human",
  );
  await initiatives.linkAgent(agentId, slug);

  const handler: ActionHandler = { publish: async () => undefined };
  const gate = new ApprovalGate(new Map([["teste.publicar", handler]]));
  const executor = new Executor({
    mcp: registro(),
    runtimes: new Map([["native", runtimeFalso]]),
    gate,
    machineId: "maquina-de-teste",
  });

  const runId = await executor.createRun(versao.id, null);
  assert.equal(await executor.execute(runId), "paused");
  assert.equal((await passo(runId, "ler"))?.status, "done");
  assert.equal((await estadoDoRun(runId))?.initiativeId, linha.id);

  // O agent muda ou perde a iniciativa depois: o run já criado não muda.
  await initiatives.linkAgent(agentId, null);
  assert.equal((await estadoDoRun(runId))?.initiativeId, linha.id);

  // Servidor sai da frente entre a pausa e a retomada.
  await initiatives.setServers(slug, []);

  const [pendencia] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId));
  assert.equal(await executor.decide(pendencia!.id, "approved"), "done");

  assert.equal((await passo(runId, "depois"))?.status, "skipped");
  assert.equal((await passo(runId, "depois"))?.error, "outside_initiative");
});
