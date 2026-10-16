import { test } from "node:test";
import assert from "node:assert/strict";
import { count, eq } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { slackReplySpec } from "../src/examples/agents.js";
import { schema } from "../src/db/index.js";
import { AgentService } from "../src/services/agent-service.js";
import { AutomationService } from "../src/services/automation-service.js";
import type { ExecutionService } from "../src/services/execution-service.js";
import { TriggerService } from "../src/services/trigger-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/** Excluir a automação: o agent, os gatilhos e o histórico saem juntos, e o resto fica. */

function montar() {
  const db = bancoDeTeste();
  const agents = new AgentService(db);
  const triggers = new TriggerService(db);
  const soltos: unknown[] = [];
  const automations = new AutomationService(agents, triggers, {} as unknown as ExecutionService, undefined, db, async (payload) => {
    soltos.push(payload);
  });
  return { db, agents, triggers, automations, soltos };
}
type Banco = ReturnType<typeof montar>["db"];

const tabela = (db: Banco, t: SQLiteTable): number => db.select({ n: count() }).from(t).get()!.n;

/** Uma automação com gatilho e um run concluído com o histórico inteiro pendurado nele. */
async function semear(m: ReturnType<typeof montar>, agentId: string, runStatus = "done") {
  const { db, automations } = m;
  await automations.save({ spec: { ...slackReplySpec, id: agentId, name: agentId }, triggers: [{ config: { kind: "manual" } }, { config: { kind: "schedule", everyMinutes: 30 } }], note: "", create: true });
  const versao = (await m.agents.getLatestVersion(agentId))!;
  const gatilhos = await m.triggers.list(agentId);
  const gatilho = gatilhos[0]!;
  db.insert(schema.events).values({ id: `ev-run-${agentId}`, source: "github", externalId: `ext-${agentId}`, payload: {} }).run();
  db.insert(schema.runs).values({ id: `run-${agentId}`, agentVersionId: versao.id, triggerId: gatilho.id, eventId: `ev-run-${agentId}`, status: runStatus }).run();
  db.insert(schema.steps).values({ id: `st-${agentId}`, runId: `run-${agentId}`, idx: 0, stepKey: "k", name: "k" }).run();
  db.insert(schema.findings).values({ id: `fi-${agentId}`, runId: `run-${agentId}`, severity: "low", body: "x" }).run();
  db.insert(schema.findingOutcomes).values({ id: `fo-${agentId}`, findingId: `fi-${agentId}`, state: "ignored" }).run();
  db.insert(schema.approvals).values({ id: `ap-${agentId}`, runId: `run-${agentId}`, stepId: `st-${agentId}`, kind: "slack.post", payload: {}, status: "approved" }).run();
  db.insert(schema.agentMetrics).values({ id: `am-${agentId}`, agentVersionId: versao.id, windowStart: 0, windowEnd: 1 }).run();
  db.insert(schema.budgets).values({ id: `bu-${agentId}`, agentId, perDayUsd: 1 }).run();
  for (const source of ["gatilho-descartes", "gatilho-erro", "scheduler", "scheduler-retry"]) {
    db.insert(schema.cursors).values({ source, key: gatilho.id, value: "[]" }).run();
  }
  db.insert(schema.events).values({ id: `ev-man-${agentId}`, source: "manual", externalId: `man-${agentId}`, payload: { automacao: agentId } }).run();
  return { versao, gatilho };
}

const TABELAS = {
  agents: schema.agents,
  agent_versions: schema.agentVersions,
  triggers: schema.triggers,
  runs: schema.runs,
  steps: schema.steps,
  approvals: schema.approvals,
  findings: schema.findings,
  finding_outcomes: schema.findingOutcomes,
  agent_metrics: schema.agentMetrics,
  budgets: schema.budgets,
  cursors: schema.cursors,
  events: schema.events,
};

test("remove apaga a automação com o histórico e devolve as contagens", async () => {
  const m = montar();
  await semear(m, "acme-a");
  const antes = Object.fromEntries(Object.entries(TABELAS).map(([k, t]) => [k, tabela(m.db, t)]));
  assert.equal(antes.agents, 1);
  assert.equal(antes.triggers, 2);
  assert.equal(antes.cursors, 4);
  assert.equal(antes.events, 2);

  assert.deepEqual(await m.automations.remove("acme-a"), { agentId: "acme-a", removed: true, triggers: 2, runs: 1 });

  for (const [nome, tab] of Object.entries(TABELAS)) {
    // o evento do run (github) não é de ensaio e fica; o resto da automação some
    assert.equal(tabela(m.db, tab), nome === "events" ? 1 : 0, nome);
  }
  assert.equal(await m.automations.get("acme-a"), null);
});

