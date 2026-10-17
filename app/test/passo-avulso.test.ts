import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ApprovalGate, type ActionHandler } from "../src/approval/gate.js";
import { AgentSpec } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { Executor } from "../src/executor/executor.js";
import { githubReviewHandler, LOCUM_MARKER, type ReviewClient } from "../src/sources/github.js";
import { PREFIXO_DO_PASSO_AVULSO } from "../src/config/types.js";
import { AgentService } from "../src/services/agent-service.js";
import { PassoAvulsoService } from "../src/services/passo-avulso-service.js";
import { RunService, type StepRunner } from "../src/services/run-service.js";

before(() => {
  migrateDb();
});

type Chamada = Record<string, unknown>;

/** Cliente falso: nada sai para o GitHub. */
function clienteFalso(headAtual = "aaa111", estado = "open") {
  const criadas: Chamada[] = [];
  const fake = {
    rest: {
      pulls: {
        createReview: async (p: Chamada) => (criadas.push(p), {}),
        listReviews: async () => ({ data: [] }),
        get: async () => ({ data: { head: { sha: headAtual }, state: estado, merged: false } }),
      },
    },
  } as unknown as ReviewClient;
  return { fake, criadas };
}

function montarGate(estadoDoPr = "open") {
  const { fake, criadas } = clienteFalso("aaa111", estadoDoPr);
  const automaticas: unknown[] = [];
  const handlers = new Map<string, ActionHandler>([
    ["github.review_comment", githubReviewHandler(() => fake)],
    // Sem `inputSchema`: não é oferecida como avulsa.
    // Esquema sem `additionalProperties: false`: o esquema não barra o alvo, quem barra é o serviço.
    ["teste.solto", { inputSchema: { type: "object", properties: { text: { type: "string" } } }, publish: async () => undefined }],
    ["teste.auto", { publish: async (p) => void automaticas.push(p) }],
    // Declara esquema, mas não aceita `approve`.
    ["teste.so-auto", { modes: ["auto"], inputSchema: { type: "object", properties: {} }, publish: async () => undefined }],
  ]);
  return { gate: new ApprovalGate(handlers), criadas, automaticas };
}

const EVENTO = { repo: "acme/api", repoName: "api", owner: "acme", pull: 7, headSha: "aaa111", changedFiles: [] };

async function montar(opcoes: { status?: string; evento?: Record<string, unknown> | null; arquivada?: boolean } = {}) {
  const agentId = `rev-${randomUUID().slice(0, 8)}`;
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: agentId,
      name: "Revisor",
      steps: [
        { type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt: "revise" },
        { type: "action", key: "revisar", name: "Revisar", action: "github.review_comment", needs: ["ler"] },
        { type: "action", key: "avisar", name: "Avisar", action: "teste.auto", mode: "auto", needs: ["revisar"] },
      ],
    }),
    undefined,
    "human",
  );
  if (opcoes.arquivada === true) await db.update(schema.agents).set({ archivedAt: 1 }).where(eq(schema.agents.id, agentId));
  const eventoId = opcoes.evento === null ? null : randomUUID();
  if (eventoId !== null) {
    await db.insert(schema.events).values({ id: eventoId, source: "github", externalId: eventoId, payload: opcoes.evento ?? EVENTO });
  }
  const runId = randomUUID();
  await db.insert(schema.runs).values({ id: runId, agentVersionId: versao.id, eventId: eventoId, status: opcoes.status ?? "failed", endedAt: 100, costUsd: 1.5 });
  const ids = { ler: randomUUID(), revisar: randomUUID(), avisar: randomUUID() };
  await db.insert(schema.steps).values([
    { id: ids.ler, runId, idx: 0, stepKey: "ler", name: "Ler", status: "done" },
    { id: ids.revisar, runId, idx: 1, stepKey: "revisar", name: "Revisar", status: "skipped" },
    { id: ids.avisar, runId, idx: 2, stepKey: "avisar", name: "Avisar", status: "skipped" },
  ]);
  return { runId, agentId, ids };
}

const APROVAR_SEM_COMENTARIO = { verdict: "APPROVE", summary: "", findings: [] };

