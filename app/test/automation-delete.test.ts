import { test } from "node:test";
import assert from "node:assert/strict";
import { count, eq } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { slackReplySpec } from "../src/examples/agents.js";
import { schema } from "../src/db/index.js";
import { AgentService } from "../src/services/agent-service.js";
import { AutomationService, DeletarRecusado } from "../src/services/automation-service.js";
import type { ExecutionService } from "../src/services/execution-service.js";
import { TriggerService } from "../src/services/trigger-service.js";
import { ESTADO_DO_RUN } from "../src/db/estado-do-run.js";
import { ESTADO_DO_GATILHO } from "../src/triggers/estado-do-gatilho.js";
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
  db.insert(schema.runConversations).values({ runId: `run-${agentId}` }).run();
  db.insert(schema.steps).values({ id: `st-${agentId}`, runId: `run-${agentId}`, idx: 0, stepKey: "k", name: "k" }).run();
  db.insert(schema.findings).values({ id: `fi-${agentId}`, runId: `run-${agentId}`, severity: "low", body: "x" }).run();
  db.insert(schema.findingOutcomes).values({ id: `fo-${agentId}`, findingId: `fi-${agentId}`, state: "ignored" }).run();
  db.insert(schema.approvals).values({ id: `ap-${agentId}`, runId: `run-${agentId}`, stepId: `st-${agentId}`, kind: "slack.post", payload: {}, status: "approved" }).run();
  db.insert(schema.agentMetrics).values({ id: `me-${agentId}`, agentVersionId: versao.id, windowStart: 1, windowEnd: 2 }).run();
  db.insert(schema.budgets).values({ id: `bu-${agentId}`, agentId, perDayUsd: 1 }).run();
  db.insert(schema.usageDaily).values({ day: "2026-10-01", agentId, costUsd: 1 }).run();
  return { versao, gatilho };
}

/**
 * Estado preso ao gatilho e ao run, em cada forma que os registros declaram (ESTADO_DO_GATILHO e
 * ESTADO_DO_RUN): a lista vem deles, para o estado novo que alguém declarar entrar aqui sozinho.
 */
function semearEstado(db: Montagem["db"], gatilhoId: string, runId: string): void {
  for (const e of ESTADO_DO_GATILHO) {
    if (e.onde === "cursor") {
      const source = e.fonte.com === "id" ? `${e.fonte.nome}:${gatilhoId}` : e.fonte.nome;
      db.insert(schema.cursors).values({ source, key: e.chave === "id" ? gatilhoId : `channel:T:C:${gatilhoId}`, value: "1" }).onConflictDoNothing().run();
    } else db.insert(schema.settings).values({ key: `${e.chave}:${gatilhoId}`, value: "a" }).onConflictDoNothing().run();
  }
  for (const e of ESTADO_DO_RUN) db.insert(schema.cursors).values({ source: e.fonte, key: runId, value: "1" }).onConflictDoNothing().run();
}

test("deletar a arquivada apaga a automação e tudo que pendia dela, e deixa a outra intacta", async () => {
  const m = montar();
  const a = await semear(m, "acme-a");
  const b = await semear(m, "acme-b");
  semearEstado(m.db, b.gatilho.id, "run-acme-b");
  const cursoresDeB = tabela(m.db, schema.cursors);
  const ajustesDeB = tabela(m.db, schema.settings);
  // arquivar leva os gatilhos; o estado que sobrou preso ao gatilho e ao run (a batida ainda corria) sai no deletar
  await m.automations.archive("acme-a");
  semearEstado(m.db, a.gatilho.id, "run-acme-a");
  assert.ok(tabela(m.db, schema.cursors) > cursoresDeB && tabela(m.db, schema.settings) > ajustesDeB);
  const resultado = await m.automations.delete("acme-a");
  assert.equal(resultado.deleted, true);
  assert.equal(resultado.agentId, "acme-a");

  assert.equal(await m.agents.get("acme-a"), undefined);
  for (const t of [schema.agents, schema.runs, schema.steps, schema.findings, schema.findingOutcomes, schema.approvals, schema.runConversations, schema.agentVersions, schema.budgets, schema.usageDaily, schema.agentMetrics]) {
    assert.equal(tabela(m.db, t), 1, "a outra automação mantém a linha dela");
  }
  assert.equal(tabela(m.db, schema.cursors), cursoresDeB, "o estado de b fica, o de a sai");
  assert.equal(tabela(m.db, schema.settings), ajustesDeB);
  assert.deepEqual(m.db.select({ id: schema.events.id }).from(schema.events).all().map((e) => e.id).sort(), ["ev-man-acme-b", "ev-run-acme-a", "ev-run-acme-b"]);
  assert.equal((await m.triggers.list("acme-b")).length, 2);
  assert.equal((await m.agents.get("acme-b"))?.archivedAt, null);
});