test("remove deixa intacto o que não é da automação", async () => {
  const m = montar();
  await semear(m, "acme-a");
  await semear(m, "acme-b");
  m.db.insert(schema.usageDaily).values({ day: "2026-01-01", agentId: "acme-a", costUsd: 3, tokens: 10 }).run();
  m.db.insert(schema.budgets).values({ id: "global", agentId: null, perDayUsd: 9 }).run();
  m.db.insert(schema.events).values({ id: "ev-outro", source: "github", externalId: "outro", payload: { automacao: "acme-a" } }).run();
  m.db.insert(schema.cursors).values({ source: "mcp-poll", key: "acme-a", value: "1" }).run();

  await m.automations.remove("acme-a");

  assert.equal(tabela(m.db, schema.usageDaily), 1);
  assert.equal(m.db.select().from(schema.budgets).where(eq(schema.budgets.id, "global")).all().length, 1);
  assert.equal(m.db.select().from(schema.events).where(eq(schema.events.id, "ev-outro")).all().length, 1);
  assert.equal(m.db.select().from(schema.cursors).where(eq(schema.cursors.source, "mcp-poll")).all().length, 1);
  assert.equal(m.db.select().from(schema.events).where(eq(schema.events.id, "ev-man-acme-b")).all().length, 1);
  assert.equal(tabela(m.db, schema.agents), 1);
  assert.equal(tabela(m.db, schema.runs), 1);
  assert.equal(tabela(m.db, schema.approvals), 1);
  assert.equal(tabela(m.db, schema.triggers), 2);
  assert.equal(tabela(m.db, schema.cursors), 5);
});

test("remove recusa o que não existe, o reservado, e o segundo remove", async () => {
  const m = montar();
  await assert.rejects(m.automations.remove("nao-existe"), /nao cadastrada/);
  m.db.insert(schema.agents).values({ id: "locum-context", name: "contexto" }).run();
  await assert.rejects(m.automations.remove("locum-context"), /agent do sistema/);
  assert.equal(tabela(m.db, schema.agents), 1);
  await semear(m, "acme-a");
  await m.automations.remove("acme-a");
  await assert.rejects(m.automations.remove("acme-a"), /nao cadastrada/);
});

for (const status of ["queued", "running"]) {
  test(`remove recusa com run ${status} e não apaga nada`, async () => {
    const m = montar();
    await semear(m, "acme-a", status);
    await assert.rejects(m.automations.remove("acme-a"), /abra o app/);
    assert.equal(tabela(m.db, schema.agents), 1);
    assert.equal(tabela(m.db, schema.runs), 1);
    assert.equal(tabela(m.db, schema.triggers), 2);
  });
}

for (const [status, dica] of [["pending", /fila de aprovações/], ["publishing", /publicação parada/]] as const) {
  test(`remove recusa com aprovação ${status} e não apaga nada`, async () => {
    const m = montar();
    await semear(m, "acme-a");
    m.db.update(schema.approvals).set({ status }).where(eq(schema.approvals.id, "ap-acme-a")).run();
    await assert.rejects(m.automations.remove("acme-a"), dica);
    assert.equal(tabela(m.db, schema.agents), 1);
    assert.equal(tabela(m.db, schema.approvals), 1);
  });
}

test("a prévia traz as mesmas contagens e os motivos de recusa", async () => {
  const m = montar();
  await semear(m, "acme-a");
  assert.deepEqual(await m.automations.removePreview("acme-a"), { agentId: "acme-a", triggers: 2, runs: 1, blockers: [] });

  m.db.update(schema.approvals).set({ status: "pending" }).where(eq(schema.approvals.id, "ap-acme-a")).run();
  m.db.update(schema.runs).set({ status: "running" }).where(eq(schema.runs.id, "run-acme-a")).run();
  const previa = await m.automations.removePreview("acme-a");
  assert.equal(previa.triggers, 2);
  assert.equal(previa.runs, 1);
  assert.equal(previa.blockers.length, 2);
  assert.match(previa.blockers.join("\n"), /abra o app/);
  assert.match(previa.blockers.join("\n"), /fila de aprovações/);
  await assert.rejects(m.automations.removePreview("nao-existe"), /nao cadastrada/);
});