const passos = (runId: string) => db.select().from(schema.steps).where(eq(schema.steps.runId, runId)).orderBy(schema.steps.idx);
const pendencias = (runId: string) => db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId));

test("propor grava um passo avulso e uma pendência em approve, com o alvo vindo do evento", async () => {
  const { gate } = montarGate();
  const { runId } = await montar();
  const { approvalId, stepKey } = await new PassoAvulsoService(db, gate).proporAcao(runId, {
    kind: "github.review_comment",
    conteudo: APROVAR_SEM_COMENTARIO,
    derivaDe: "revisar",
  });
  assert.equal(stepKey, "avulso-1");
  const avulso = (await passos(runId)).at(-1)!;
  assert.equal(avulso.stepKey, "avulso-1");
  assert.equal(avulso.origem, "avulso");
  assert.equal(avulso.idx, 3);
  assert.equal(avulso.status, "awaiting_approval");
  assert.deepEqual(avulso.input, { kind: "github.review_comment", conteudo: APROVAR_SEM_COMENTARIO, derivaDe: "revisar", mode: "approve" });
  const [pendencia] = await pendencias(runId);
  assert.equal(pendencia!.id, approvalId);
  assert.equal(pendencia!.status, "pending");
  assert.equal(pendencia!.stepId, avulso.id);
  assert.equal(pendencia!.externalId, `${runId}:${avulso.id}:0`);
  assert.deepEqual(pendencia!.payload, { ...APROVAR_SEM_COMENTARIO, owner: "acme", repo: "api", repoName: "api", pull: 7, headSha: "aaa111" });
});

test("propor de novo numera o seguinte e não mexe no status, no fim nem no custo do run", async () => {
  const { gate } = montarGate();
  const { runId } = await montar();
  const servico = new PassoAvulsoService(db, gate);
  await servico.proporAcao(runId, { kind: "github.review_comment", conteudo: APROVAR_SEM_COMENTARIO });
  const segundo = await servico.proporAcao(runId, { kind: "github.review_comment", conteudo: APROVAR_SEM_COMENTARIO });
  assert.equal(segundo.stepKey, "avulso-2");
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  assert.equal(run!.status, "failed");
  assert.equal(run!.endedAt, 100);
  assert.equal(run!.costUsd, 1.5);
});

test("o conteúdo não escolhe o alvo: campo fora do esquema é recusado e nada é gravado", async () => {
  const { gate } = montarGate();
  const { runId } = await montar();
  await assert.rejects(
    new PassoAvulsoService(db, gate).proporAcao(runId, { kind: "github.review_comment", conteudo: { ...APROVAR_SEM_COMENTARIO, owner: "outra-org", pull: 1 } }),
    /conteudo/,
  );
  assert.equal((await passos(runId)).length, 3);
  assert.equal((await pendencias(runId)).length, 0);
});

test("conteúdo fora do formato do esquema é recusado", async () => {
  const { gate } = montarGate();
  const { runId } = await montar();
  await assert.rejects(new PassoAvulsoService(db, gate).proporAcao(runId, { kind: "github.review_comment", conteudo: { verdict: "TALVEZ", findings: [] } }), /conteudo/);
});

test("ação sem inputSchema, desconhecida ou que não aceita approve não vira avulsa", async () => {
  const { gate } = montarGate();
  const { runId } = await montar();
  const servico = new PassoAvulsoService(db, gate);
  await assert.rejects(servico.proporAcao(runId, { kind: "teste.auto", conteudo: {} }), /avulsa/);
  await assert.rejects(servico.proporAcao(runId, { kind: "nao.existe", conteudo: {} }), /avulsa/);
  await assert.rejects(servico.proporAcao(runId, { kind: "teste.so-auto", conteudo: {} }), /approve/);
  assert.equal((await passos(runId)).length, 3);
});

for (const status of ["queued", "running"]) {
  test(`run ${status} recusa a proposta`, async () => {
    const { gate } = montarGate();
    const { runId } = await montar({ status });
    await assert.rejects(new PassoAvulsoService(db, gate).proporAcao(runId, { kind: "github.review_comment", conteudo: APROVAR_SEM_COMENTARIO }), /em andamento/);
    assert.equal((await passos(runId)).length, 3);
  });
}

