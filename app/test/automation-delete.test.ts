import { test } from "node:test";
import assert from "node:assert/strict";
import { count, eq } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { slackReplySpec } from "../src/examples/agents.js";
import { schema } from "../src/db/index.js";
import { AgentService } from "../src/services/agent-service.js";
import { AutomationService, ExcluirRecusado } from "../src/services/automation-service.js";
import type { ExecutionService } from "../src/services/execution-service.js";
import { TriggerService } from "../src/services/trigger-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/** Deletar de verdade a automação arquivada: sai tudo que pertence a ela, e nada de outra. */

function montar() {
  const db = bancoDeTeste();
  const agents = new AgentService(db);
  const triggers = new TriggerService(db);
  const automations = new AutomationService(agents, triggers, {} as unknown as ExecutionService, undefined, db);
  return { db, agents, triggers, automations };
}
type Montagem = ReturnType<typeof montar>;

const tabela = (db: Montagem["db"], t: SQLiteTable): number => db.select({ n: count() }).from(t).get()!.n;

/** Uma automação com gatilhos e o histórico inteiro pendurado num run, mais orçamento, gasto e estado de gatilho. */
async function semear(m: Montagem, agentId: string, runStatus = "done") {
  const { db, automations } = m;
  await automations.save({ spec: { ...slackReplySpec, id: agentId, name: agentId }, triggers: [{ config: { kind: "manual" } }, { config: { kind: "schedule", everyMinutes: 30 } }], note: "", create: true });
  const versao = (await m.agents.getLatestVersion(agentId))!;
  const gatilho = (await m.triggers.list(agentId))[0]!;
  db.insert(schema.events).values({ id: `ev-run-${agentId}`, source: "github", externalId: `ext-${agentId}`, payload: {} }).run();
  db.insert(schema.events).values({ id: `ev-man-${agentId}`, source: "manual", externalId: `man-${agentId}`, payload: { automacao: agentId } }).run();
  db.insert(schema.runs).values({ id: `run-${agentId}`, agentVersionId: versao.id, triggerId: gatilho.id, eventId: `ev-run-${agentId}`, status: runStatus }).run();
  db.insert(schema.steps).values({ id: `st-${agentId}`, runId: `run-${agentId}`, idx: 0, stepKey: "k", name: "k" }).run();
  db.insert(schema.findings).values({ id: `fi-${agentId}`, runId: `run-${agentId}`, severity: "low", body: "x" }).run();
  db.insert(schema.findingOutcomes).values({ id: `fo-${agentId}`, findingId: `fi-${agentId}`, state: "ignored" }).run();
  db.insert(schema.approvals).values({ id: `ap-${agentId}`, runId: `run-${agentId}`, stepId: `st-${agentId}`, kind: "slack.post", payload: {}, status: "approved" }).run();
  db.insert(schema.agentMetrics).values({ id: `me-${agentId}`, agentVersionId: versao.id, windowStart: 1, windowEnd: 2 }).run();
  db.insert(schema.budgets).values({ id: `bu-${agentId}`, agentId, perDayUsd: 1 }).run();
  db.insert(schema.usageDaily).values({ day: "2026-10-01", agentId, costUsd: 1 }).run();
  db.insert(schema.cursors).values({ source: "scheduler", key: gatilho.id, value: "1" }).run();
  return { versao, gatilho };
}

test("deletar a arquivada apaga a automação e tudo que pendia dela, e deixa a outra intacta", async () => {
  const m = montar();
  await semear(m, "acme-a");
  await semear(m, "acme-b");
  // arquivar leva os gatilhos e o estado; o gatilho de b fica
  await m.automations.archive("acme-a");
  const resultado = await m.automations.delete("acme-a");
  assert.equal(resultado.deleted, true);
  assert.equal(resultado.agentId, "acme-a");

  assert.equal(await m.agents.get("acme-a"), undefined);
  for (const t of [schema.agents, schema.runs, schema.steps, schema.findings, schema.findingOutcomes, schema.approvals, schema.agentVersions, schema.budgets, schema.usageDaily, schema.agentMetrics]) {
    assert.equal(tabela(m.db, t), 1, "a outra automação mantém a linha dela");
  }
  assert.deepEqual(m.db.select({ id: schema.events.id }).from(schema.events).all().map((e) => e.id).sort(), ["ev-man-acme-b", "ev-run-acme-a", "ev-run-acme-b"]);
  assert.equal((await m.triggers.list("acme-b")).length, 2);
  assert.equal((await m.agents.get("acme-b"))?.archivedAt, null);
});