test("depois do commit solta o 👀 dos eventos que esperavam retentativa", async () => {
  const m = montar();
  await semear(m, "acme-a");
  m.db.insert(schema.events).values({ id: "ev-espera", source: "teams-inbox", externalId: "espera", payload: { chatId: "c1" } }).run();
  m.db.update(schema.cursors).set({ value: JSON.stringify([{ eventId: "ev-espera", since: 1 }]) }).where(eq(schema.cursors.source, "scheduler-retry")).run();

  await m.automations.remove("acme-a");
  assert.deepEqual(m.soltos, [{ chatId: "c1" }]);
});

test("falha ao soltar o 👀 não desfaz nem falha o remove", async () => {
  const m = montar();
  await semear(m, "acme-a");
  m.db.insert(schema.events).values({ id: "ev-espera", source: "teams-inbox", externalId: "espera", payload: {} }).run();
  m.db.update(schema.cursors).set({ value: JSON.stringify([{ eventId: "ev-espera", since: 1 }]) }).where(eq(schema.cursors.source, "scheduler-retry")).run();
  const falho = new AutomationService(m.agents, m.triggers, {} as unknown as ExecutionService, undefined, m.db, async () => {
    throw new Error("graph fora");
  });
  assert.equal((await falho.remove("acme-a")).removed, true);
  assert.equal(tabela(m.db, schema.agents), 0);
});

test("remove de automação que sumiu entre a checagem e a transação recusa como não cadastrada", async () => {
  const m = montar();
  await semear(m, "acme-a");
  const antigo = (await m.agents.get("acme-a"))!;
  await m.automations.remove("acme-a");
  // a checagem de fora ainda enxerga o agent (o outro remove ainda não tinha commitado)
  const agents = Object.create(m.agents) as AgentService;
  agents.get = async () => antigo;
  const automations = new AutomationService(agents, m.triggers, {} as unknown as ExecutionService, undefined, m.db, async () => {});
  await assert.rejects(automations.remove("acme-a"), /nao cadastrada/);
});

test("solta o 👀 do pendente que o scheduler gravou entre a leitura de fora e a transação", async () => {
  const m = montar();
  await semear(m, "acme-a");
  m.db.insert(schema.events).values({ id: "ev-tarde", source: "teams-inbox", externalId: "tarde", payload: { chatId: "c9" } }).run();
  // o scheduler de outro processo grava o pendente depois da leitura de fora e antes do BEGIN IMMEDIATE
  const db = Object.create(m.db) as Banco;
  db.transaction = ((fn: never, opts: never) => {
    m.db.update(schema.cursors).set({ value: JSON.stringify([{ eventId: "ev-tarde", since: 1 }]) }).where(eq(schema.cursors.source, "scheduler-retry")).run();
    return m.db.transaction(fn, opts);
  }) as Banco["transaction"];
  const automations = new AutomationService(m.agents, m.triggers, {} as unknown as ExecutionService, undefined, db, async (payload) => {
    m.soltos.push(payload);
  });
  await automations.remove("acme-a");
  assert.deepEqual(m.soltos, [{ chatId: "c9" }]);
});

test("evento manual da automação usado por run de outra automação fica", async () => {
  const m = montar();
  await semear(m, "acme-a");
  const b = await semear(m, "acme-b");
  m.db.insert(schema.runs).values({ id: "run-b-usa-a", agentVersionId: b.versao.id, triggerId: b.gatilho.id, eventId: "ev-man-acme-a", status: "done" }).run();

  await m.automations.remove("acme-a");

  assert.equal(m.db.select().from(schema.events).where(eq(schema.events.id, "ev-man-acme-a")).all().length, 1);
  assert.equal(m.db.select().from(schema.runs).where(eq(schema.runs.id, "run-b-usa-a")).all().length, 1);
});

test("evento manual da automação usado por run dela sai junto", async () => {
  const m = montar();
  const a = await semear(m, "acme-a");
  m.db.insert(schema.runs).values({ id: "run-a-manual", agentVersionId: a.versao.id, triggerId: a.gatilho.id, eventId: "ev-man-acme-a", status: "done" }).run();

  await m.automations.remove("acme-a");

  assert.equal(m.db.select().from(schema.events).where(eq(schema.events.id, "ev-man-acme-a")).all().length, 0);
});