test("automação arquivada, run de ensaio e run inexistente recusam", async () => {
  const { gate } = montarGate();
  const servico = new PassoAvulsoService(db, gate);
  const proposta = { kind: "github.review_comment", conteudo: APROVAR_SEM_COMENTARIO };
  const arquivada = await montar({ arquivada: true });
  await assert.rejects(servico.proporAcao(arquivada.runId, proposta), /arquivada/);
  const ensaio = await montar({ evento: { ...EVENTO, semConversa: true } });
  await assert.rejects(servico.proporAcao(ensaio.runId, proposta), /ensaio/);
  await assert.rejects(servico.proporAcao(randomUUID(), proposta), /nao encontrado/);
  assert.equal((await passos(ensaio.runId)).length, 3);
});

test("derivaDe aponta para um passo que o run tem", async () => {
  const { gate } = montarGate();
  const { runId } = await montar();
  await assert.rejects(
    new PassoAvulsoService(db, gate).proporAcao(runId, { kind: "github.review_comment", conteudo: APROVAR_SEM_COMENTARIO, derivaDe: "inventado" }),
    /derivaDe/,
  );
});

test("aprovar o avulso publica só ele: o run falho não retoma e a ação automática a jusante não roda", async () => {
  const { gate, criadas, automaticas } = montarGate();
  const { runId } = await montar();
  const { approvalId } = await new PassoAvulsoService(db, gate).proporAcao(runId, { kind: "github.review_comment", conteudo: APROVAR_SEM_COMENTARIO });
  const executor = new Executor({ mcp: {} as never, runtimes: new Map(), gate, machineId: "m" });

  const { status, run } = await executor.decide(approvalId, "approved");

  assert.equal(status, "approved");
  assert.equal(run, "failed");
  assert.equal(criadas.length, 1);
  assert.equal(criadas[0]!.event, "APPROVE");
  assert.equal(criadas[0]!.commit_id, "aaa111");
  assert.equal(criadas[0]!.owner, "acme");
  const corpo = String(criadas[0]!.body);
  assert.ok(corpo.includes(LOCUM_MARKER));
  assert.equal(corpo.replaceAll(LOCUM_MARKER, "").replace(`<!-- locum:${runId}:${(await passos(runId)).at(-1)!.id}:0 -->`, "").trim(), "");
  assert.deepEqual(automaticas, []);
  const depois = await passos(runId);
  assert.deepEqual(depois.map((p) => [p.stepKey, p.status]), [["ler", "done"], ["revisar", "skipped"], ["avisar", "skipped"], ["avulso-1", "done"]]);
  const [r] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  assert.equal(r!.status, "failed");
  assert.equal(r!.endedAt, 100);
});

test("rejeitar o avulso pula só ele e não retoma o run", async () => {
  const { gate, automaticas } = montarGate();
  const { runId } = await montar();
  const { approvalId } = await new PassoAvulsoService(db, gate).proporAcao(runId, { kind: "github.review_comment", conteudo: APROVAR_SEM_COMENTARIO });
  const { run } = await new Executor({ mcp: {} as never, runtimes: new Map(), gate, machineId: "m" }).decide(approvalId, "rejected");
  assert.equal(run, "failed");
  assert.deepEqual(automaticas, []);
  assert.equal((await passos(runId)).at(-1)!.status, "skipped");
});

function servicoDeRun() {
  const execucoes: string[] = [];
  const runner = { execute: async (id: string) => (execucoes.push(id), "done" as const) } as unknown as StepRunner;
  return { execucoes, service: new RunService(db, async () => runner) };
}

test("rerun_step num passo avulso é recusado com mensagem clara", async () => {
  const { gate } = montarGate();
  const { runId } = await montar();
  await new PassoAvulsoService(db, gate).proporAcao(runId, { kind: "github.review_comment", conteudo: APROVAR_SEM_COMENTARIO });
  const { service, execucoes } = servicoDeRun();
  await assert.rejects(service.rerunStep(runId, "avulso-1"), /avulso/);
  assert.deepEqual(execucoes, []);
});

