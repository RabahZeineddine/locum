import { test } from "node:test";
import assert from "node:assert/strict";
import { count, eq } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { slackReplySpec } from "../src/examples/agents.js";
import { schema } from "../src/db/index.js";
import { InitiativeService } from "../src/services/initiative-service.js";
import { quemUsa } from "../src/services/conexao-uso.js";
import { AgentService } from "../src/services/agent-service.js";
import { ArquivarRecusado, AutomationService } from "../src/services/automation-service.js";
import type { ExecutionService } from "../src/services/execution-service.js";
import { TriggerService } from "../src/services/trigger-service.js";
import { carregarRevisados } from "../src/sources/teams-inbox.js";
import { ESTADO_DO_GATILHO } from "../src/triggers/estado-do-gatilho.js";
import { comTrava } from "../src/triggers/trava.js";
import { bancoDeTeste } from "./helpers/db.js";

/** Arquivar a automação: os gatilhos e o estado deles saem, e o histórico do que foi publicado fica. */

function montar() {
  const db = bancoDeTeste();
  const agents = new AgentService(db);
  const triggers = new TriggerService(db);
  const automations = new AutomationService(agents, triggers, {} as unknown as ExecutionService, undefined, db);
  return { db, agents, triggers, automations };
}
type Montagem = ReturnType<typeof montar>;

const tabela = (db: Montagem["db"], t: SQLiteTable): number => db.select({ n: count() }).from(t).get()!.n;

/** Uma automação com gatilhos e um run concluído com o histórico inteiro pendurado nele. */
async function semear(m: Montagem, agentId: string, runStatus = "done") {
  const { db, automations } = m;
  await automations.save({ spec: { ...slackReplySpec, id: agentId, name: agentId }, triggers: [{ config: { kind: "manual" } }, { config: { kind: "schedule", everyMinutes: 30 } }], note: "", create: true });
  const versao = (await m.agents.getLatestVersion(agentId))!;
  const gatilho = (await m.triggers.list(agentId))[0]!;
  db.insert(schema.events).values({ id: `ev-run-${agentId}`, source: "github", externalId: `ext-${agentId}`, payload: {} }).run();
  db.insert(schema.runs).values({ id: `run-${agentId}`, agentVersionId: versao.id, triggerId: gatilho.id, eventId: `ev-run-${agentId}`, status: runStatus }).run();
  db.insert(schema.steps).values({ id: `st-${agentId}`, runId: `run-${agentId}`, idx: 0, stepKey: "k", name: "k" }).run();
  db.insert(schema.findings).values({ id: `fi-${agentId}`, runId: `run-${agentId}`, severity: "low", body: "x" }).run();
  db.insert(schema.approvals).values({ id: `ap-${agentId}`, runId: `run-${agentId}`, stepId: `st-${agentId}`, kind: "slack.post", payload: {}, status: "approved" }).run();
  db.insert(schema.cursors).values({ source: "scheduler", key: gatilho.id, value: "1" }).run();
  return { versao, gatilho };
}

test("arquivar tira os gatilhos e o estado deles e deixa o histórico, e a automação sai da lista", async () => {
  const m = montar();
  const { gatilho } = await semear(m, "acme-a");
  m.db.insert(schema.settings).values({ key: `teams.account.inbox:${gatilho.id}`, value: "conta" }).run();

  assert.deepEqual(await m.automations.archive("acme-a"), { agentId: "acme-a", archived: true, triggers: 2 });

  assert.equal(tabela(m.db, schema.triggers), 0);
  assert.equal(tabela(m.db, schema.cursors), 0);
  assert.equal(tabela(m.db, schema.settings), 0);
  for (const t of [schema.agents, schema.runs, schema.steps, schema.findings, schema.approvals, schema.agentVersions]) assert.equal(tabela(m.db, t), 1);
  assert.deepEqual((await m.agents.list()).map((a) => a.id), []);
  assert.deepEqual((await m.agents.list({ arquivadas: "so" })).map((a) => a.id), ["acme-a"]);
  assert.equal((await m.automations.get("acme-a"))?.archivedAt !== null, true);
  assert.equal((await m.agents.budgets()).length, 0);
});