test("deletar apaga o gatilho que ainda existe e o estado dele", async () => {
  const m = montar();
  const { gatilho } = await semear(m, "acme-a");
  m.db.update(schema.agents).set({ archivedAt: 1 }).where(eq(schema.agents.id, "acme-a")).run();
  m.db.insert(schema.settings).values({ key: `teams.account.inbox:${gatilho.id}`, value: "conta" }).run();
  m.db.insert(schema.cursors).values({ source: "github", key: "escopo-da-conexao", value: "fica" }).run();
  await m.automations.delete("acme-a");
  assert.equal(tabela(m.db, schema.triggers), 0);
  assert.deepEqual(m.db.select().from(schema.cursors).all().map((c) => c.value), ["fica"]);
  assert.equal(tabela(m.db, schema.settings), 0);
});

test("deletar a automação ativa é recusado e não apaga nada", async () => {
  const m = montar();
  await semear(m, "acme-a");
  await assert.rejects(m.automations.delete("acme-a"), (e: unknown) => e instanceof ExcluirRecusado && e.blockers.some((b) => b.kind === "active"));
  assert.equal(tabela(m.db, schema.agents), 1);
  assert.equal(tabela(m.db, schema.runs), 1);
  assert.equal(tabela(m.db, schema.triggers), 2);
});

for (const [status, aprovacao, kind] of [["queued", "approved", "running"], ["running", "approved", "running"], ["done", "publishing", "publishing"]] as const) {
  test(`deletar com ${kind} (${status}/${aprovacao}) é recusado com o bloqueio e não apaga nada`, async () => {
    const m = montar();
    await semear(m, "acme-a", status);
    m.db.update(schema.agents).set({ archivedAt: 1 }).where(eq(schema.agents.id, "acme-a")).run();
    m.db.update(schema.approvals).set({ status: aprovacao }).where(eq(schema.approvals.id, "ap-acme-a")).run();
    await assert.rejects(m.automations.delete("acme-a"), (e: unknown) => e instanceof ExcluirRecusado && e.blockers.some((b) => b.kind === kind));
    assert.equal(tabela(m.db, schema.agents), 1);
    assert.equal(tabela(m.db, schema.runs), 1);
    assert.equal(tabela(m.db, schema.approvals), 1);
  });
}

test("a prévia conta o que sai e os bloqueios vêm estruturados", async () => {
  const m = montar();
  await semear(m, "acme-a");
  assert.deepEqual(await m.automations.deletePreview("acme-a"), {
    agentId: "acme-a",
    archived: false,
    triggers: 2,
    approvals: 1,
    runs: 1,
    findings: 1,
    versions: 1,
    initiative: null,
    blockers: [{ kind: "active", count: 1 }],
  });
  await m.automations.archive("acme-a");
  const arquivada = await m.automations.deletePreview("acme-a");
  assert.deepEqual([arquivada.archived, arquivada.triggers, arquivada.approvals, arquivada.runs, arquivada.versions, arquivada.blockers], [true, 0, 1, 1, 1, []]);

  m.db.update(schema.runs).set({ status: "running" }).where(eq(schema.runs.id, "run-acme-a")).run();
  assert.deepEqual((await m.automations.deletePreview("acme-a")).blockers, [{ kind: "running", count: 1 }]);
});

test("recusa o que não existe e o reservado", async () => {
  const m = montar();
  await assert.rejects(m.automations.delete("nao-existe"), /nao cadastrada/);
  await assert.rejects(m.automations.deletePreview("nao-existe"), /nao cadastrada/);
  m.db.insert(schema.agents).values({ id: "locum-context", name: "contexto", archivedAt: 1 }).run();
  await assert.rejects(m.automations.delete("locum-context"), /agent do sistema/);
});