test("reexecutar o passo de que o avulso deriva expira a pendência dele", async () => {
  const { gate } = montarGate();
  const { runId } = await montar();
  const servico = new PassoAvulsoService(db, gate);
  await servico.proporAcao(runId, { kind: "github.review_comment", conteudo: APROVAR_SEM_COMENTARIO, derivaDe: "revisar" });
  await servico.proporAcao(runId, { kind: "github.review_comment", conteudo: APROVAR_SEM_COMENTARIO, derivaDe: "ler" });
  const { service } = servicoDeRun();
  await service.rerunStep(runId, "revisar");
  const [primeira, segunda] = await pendencias(runId);
  assert.equal(primeira!.status, "expired");
  assert.equal(segunda!.status, "pending", "o que deriva de um passo que não foi reexecutado continua na fila");
});

test("describe expõe o inputSchema só das ações que o declaram", () => {
  const { gate } = montarGate();
  const porKind = Object.fromEntries(gate.describe().map((a) => [a.kind, a.inputSchema]));
  assert.deepEqual((porKind["github.review_comment"] as { required: string[] }).required, ["verdict"]);
  assert.equal(porKind["teste.auto"], undefined);
  assert.equal("owner" in ((porKind["github.review_comment"] as { properties: object }).properties), false, "o alvo não entra no esquema de conteúdo");
});

test("o padrão do esquema vale também para quem propõe pelo serviço: sem achados, a lista vai vazia", async () => {
  const { gate } = montarGate();
  const { runId } = await montar();
  await new PassoAvulsoService(db, gate).proporAcao(runId, { kind: "github.review_comment", conteudo: { verdict: "APPROVE" } });
  assert.deepEqual((await pendencias(runId))[0]!.payload, { verdict: "APPROVE", findings: [], owner: "acme", repo: "api", repoName: "api", pull: 7, headSha: "aaa111" });
});

test("o serviço garante o alvo: chave de alvo no conteúdo é recusada mesmo que o esquema a aceite", async () => {
  const { gate } = montarGate();
  const { runId } = await montar();
  const servico = new PassoAvulsoService(db, gate);
  await assert.rejects(servico.proporAcao(runId, { kind: "teste.solto", conteudo: { text: "x", author: "outra-pessoa" } }), /author/);
  await assert.rejects(servico.proporAcao(runId, { kind: "teste.solto", conteudo: { text: "x", headSha: "ccc333" } }), /headSha/);
  await servico.proporAcao(runId, { kind: "teste.solto", conteudo: { text: "x" } });
});

for (const [rotulo, extra] of [["pausado", {}], ["pausado por orçamento", { error: "budget_exceeded" }]] as const) {
  test(`decidir o avulso num run ${rotulo} não retoma o run`, async () => {
    const { gate } = montarGate();
    const { runId } = await montar({ status: "paused" });
    if (Object.keys(extra).length > 0) await db.update(schema.runs).set(extra).where(eq(schema.runs.id, runId));
    const { approvalId } = await new PassoAvulsoService(db, gate).proporAcao(runId, { kind: "github.review_comment", conteudo: APROVAR_SEM_COMENTARIO });
    const executor = new Executor({ mcp: {} as never, runtimes: new Map(), gate, machineId: "m" });
    executor.execute = async () => {
      throw new Error("execute não devia rodar");
    };
    const { run } = await executor.decide(approvalId, "approved");
    assert.equal(run, "paused");
    assert.equal((await passos(runId)).at(-1)!.status, "done");
    assert.equal((await db.select().from(schema.runs).where(eq(schema.runs.id, runId)))[0]!.status, "paused");
  });
}

test("resolver à mão o avulso parado na publicação fecha só o passo dele", async () => {
  const { gate } = montarGate();
  const { runId } = await montar();
  const { approvalId } = await new PassoAvulsoService(db, gate).proporAcao(runId, { kind: "github.review_comment", conteudo: APROVAR_SEM_COMENTARIO });
  await db.update(schema.approvals).set({ status: "publishing", decidedAt: 1 }).where(eq(schema.approvals.id, approvalId));
  const executor = new Executor({ mcp: {} as never, runtimes: new Map(), gate, machineId: "m" });
  executor.execute = async () => {
    throw new Error("execute não devia rodar");
  };
  const { status, run } = await executor.settleStuck(approvalId, "published");
  assert.deepEqual([status, run], ["approved", "failed"]);
  assert.equal((await passos(runId)).at(-1)!.status, "done");
});

