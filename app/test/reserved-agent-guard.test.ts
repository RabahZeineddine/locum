import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import { migrateDb, SYSTEM_CONTEXT_AGENT_ID, SYSTEM_CONTEXT_AGENT_VERSION_ID } from "../src/db/migrate.js";
import { AgentService } from "../src/services/agent-service.js";
import { ExecutionService } from "../src/services/execution-service.js";
import { InitiativeService } from "../src/services/initiative-service.js";
import { MetricsService } from "../src/services/metrics-service.js";
import { RunService } from "../src/services/run-service.js";
import { TriggerService } from "../src/services/trigger-service.js";

before(() => {
  migrateDb();
});

test("o agent do sistema fica fora de list, budgets e overview", async () => {
  const agents = new AgentService();
  const lista = await agents.list();
  assert.ok(!lista.some((a) => a.id === SYSTEM_CONTEXT_AGENT_ID));

  const orcamentos = await agents.budgets();
  assert.ok(!orcamentos.some((a) => a.agentId === SYSTEM_CONTEXT_AGENT_ID));

  const overview = await agents.overview();
  assert.ok(!overview.some((a) => a.id === SYSTEM_CONTEXT_AGENT_ID));
});

test("escrita no agent do sistema e recusada em upsert, setBudget, duplicate e exportSpec", async () => {
  const agents = new AgentService();
  const specDoSistema = {
    id: SYSTEM_CONTEXT_AGENT_ID,
    name: "outro nome",
    defaultTools: [],
    skills: [],
    steps: [{ key: "propose", type: "action", action: "context.update", mode: "approve", name: "Update context", needs: [] }],
  };

  await assert.rejects(
    () => agents.upsert(specDoSistema as never, undefined, "human"),
    /sistema e nao aceita escrita/,
  );
  await assert.rejects(() => agents.setBudget(SYSTEM_CONTEXT_AGENT_ID, { perRunUsd: 1 }), /sistema e nao aceita escrita/);
  await assert.rejects(
    () => agents.duplicate(SYSTEM_CONTEXT_AGENT_ID, `copia-${randomUUID()}`, "Copia"),
    /sistema e nao aceita escrita/,
  );
  await assert.rejects(() => agents.exportSpec(SYSTEM_CONTEXT_AGENT_ID), /sistema e nao aceita escrita/);
});

test("gatilho recusa criar e ligar/desligar no agent do sistema", async () => {
  const triggers = new TriggerService();
  await assert.rejects(
    () => triggers.set(SYSTEM_CONTEXT_AGENT_ID, { kind: "schedule", cron: "0 * * * *" } as never),
    /sistema e nao aceita escrita/,
  );

  const [inserido] = await db
    .insert(schema.triggers)
    .values({
      id: randomUUID(),
      agentId: SYSTEM_CONTEXT_AGENT_ID,
      kind: "schedule",
      config: { kind: "schedule", cron: "0 * * * *" },
      enabled: false,
    })
    .returning();
  await assert.rejects(() => triggers.setEnabled(inserido!.id, true), /sistema e nao aceita escrita/);
});

test("execution-service recusa disparar o agent do sistema por id", async () => {
  const execucoes = new ExecutionService();
  await assert.rejects(
    () => execucoes.startForEvent({ agentId: SYSTEM_CONTEXT_AGENT_ID, eventId: null as never }),
    /sistema e nao aceita escrita/,
  );
});

test("rerunStep recusa reexecutar passo de um run do agent do sistema", async () => {
  const initiatives = new InitiativeService();
  const slug = `iniciativa-${randomUUID()}`;
  await initiatives.upsert({ slug, title: "T", objective: "o", doneCriteria: "d" });
  const { approvalId } = await initiatives.proposeContextUpdate({
    slug,
    mode: "append",
    content: "bloco",
    origin: "teste",
  });
  const [aprovacao] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));

  const runs = new RunService();
  await assert.rejects(() => runs.rerunStep(aprovacao!.runId, "propose"), /sistema e nao aceita escrita/);
});

test("metrics exclui o agent do sistema de aggregate, byVersion e usage", async () => {
  const metrics = new MetricsService();
  const agregado = await metrics.aggregate();
  assert.ok(!agregado.some((m) => m.agentId === SYSTEM_CONTEXT_AGENT_ID));

  const porVersao = await metrics.byVersion();
  assert.ok(!porVersao.some((m) => m.agentId === SYSTEM_CONTEXT_AGENT_ID));

  const uso = await metrics.usage();
  assert.ok(!uso.some((u) => u.agentId === SYSTEM_CONTEXT_AGENT_ID));
});

test("a versao do agent do sistema existe com o id fixo esperado", async () => {
  const [versao] = await db
    .select()
    .from(schema.agentVersions)
    .where(eq(schema.agentVersions.id, SYSTEM_CONTEXT_AGENT_VERSION_ID));
  assert.ok(versao);
  assert.equal(versao.agentId, SYSTEM_CONTEXT_AGENT_ID);
});