test("desarquivar em outro processo entre a prévia e o deletar: o deletar confere dentro da transação e recusa", async () => {
  const m = montar();
  await semear(m, "acme-a");
  await m.automations.archive("acme-a");
  const previa = await m.automations.deletePreview("acme-a");
  assert.deepEqual(previa.blockers, []);
  await m.automations.unarchive("acme-a");
  await assert.rejects(m.automations.delete("acme-a"), /arquive antes|ExcluirRecusado|arquivada/i);
  assert.equal(tabela(m.db, schema.agents), 1);
});

test("a biblioteca de agents e o orçamento de outra automação não são tocados", async () => {
  const m = montar();
  await semear(m, "acme-a");
  m.db.insert(schema.agentProfiles).values({ id: "perfil-1", name: "Perfil" } as never).run();
  await m.automations.archive("acme-a");
  await m.automations.delete("acme-a");
  assert.equal(tabela(m.db, schema.agentProfiles), 1);
});

/** Colunas que ligam uma linha à automação, achadas pelo esquema do SQLite, não por uma lista escrita aqui. */
function tabelasDaAutomacao(m: Montagem): { tabela: string; coluna: string; pai: { tabela: string; coluna: string } | null }[] {
  const cliente = m.db.$client;
  const tabelas = (cliente.prepare("select name from sqlite_master where type = 'table' and name not like '\\_\\_%' escape '\\' and name not like 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
  const dono = new Set(["agents"]);
  const achadas: { tabela: string; coluna: string; pai: { tabela: string; coluna: string } | null }[] = [];
  let cresceu = true;
  while (cresceu) {
    cresceu = false;
    for (const t of tabelas) {
      const fks = cliente.prepare(`select "from" as coluna, "table" as pai, "to" as paiColuna from pragma_foreign_key_list('${t}')`).all() as { coluna: string; pai: string; paiColuna: string }[];
      for (const fk of fks) {
        if (dono.has(fk.pai) && !achadas.some((a) => a.tabela === t && a.coluna === fk.coluna)) {
          achadas.push({ tabela: t, coluna: fk.coluna, pai: { tabela: fk.pai, coluna: fk.paiColuna } });
          if (!dono.has(t)) {
            dono.add(t);
            cresceu = true;
          }
        }
      }
    }
  }
  // Colunas sem chave estrangeira que guardam o id da automação pelo nome (`usage_daily.agent_id`, `runs.trigger_id` não: é do gatilho).
  for (const t of tabelas) {
    const colunas = cliente.prepare(`select name from pragma_table_info('${t}')`).all() as { name: string }[];
    for (const c of colunas) if (c.name === "agent_id" && !achadas.some((a) => a.tabela === t && a.coluna === c.name)) achadas.push({ tabela: t, coluna: c.name, pai: null });
  }
  return achadas;
}

test("depois do delete nenhuma tabela que referencia a automação fica com linha órfã, e cada uma delas foi semeada", async () => {
  const m = montar();
  await semear(m, "acme-a");
  await semear(m, "acme-b");
  await m.automations.archive("acme-a");

  const refs = tabelasDaAutomacao(m);
  // Tabela nova que passe a referenciar a automação precisa entrar em `semear` e no delete: o teste acusa aqui.
  const semeadas = ["agent_versions", "triggers", "runs", "steps", "approvals", "findings", "finding_outcomes", "agent_metrics", "budgets", "usage_daily"];
  const esquecidas = [...new Set(refs.map((r) => r.tabela))].filter((t) => !semeadas.includes(t));
  assert.deepEqual(esquecidas, [], "tabela nova ligada à automação: semeie em `semear` e confira o delete");

  await m.automations.delete("acme-a");

  const cliente = m.db.$client;
  for (const r of refs) {
    const orfas = r.pai
      ? (cliente.prepare(`select count(*) as n from "${r.tabela}" where "${r.coluna}" is not null and "${r.coluna}" not in (select "${r.pai.coluna}" from "${r.pai.tabela}")`).get() as { n: number }).n
      : (cliente.prepare(`select count(*) as n from "${r.tabela}" where "${r.coluna}" = ?`).get("acme-a") as { n: number }).n;
    assert.equal(orfas, 0, `${r.tabela}.${r.coluna} ficou com linha órfã`);
    // E a outra automação continua com a linha dela.
    assert.ok((cliente.prepare(`select count(*) as n from "${r.tabela}"`).get() as { n: number }).n > 0, `${r.tabela} perdeu também a linha da outra automação`);
  }
});