test("avulso derivado que está publicando recusa o rerun, e a pendência dele não é tocada", async () => {
  const { gate } = montarGate();
  const { runId } = await montar();
  const { approvalId } = await new PassoAvulsoService(db, gate).proporAcao(runId, { kind: "github.review_comment", conteudo: APROVAR_SEM_COMENTARIO, derivaDe: "revisar" });
  await db.update(schema.approvals).set({ status: "publishing", decidedAt: 1 }).where(eq(schema.approvals.id, approvalId));
  const { service, execucoes } = servicoDeRun();
  await assert.rejects(service.rerunStep(runId, "revisar"), /esta publicando/);
  assert.deepEqual(execucoes, []);
  assert.equal((await passos(runId)).at(-1)!.status, "awaiting_approval");
});

test("o avulso expirado pelo rerun não reabre por resolver à mão", async () => {
  const { gate } = montarGate();
  const { runId } = await montar();
  const { approvalId } = await new PassoAvulsoService(db, gate).proporAcao(runId, { kind: "github.review_comment", conteudo: APROVAR_SEM_COMENTARIO, derivaDe: "revisar" });
  await servicoDeRun().service.rerunStep(runId, "revisar");
  assert.equal((await passos(runId)).at(-1)!.status, "skipped");
  await assert.rejects(gate.settleStuck(approvalId, "retry"), /nao esta parada/);
  await assert.rejects(gate.settleStuck(approvalId, "published"), /nao esta parada/);
  assert.equal((await pendencias(runId))[0]!.status, "expired");
});

test("a retomada acerta o avulso cuja pendência já foi decidida", async () => {
  const { gate } = montarGate();
  const { runId } = await montar();
  const { approvalId } = await new PassoAvulsoService(db, gate).proporAcao(runId, { kind: "github.review_comment", conteudo: APROVAR_SEM_COMENTARIO });
  await db.update(schema.approvals).set({ status: "approved", output: { state: "published" } }).where(eq(schema.approvals.id, approvalId));
  await new Executor({ mcp: {} as never, runtimes: new Map(), gate, machineId: "m" }).resume([]);
  const avulso = (await passos(runId)).at(-1)!;
  assert.equal(avulso.status, "done");
  assert.deepEqual(avulso.output, { state: "published" });
});

test("o avulso aparece depois dos passos do fluxo e fica fora da contagem do run", async () => {
  const { gate } = montarGate();
  const { runId } = await montar();
  const servico = new PassoAvulsoService(db, gate);
  await servico.proporAcao(runId, { kind: "github.review_comment", conteudo: APROVAR_SEM_COMENTARIO });
  // Um passo do fluxo gravado depois (reexecução, retomada) ainda vem antes do avulso.
  await db.insert(schema.steps).values({ id: randomUUID(), runId, idx: 9, stepKey: "tardio", name: "Tardio", status: "done" });
  const run = new RunService(db, async () => ({}) as StepRunner);
  assert.deepEqual((await run.steps(runId)).map((p) => p.stepKey), ["ler", "revisar", "avisar", "tardio", "avulso-1"]);
  const [resumo] = await run.list({ limit: 200 }).then((l) => l.filter((r) => r.id === runId));
  assert.equal(resumo!.stepTotal, 4);
});

test("a chave avulso- é reservada: nenhum passo do fluxo a usa", () => {
  const passo = { type: "model", key: `${PREFIXO_DO_PASSO_AVULSO}1`, name: "x", model: "a/b", prompt: "p" };
  assert.throws(() => AgentSpec.parse({ id: "x", name: "x", steps: [passo] }), /avulso-/);
});

test("pull request fechado ou mergeado: publicar vira conflito, nada sai", async () => {
  const { gate, criadas } = montarGate("closed");
  const { runId } = await montar();
  const { approvalId } = await new PassoAvulsoService(db, gate).proporAcao(runId, { kind: "github.review_comment", conteudo: APROVAR_SEM_COMENTARIO });
  const { status, motivo } = await gate.decide(approvalId, "approved");
  assert.deepEqual([status, motivo], ["conflict", "publish_conflict:pr_fechado"]);
  assert.equal(criadas.length, 0);
});