test("arquivar apaga o estado de cada forma declarada do gatilho", async () => {
  const m = montar();
  const { gatilho } = await semear(m, "acme-a");
  m.db.delete(schema.cursors).run();
  for (const e of ESTADO_DO_GATILHO) {
    if (e.onde === "cursor") m.db.insert(schema.cursors).values({ source: e.fonte.com === "id" ? `${e.fonte.nome}:${gatilho.id}` : e.fonte.nome, key: e.chave === "id" ? gatilho.id : `channel:T:C:${gatilho.id}`, value: "1" }).run();
    else m.db.insert(schema.settings).values({ key: `${e.chave}:${gatilho.id}`, value: "a" }).run();
  }
  m.db.insert(schema.cursors).values({ source: "github", key: "escopo-da-conexao", value: "fica" }).run();
  await m.automations.archive("acme-a");
  assert.deepEqual(m.db.select().from(schema.cursors).all().map((c) => c.value), ["fica"]);
  assert.equal(tabela(m.db, schema.settings), 0);
});

test("a dedupe de revisados continua vendo a aprovação da automação arquivada", async () => {
  const m = montar();
  await semear(m, "acme-a");
  m.db.update(schema.approvals).set({ kind: "github.review_comment", payload: { owner: "acme", repo: "api", pull: 7, headSha: "abc" } }).where(eq(schema.approvals.id, "ap-acme-a")).run();
  const antes = await carregarRevisados(m.db);
  assert.equal(antes.size > 0, true);
  await m.automations.archive("acme-a");
  assert.deepEqual([...(await carregarRevisados(m.db))], [...antes]);
});

test("desarquivar devolve a automação à lista, sem gatilhos e desligada", async () => {
  const m = montar();
  await semear(m, "acme-a");
  await m.automations.archive("acme-a");
  assert.deepEqual(await m.automations.unarchive("acme-a"), { agentId: "acme-a", archived: false });
  assert.deepEqual((await m.agents.list()).map((a) => [a.id, a.enabled, a.archivedAt]), [["acme-a", false, null]]);
  assert.equal((await m.triggers.list("acme-a")).length, 0);
  await assert.rejects(m.automations.unarchive("acme-a"), /nao esta arquivada/);
});

test("o id da arquivada continua ocupado, e editar, ligar, rodar e criar gatilho nela são recusados", async () => {
  const m = montar();
  await semear(m, "acme-a");
  await m.automations.archive("acme-a");
  const spec = { ...slackReplySpec, id: "acme-a", name: "acme-a" };
  await assert.rejects(m.automations.save({ spec, triggers: [], note: "", create: true }), /arquivada; desarquive/);
  await assert.rejects(m.automations.save({ spec, triggers: [], note: "x" }), /esta arquivada/);
  await assert.rejects(m.automations.setEnabled("acme-a", true), /esta arquivada/);
  await assert.rejects(m.automations.runNow("acme-a"), /esta arquivada/);
  await assert.rejects(m.triggers.set("acme-a", { kind: "manual" }), /esta arquivada/);
  await assert.rejects(m.automations.archive("acme-a"), /ja esta arquivada/);
});

test("recusa o que não existe e o reservado, e não grava nada", async () => {
  const m = montar();
  await assert.rejects(m.automations.archive("nao-existe"), /nao cadastrada/);
  await assert.rejects(m.automations.archivePreview("nao-existe"), /nao cadastrada/);
  m.db.insert(schema.agents).values({ id: "locum-context", name: "contexto" }).run();
  await assert.rejects(m.automations.archive("locum-context"), /agent do sistema/);
});