test("deletar apaga o gatilho que ainda existe e o estado dele", async () => {
  const m = montar();
  const { gatilho } = await semear(m, "acme-a");
  m.db.update(schema.agents).set({ archivedAt: 1 }).where(eq(schema.agents.id, "acme-a")).run();
  semearEstado(m.db, gatilho.id, "run-acme-a");
  m.db.insert(schema.cursors).values({ source: "github", key: "escopo-da-conexao", value: "fica" }).run();
  await m.automations.delete("acme-a");
  assert.equal(tabela(m.db, schema.triggers), 0);
  assert.deepEqual(m.db.select().from(schema.cursors).all().map((c) => c.value), ["fica"]);
  assert.equal(tabela(m.db, schema.settings), 0);
});

test("deletar a automação ativa é recusado e não apaga nada", async () => {
  const m = montar();
  await semear(m, "acme-a");
  await assert.rejects(m.automations.delete("acme-a"), (e: unknown) => e instanceof DeletarRecusado && e.blockers.some((b) => b.kind === "active"));
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
    await assert.rejects(m.automations.delete("acme-a"), (e: unknown) => e instanceof DeletarRecusado && e.blockers.some((b) => b.kind === kind));
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
  await assert.rejects(m.automations.delete("acme-a"), /arquive antes|DeletarRecusado|arquivada/i);
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

test("depois do delete nenhuma tabela que referencia a automação, o gatilho ou o run fica com linha órfã, e cada uma delas foi semeada", async () => {
  const m = montar();
  const a = await semear(m, "acme-a");
  const b = await semear(m, "acme-b");
  semearEstado(m.db, b.gatilho.id, "run-acme-b");
  semearEstado(m.db, a.gatilho.id, "run-acme-a");
  await m.automations.archive("acme-a");
  semearEstado(m.db, a.gatilho.id, "run-acme-a");

  const refs = tabelasDaAutomacao(m);
  // Tabela nova que passe a referenciar a automação precisa entrar em `semear` e no delete: o teste acusa aqui.
  const semeadas = ["agent_versions", "triggers", "runs", "run_conversations", "steps", "approvals", "findings", "finding_outcomes", "agent_metrics", "budgets", "usage_daily"];
  const esquecidas = [...new Set(refs.map((r) => r.tabela))].filter((t) => !semeadas.includes(t));
  assert.deepEqual(esquecidas, [], "tabela nova ligada à automação: semeie em `semear` e confira o delete");

  // Os ids que o delete vai levar, tirados antes: a varredura de colunas sem chave estrangeira procura por eles.
  const mortos = new Set(["acme-a", "run-acme-a", a.gatilho.id, ...m.db.select({ id: schema.agentVersions.id }).from(schema.agentVersions).where(eq(schema.agentVersions.agentId, "acme-a")).all().map((v) => v.id)]);
  const vivos = new Set(["acme-b", "run-acme-b", b.gatilho.id]);
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

  // Colunas run_id, trigger_id e automation_id sem chave estrangeira: nenhuma guarda o id de um morto.
  const comFk = new Set(refs.filter((r) => r.pai).map((r) => `${r.tabela}.${r.coluna}`));
  const tabelas = (cliente.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '\\_\\_%' escape '\\'").all() as { name: string }[]).map((t) => t.name);
  for (const t of tabelas) {
    for (const c of cliente.prepare(`select name from pragma_table_info('${t}')`).all() as { name: string }[]) {
      if (!["run_id", "trigger_id", "automation_id"].includes(c.name)) continue;
      const fks = cliente.prepare(`select "from" as coluna from pragma_foreign_key_list('${t}')`).all() as { coluna: string }[];
      if (fks.some((f) => f.coluna === c.name) || comFk.has(`${t}.${c.name}`)) continue;
      const valores = (cliente.prepare(`select distinct "${c.name}" as v from "${t}" where "${c.name}" is not null`).all() as { v: string }[]).map((x) => x.v);
      assert.deepEqual(valores.filter((v) => mortos.has(v)), [], `${t}.${c.name} guarda o id de quem foi deletado`);
    }
  }

  // Estado por gatilho e por run em cursors e settings, e o evento colado à mão: nada de quem morreu, tudo de quem vive.
  const chaves = [...(cliente.prepare("select source, key from cursors").all() as { source: string; key: string }[]).map((c) => c.key), ...(cliente.prepare("select key from settings").all() as { key: string }[]).map((x) => x.key)];
  for (const k of chaves) assert.ok(![...mortos].some((id) => k === id || k.endsWith(`:${id}`)), `estado de quem foi deletado ficou: ${k}`);
  assert.ok(chaves.some((k) => [...vivos].some((id) => k === id || k.endsWith(`:${id}`))), "o estado da outra automação saiu junto");
  const manuais = (cliente.prepare("select payload from events where source = 'manual'").all() as { payload: string }[]).map((e) => (JSON.parse(e.payload) as { automacao: string }).automacao);
  assert.deepEqual(manuais, ["acme-b"]);
});