test("a prévia conta o que sai e o que fica, e os bloqueios vêm estruturados", async () => {
  const m = montar();
  await semear(m, "acme-a");
  assert.deepEqual(await m.automations.archivePreview("acme-a"), { agentId: "acme-a", triggers: 2, runs: 1, approvals: 1, findings: 1, versions: 1, initiative: null, blockers: [] });

  m.db.update(schema.approvals).set({ status: "pending" }).where(eq(schema.approvals.id, "ap-acme-a")).run();
  m.db.update(schema.runs).set({ status: "running" }).where(eq(schema.runs.id, "run-acme-a")).run();
  assert.deepEqual((await m.automations.archivePreview("acme-a")).blockers, [
    { kind: "running", count: 1 },
    { kind: "pending", count: 1 },
  ]);
  m.db.update(schema.approvals).set({ status: "publishing" }).where(eq(schema.approvals.id, "ap-acme-a")).run();
  m.db.update(schema.runs).set({ status: "done" }).where(eq(schema.runs.id, "run-acme-a")).run();
  assert.deepEqual((await m.automations.archivePreview("acme-a")).blockers, [{ kind: "publishing", count: 1 }]);
});

for (const [status, aprovacao, kind] of [["queued", "approved", "running"], ["running", "approved", "running"], ["done", "pending", "pending"], ["done", "publishing", "publishing"]] as const) {
  test(`arquivar com ${kind} (${status}/${aprovacao}) recusa com o bloqueio e não grava nada`, async () => {
    const m = montar();
    await semear(m, "acme-a", status);
    m.db.update(schema.approvals).set({ status: aprovacao }).where(eq(schema.approvals.id, "ap-acme-a")).run();
    await assert.rejects(m.automations.archive("acme-a"), (e: unknown) => e instanceof ArquivarRecusado && e.blockers[0]?.kind === kind);
    assert.equal(tabela(m.db, schema.triggers), 2);
    assert.equal(tabela(m.db, schema.cursors), 1);
    assert.equal((await m.agents.get("acme-a"))?.archivedAt, null);
  });
}

test("a iniciativa aparece na prévia, o vínculo fica, e pelo MCP arquivar é recusado", async () => {
  const m = montar();
  await semear(m, "acme-a");
  m.db.insert(schema.initiatives).values({ id: "ini-1", slug: "plano", title: "Plano", objective: "o", doneCriteria: "c", contextPath: "/tmp/ctx" }).run();
  m.db.update(schema.agents).set({ initiativeId: "ini-1" }).where(eq(schema.agents.id, "acme-a")).run();
  assert.deepEqual((await m.automations.archivePreview("acme-a")).initiative, { slug: "plano", title: "Plano" });

  await assert.rejects(m.automations.archive("acme-a", "agent"), /decisão de uma pessoa, na tela/);
  assert.equal((await m.agents.get("acme-a"))?.archivedAt, null);
  await m.automations.archive("acme-a", "human");
  assert.equal((await m.agents.get("acme-a"))?.initiativeId, "ini-1");
});

test("arquivar espera a batida do gatilho que segura a trava", async () => {
  const m = montar();
  const { gatilho } = await semear(m, "acme-a");
  let solta!: () => void;
  const batida = comTrava(`gatilho:${gatilho.id}`, () => new Promise<void>((r) => (solta = r)));
  let arquivou = false;
  const arquivando = m.automations.archive("acme-a").then(() => (arquivou = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(arquivou, false);
  solta();
  await batida;
  await arquivando;
  assert.equal(arquivou, true);
});

test("a iniciativa marca o agent arquivado, não o conta como ligado e recusa ligar arquivada", async () => {
  const m = montar();
  await semear(m, "acme-a");
  await semear(m, "acme-b");
  m.db.insert(schema.initiatives).values({ id: "ini-1", slug: "plano", title: "Plano", objective: "o", doneCriteria: "c", contextPath: "/tmp/ctx" }).run();
  m.db.update(schema.agents).set({ initiativeId: "ini-1" }).run();
  const iniciativas = new InitiativeService(m.db, { list: async () => [{ config: { name: "srv" } }] } as never);
  await m.automations.archive("acme-a");

  const detalhe = (await iniciativas.detail("plano"))!;
  assert.deepEqual(detalhe.agents.map((a) => [a.id, a.archived]).sort(), [["acme-a", true], ["acme-b", false]]);

  await m.automations.archive("acme-b");
  const semAtivos = (await iniciativas.detail("plano"))!;
  assert.equal(semAtivos.agents.every((a) => a.archived), true);
  // sem agent em uso, a pessoa-ou-agente monta a lista de servidores sem a recusa de "tem agent ligado"
  await assert.doesNotReject(iniciativas.setServers("plano", ["srv"], "agent"));

  await assert.rejects(iniciativas.linkAgent("acme-a", "plano"), /está arquivada/);
  await iniciativas.linkAgent("acme-a", null);
  assert.equal((await m.agents.get("acme-a"))?.initiativeId, null);
});

test("a conexão usada só por automação arquivada continua aparecendo como usada, marcada arquivada", () => {
  const spec = { ...slackReplySpec, id: "acme-a", name: "acme-a", defaultTools: [{ server: "srv", tool: "t" }] } as never;
  const uso = quemUsa("srv", { automacoes: [spec], arquivadas: new Set(["acme-a"]), agents: [], toolsets: [] });
  assert.deepEqual(uso.map((u) => [u.id, u.arquivada]), [["acme-a", true]]);
});

test("arquivar tira do spec as pendências dos gatilhos que saíram, e mantém as dos passos", async () => {
  const m = montar();
  const { gatilho } = await semear(m, "acme-a");
  const base = (await m.agents.getLatestVersion("acme-a"))!.spec;
  const pendentes = [
    { onde: `gatilho:${gatilho.id}`, campo: "owner", motivo: "dono-do-github" },
    { onde: base.steps[0]!.key, campo: "params.destino", motivo: "destino-a-escolher" },
  ];
  await m.agents.saveEdited("acme-a", { ...base, pendentes }, "com pendências");
  await m.automations.archive("acme-a");
  const depois = (await m.agents.getLatestVersion("acme-a"))!.spec.pendentes;
  assert.deepEqual(depois, [pendentes[1]]);
});

test("arquivar sem pendência de gatilho não grava versão nova", async () => {
  const m = montar();
  await semear(m, "acme-a");
  await m.automations.archive("acme-a");
  assert.equal(tabela(m.db, schema.agentVersions), 1);
});

test("gatilho que nasce enquanto o arquivar espera a trava também sai", async () => {
  const m = montar();
  const { gatilho } = await semear(m, "acme-a");
  let solta!: () => void;
  const batida = comTrava(`gatilho:${gatilho.id}`, () => new Promise<void>((r) => (solta = r)));
  const arquivando = m.automations.archive("acme-a");
  await new Promise((r) => setTimeout(r, 20));
  const novo = await m.triggers.set("acme-a", { kind: "schedule", everyMinutes: 60 });
  m.db.insert(schema.cursors).values({ source: "scheduler", key: novo.id, value: "1" }).run();
  solta();
  await batida;
  assert.equal((await arquivando).triggers, 3);
  assert.equal(tabela(m.db, schema.triggers), 0);
  assert.equal(tabela(m.db, schema.cursors), 0);
});

test("arquivar recusado depois da espera pela trava não deixa versão nova nem tira a pendência", async () => {
  const m = montar();
  const { gatilho, versao } = await semear(m, "acme-a");
  const pendentes = [{ onde: `gatilho:${gatilho.id}`, campo: "owner", motivo: "dono-do-github" }];
  const base = (await m.agents.getLatestVersion("acme-a"))!.spec;
  await m.agents.saveEdited("acme-a", { ...base, pendentes }, "com pendência");
  const versoes = tabela(m.db, schema.agentVersions);

  let solta!: () => void;
  const batida = comTrava(`gatilho:${gatilho.id}`, () => new Promise<void>((r) => (solta = r)));
  const arquivando = m.automations.archive("acme-a");
  const recusa = assert.rejects(arquivando, ArquivarRecusado);
  await new Promise((r) => setTimeout(r, 20));
  // Um run entra na fila enquanto o arquivar espera.
  m.db.insert(schema.runs).values({ id: "run-novo", agentVersionId: versao.id, status: "queued" }).run();
  solta();
  await batida;
  await recusa;

  assert.equal(tabela(m.db, schema.agentVersions), versoes);
  assert.deepEqual((await m.agents.getLatestVersion("acme-a"))!.spec.pendentes, pendentes);
});
