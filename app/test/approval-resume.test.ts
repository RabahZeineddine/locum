import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ApprovalGate, STUCK_AFTER_SECONDS, type ActionHandler } from "../src/approval/gate.js";
import { AgentSpec } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { githubReviewHandler, type ReviewClient } from "../src/sources/github.js";
import { Executor, NAO_RODOU } from "../src/executor/executor.js";
import { McpRegistry } from "../src/mcp/registry.js";
import type { Runtime } from "../src/runtimes/types.js";
import { AgentService } from "../src/services/agent-service.js";
import { impressaoDe } from "../src/approval/impressao.js";
import { ApprovalService } from "../src/services/approval-service.js";
import { RunService } from "../src/services/run-service.js";

// O executor e a gate falam com o banco do módulo, e não com um banco passado
// por fora. O `setup.ts` já apontou esse banco para uma pasta temporária; aqui
// ele só recebe o esquema.
before(() => {
  migrateDb();
  // O executor resolve o modelo pelo registro de verdade, que olha o ambiente.
  // O Ollama é o único provedor que fica disponível sem chave; nada sai para
  // esse endereço, porque quem responde é o runtime falso abaixo.
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

/** Pipeline com um passo depois da ação, para provar que ele roda. */
async function montar() {
  const agentId = `revisor-${randomUUID()}`;
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: agentId,
      name: "Revisor",
      steps: [
        { type: "model", key: "ler", name: "Ler", model: "ollama/modelo", prompt: "revise" },
        { type: "action", key: "publicar", name: "Publicar", action: "teste.publicar", needs: ["ler"] },
        {
          type: "model",
          key: "depois",
          name: "Depois",
          model: "ollama/modelo",
          prompt: "resuma",
          needs: ["publicar"],
        },
      ],
    }),
    undefined,
    "human",
  );

  const publicados: string[] = [];
  const handler: ActionHandler = {
    publish: async (_payload, externalId) => {
      publicados.push(externalId);
    },
  };
  const gate = new ApprovalGate(new Map([["teste.publicar", handler]]));
  const executor = new Executor({
    mcp: new McpRegistry(new Map()),
    runtimes: new Map([["native", runtimeFalso]]),
    gate,
    machineId: "maquina-de-teste",
  });

  const runId = await executor.createRun(versao.id, null);
  assert.equal(await executor.execute(runId), "paused");

  const [pendencia] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId));
  assert.ok(pendencia);
  return { runId, approvalId: pendencia.id, gate, executor, publicados };
}

const passo = async (runId: string, stepKey: string) => {
  const [row] = await db
    .select()
    .from(schema.steps)
    .where(and(eq(schema.steps.runId, runId), eq(schema.steps.stepKey, stepKey)));
  return row;
};

const estadoDoRun = async (runId: string) =>
  (await db.select().from(schema.runs).where(eq(schema.runs.id, runId)))[0]?.status;

test("execução aprovada publica uma vez, roda o passo seguinte e termina em done", async () => {
  const { runId, approvalId, executor, publicados } = await montar();

  assert.deepEqual(await executor.decide(approvalId, "approved"), { status: "approved", run: "done" });

  assert.equal(await estadoDoRun(runId), "done");
  assert.equal((await passo(runId, "publicar"))?.status, "done");
  assert.equal((await passo(runId, "depois"))?.status, "done");
  assert.deepEqual(publicados, [`${runId}:${(await passo(runId, "publicar"))!.id}:0`]);
});

test("execução rejeitada sai de paused sem publicar, com a ação pulada", async () => {
  const { runId, approvalId, executor, publicados } = await montar();

  assert.deepEqual(await executor.decide(approvalId, "rejected"), { status: "rejected", run: "done" });

  assert.equal(await estadoDoRun(runId), "done");
  assert.equal((await passo(runId, "publicar"))?.status, "skipped");
  // O que depende da ação recusada não roda: o motivo diz qual passo foi recusado.
  assert.equal((await passo(runId, "depois"))?.status, "skipped");
  assert.equal((await passo(runId, "depois"))?.error, "dependency_rejected:publicar");
  assert.deepEqual(publicados, []);
});

test("decisão tomada direto na gate também deixa o run retomável", async () => {
  // É o caminho de quem decidiu e caiu antes de retomar: a pendência fechou, e
  // o passo tem que refletir a decisão para a retomada não pausar de novo.
  const { runId, approvalId, gate, executor, publicados } = await montar();

  await gate.decide(approvalId, "approved");
  assert.equal((await passo(runId, "publicar"))?.status, "done");

  assert.equal(await executor.execute(runId), "done");
  assert.equal(publicados.length, 1);
});

test("passo parado em aguardando com a pendência já fechada é reconciliado na retomada", async () => {
  // Queda entre fechar a pendência e atualizar o passo. A retomada lê a decisão
  // gravada na pendência, e não publica de novo.
  const { runId, approvalId, executor, publicados } = await montar();

  await db
    .update(schema.approvals)
    .set({ status: "rejected", decidedAt: Math.floor(Date.now() / 1000) })
    .where(eq(schema.approvals.id, approvalId));

  assert.equal(await executor.execute(runId), "done");
  assert.equal((await passo(runId, "publicar"))?.status, "skipped");
  assert.deepEqual(publicados, []);
});

test("pendência ainda aberta continua pausando a retomada", async () => {
  const { runId, executor, publicados } = await montar();

  assert.equal(await executor.execute(runId), "paused");
  assert.equal((await passo(runId, "publicar"))?.status, "awaiting_approval");
  assert.deepEqual(publicados, []);
});

test("dois cliques de aprovar ao mesmo tempo publicam uma vez só", async () => {
  const { runId, approvalId, gate, publicados } = await montar();

  const resultados = await Promise.allSettled([
    gate.decide(approvalId, "approved"),
    gate.decide(approvalId, "approved"),
  ]);

  assert.equal(publicados.length, 1);
  assert.deepEqual(
    resultados.map((r) => r.status).sort(),
    ["fulfilled", "rejected"],
  );
  assert.equal((await passo(runId, "publicar"))?.status, "done");
});

test("publicação que falha devolve a pendência para a fila, e queda no meio pausa a retomada", async () => {
  const { runId, approvalId, gate, executor } = await montar();
  const [linha] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));

  const falha = new ApprovalGate(
    new Map([["teste.publicar", { publish: async () => Promise.reject(new Error("rede")) }]]),
  );
  await assert.rejects(falha.decide(approvalId, "approved"), /rede/);
  const [depois] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
  assert.equal(depois?.status, "pending");
  assert.equal(linha?.status, "pending");

  await db.update(schema.approvals).set({ status: "publishing" }).where(eq(schema.approvals.id, approvalId));
  assert.equal(await executor.execute(runId), "paused");
  await assert.rejects(gate.decide(approvalId, "approved"), /ja resolvida: publishing/);
});

test("pendência parada na publicação aparece, e a pessoa diz se saiu ou volta para a fila", async () => {
  const agora = Math.floor(Date.now() / 1000);
  const parar = (approvalId: string, haSegundos: number) =>
    db
      .update(schema.approvals)
      .set({ status: "publishing", decidedAt: agora - haSegundos })
      .where(eq(schema.approvals.id, approvalId));
  const presas = async () => (await new ApprovalService().listStuck()).map((a) => a.id);

  // Publicação em andamento não conta como parada, e não aceita resolução.
  const saindo = await montar();
  await parar(saindo.approvalId, 5);
  assert.equal((await presas()).includes(saindo.approvalId), false);
  await assert.rejects(saindo.executor.settleStuck(saindo.approvalId, "retry"), /nao esta parada/);

  const saiu = await montar();
  await parar(saiu.approvalId, STUCK_AFTER_SECONDS + 1);
  assert.ok((await presas()).includes(saiu.approvalId));
  assert.deepEqual(await saiu.executor.settleStuck(saiu.approvalId, "published"), { status: "approved", run: "done" });
  assert.equal((await passo(saiu.runId, "depois"))?.status, "done");
  assert.deepEqual(saiu.publicados, []);
  assert.equal((await presas()).includes(saiu.approvalId), false);

  const naoSaiu = await montar();
  await parar(naoSaiu.approvalId, STUCK_AFTER_SECONDS + 1);
  assert.deepEqual(await naoSaiu.executor.settleStuck(naoSaiu.approvalId, "retry"), { status: "pending", run: "paused" });
  assert.deepEqual(await naoSaiu.executor.decide(naoSaiu.approvalId, "approved"), { status: "approved", run: "done" });
  assert.equal(naoSaiu.publicados.length, 1);
});

test("queda entre gravar a pendência e marcar o passo não abre segunda pendência na retomada", async () => {
  const { runId, executor, publicados } = await montar();
  const publicar = (await passo(runId, "publicar"))!;
  await db.update(schema.steps).set({ status: "running" }).where(eq(schema.steps.id, publicar.id));
  // O app caiu: o run ficou `running` e o dono não bate mais.
  await db.update(schema.runs).set({ status: "running", heartbeatAt: null }).where(eq(schema.runs.id, runId));

  assert.ok((await executor.interruptedRuns()).includes(runId));
  await executor.resume([runId]);

  const pendencias = await db.select().from(schema.approvals).where(eq(schema.approvals.stepId, publicar.id));
  assert.equal(pendencias.length, 1);
  assert.equal((await passo(runId, "publicar"))?.status, "awaiting_approval");
  assert.equal(await estadoDoRun(runId), "paused");
  assert.deepEqual(publicados, []);
});

test("reexecutar o passo de ação não deixa a pendência vencida falar pela nova", async () => {
  const { runId, approvalId, executor, publicados } = await montar();
  const runs = new RunService(db, async () => executor);

  assert.equal(await runs.rerunStep(runId, "publicar"), "paused");
  const [antiga] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
  assert.equal(antiga?.status, "expired");

  // A retomada lê a pendência do passo: tem que ser a nova, ainda aberta.
  assert.equal(await executor.execute(runId), "paused");
  assert.equal((await passo(runId, "publicar"))?.status, "awaiting_approval");
  assert.deepEqual(publicados, []);
});

test("reexecução é recusada enquanto a aprovação do passo está saindo", async () => {
  const { runId, approvalId, executor } = await montar();
  await db.update(schema.approvals).set({ status: "publishing" }).where(eq(schema.approvals.id, approvalId));
  const runs = new RunService(db, async () => executor);
  await assert.rejects(runs.rerunStep(runId, "ler"), /esta publicando/);
});

test("reexecutar um passo já publicado abre outra tentativa: o externalId muda e a ação sai de novo", async () => {
  const { runId, approvalId, executor, publicados } = await montar();
  const runs = new RunService(db, async () => executor);
  await executor.decide(approvalId, "approved");
  const publicar = (await passo(runId, "publicar"))!;

  assert.equal(await runs.rerunStep(runId, "publicar"), "paused");
  assert.equal((await passo(runId, "publicar"))!.attempt, publicar.attempt + 1);
  const [nova] = await db
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.stepId, publicar.id), eq(schema.approvals.status, "pending")));
  assert.equal(nova?.externalId, `${runId}:${publicar.id}:1`);

  await executor.decide(nova!.id, "approved");
  assert.deepEqual(publicados, [`${runId}:${publicar.id}:0`, `${runId}:${publicar.id}:1`]);
});

for (const terminal of ["failed", "cancelled"]) {
  test(`decisão sobre run ${terminal} grava a decisão e não retoma o run`, async () => {
    const { runId, approvalId, executor } = await montar();
    await db.insert(schema.steps).values({ id: randomUUID(), runId, idx: 2, stepKey: "depois", name: "Depois", status: "skipped", error: NAO_RODOU });
    await db.update(schema.runs).set({ status: terminal }).where(eq(schema.runs.id, runId));

    const { status, run } = await executor.decide(approvalId, "approved");

    assert.equal(status, "approved");
    assert.equal(run, "failed");
    assert.equal(await estadoDoRun(runId), terminal);
    assert.equal((await passo(runId, "depois"))?.status, "skipped");
  });
}

test("dois executores no mesmo run: só um roda", async () => {
  const { runId, approvalId, gate, executor } = await montar();
  await gate.decide(approvalId, "approved");

  await Promise.all([executor.execute(runId), executor.execute(runId)]);

  assert.equal(await estadoDoRun(runId), "done");
  const depois = await db.select().from(schema.steps).where(and(eq(schema.steps.runId, runId), eq(schema.steps.stepKey, "depois")));
  assert.equal(depois.length, 1);
  assert.equal(depois[0]?.attempt, 1);
});

test("a saída da ação fica gravada na pendência no caminho automático", async () => {
  const gate = new ApprovalGate(new Map([["teste.auto", { publish: async () => undefined } as ActionHandler]]));
  const runId = randomUUID();
  const stepId = randomUUID();
  const versao = await new AgentService().upsert(
    AgentSpec.parse({ id: `a-${randomUUID()}`, name: "A", steps: [{ type: "action", key: "x", name: "X", action: "teste.auto" }] }),
    undefined,
    "human",
  );
  await db.insert(schema.runs).values({ id: runId, agentVersionId: versao.id, status: "running" });
  await db.insert(schema.steps).values({ id: stepId, runId, idx: 0, stepKey: "x", name: "X", status: "running" });

  await gate.submit({ runId, stepId, kind: "teste.auto", payload: {} }, "auto");

  const [pendencia] = await db.select().from(schema.approvals).where(eq(schema.approvals.stepId, stepId));
  assert.deepEqual(pendencia?.output, { state: "published" });
});

test("dada por publicada à mão, a pendência guarda a saída; semResposta vem de o handler declarar outputSchema", async () => {
  const comEsquema: ActionHandler = { publish: async () => undefined, outputSchema: { description: "resposta da ferramenta" } };
  const semEsquema: ActionHandler = { publish: async () => undefined };
  const gate = new ApprovalGate(new Map([["teste.com", comEsquema], ["teste.sem", semEsquema]]));
  for (const [kind, esperado] of [
    ["teste.com", { state: "published", semResposta: true }],
    ["teste.sem", { state: "published" }],
  ] as const) {
    const { runId, stepId } = await passoAguardando();
    await gate.submit({ runId, stepId, kind, payload: {} }, "approve");
    const [p] = await db.select().from(schema.approvals).where(eq(schema.approvals.stepId, stepId));
    await db
      .update(schema.approvals)
      .set({ status: "publishing", decidedAt: Math.floor(Date.now() / 1000) - STUCK_AFTER_SECONDS - 1 })
      .where(eq(schema.approvals.id, p!.id));

    await gate.settleStuck(p!.id, "published");

    const [fechada] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, p!.id));
    assert.deepEqual(fechada?.output, esperado);
    assert.deepEqual((await db.select().from(schema.steps).where(eq(schema.steps.id, stepId)))[0]?.output, esperado);
  }
});

async function passoAguardando() {
  const versao = await new AgentService().upsert(
    AgentSpec.parse({ id: `a-${randomUUID()}`, name: "A", steps: [{ type: "action", key: "x", name: "X", action: "teste.com" }] }),
    undefined,
    "human",
  );
  const runId = randomUUID();
  const stepId = randomUUID();
  await db.insert(schema.runs).values({ id: runId, agentVersionId: versao.id, status: "paused" });
  await db.insert(schema.steps).values({ id: stepId, runId, idx: 0, stepKey: "x", name: "X", status: "awaiting_approval" });
  return { runId, stepId };
}

test("a tentativa sobe uma vez por reexecução: o passo de modelo não soma duas", async () => {
  const { runId, approvalId, executor } = await montar();
  await executor.decide(approvalId, "approved");
  const antes = await passo(runId, "ler");
  const runs = new RunService(db, async () => executor);

  await runs.rerunStep(runId, "ler");

  assert.equal((await passo(runId, "ler"))!.attempt, antes!.attempt + 1);
});

test("passo de ação que falhou depois do POST mantém a tentativa e a marca: reexecutar não duplica", async () => {
  const { runId, executor } = await montar();
  const publicar = (await passo(runId, "publicar"))!;
  await db.update(schema.steps).set({ status: "failed", error: "prazo esgotado" }).where(eq(schema.steps.id, publicar.id));
  await db.update(schema.runs).set({ status: "failed" }).where(eq(schema.runs.id, runId));
  const runs = new RunService(db, async () => executor);

  await runs.rerunStep(runId, "publicar");

  assert.equal((await passo(runId, "publicar"))!.attempt, publicar.attempt);
  const abertas = await db
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.stepId, publicar.id), eq(schema.approvals.status, "pending")));
  assert.equal(abertas[0]?.externalId, `${runId}:${publicar.id}:${publicar.attempt}`);
});

test("review com a cabeça do PR diferente: decide fecha como conflito, pula o passo e não publica", async () => {
  const criadas: unknown[] = [];
  const cliente = {
    rest: {
      pulls: {
        createReview: async (p: unknown) => void criadas.push(p),
        listReviews: async () => ({ data: [] }),
        get: async () => ({ data: { head: { sha: "bbb222" } } }),
      },
    },
  } as unknown as ReviewClient;
  const gate = new ApprovalGate(new Map([["github.review_comment", githubReviewHandler(() => cliente)]]));
  const executor = new Executor({ mcp: new McpRegistry(new Map()), runtimes: new Map([["native", runtimeFalso]]), gate, machineId: "maquina-de-teste" });
  const versao = await new AgentService().upsert(
    AgentSpec.parse({ id: `a-${randomUUID()}`, name: "A", steps: [{ type: "action", key: "x", name: "X", action: "github.review_comment" }] }),
    undefined,
    "human",
  );
  const runId = randomUUID();
  const stepId = randomUUID();
  const eventId = randomUUID();
  await db.insert(schema.events).values({ id: eventId, source: "github", externalId: `pr:${eventId}`, payload: { repo: "acme/api", repoName: "api", owner: "acme", pull: 7, headSha: "aaa111", changedFiles: [] } });
  await db.insert(schema.runs).values({ id: runId, agentVersionId: versao.id, eventId, status: "running" });
  await db.insert(schema.steps).values({ id: stepId, runId, idx: 0, stepKey: "x", name: "X", status: "running" });
  await gate.submit(
    { runId, stepId, kind: "github.review_comment", payload: { owner: "acme", repo: "api", pull: 7, findings: [], verdict: "APPROVE", headSha: "aaa111" } },
    "approve",
  );
  await db.update(schema.steps).set({ status: "awaiting_approval" }).where(eq(schema.steps.id, stepId));
  await db.update(schema.runs).set({ status: "paused" }).where(eq(schema.runs.id, runId));
  const [pendencia] = await db.select().from(schema.approvals).where(eq(schema.approvals.stepId, stepId));

  const resultado = await executor.decide(pendencia!.id, "approved");

  const codigo = "publish_conflict:head_mudou:aaa111:bbb222";
  assert.equal(resultado.status, "conflict");
  assert.equal(resultado.motivo, codigo);
  const [fechada] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, pendencia!.id));
  assert.equal(fechada?.status, "conflict");
  assert.deepEqual(fechada?.output, { conflito: codigo });
  const [feito] = await db.select().from(schema.steps).where(eq(schema.steps.id, stepId));
  assert.equal(feito?.status, "skipped");
  assert.equal(feito?.error, codigo);
  assert.deepEqual(criadas, []);
  assert.equal(await estadoDoRun(runId), "done");
});

test("no automático, a cabeça nova também vira o código do motivo no erro do passo", async () => {
  const cliente = {
    rest: { pulls: { createReview: async () => ({}), listReviews: async () => ({ data: [] }), get: async () => ({ data: { head: { sha: "bbb222" } } }) } },
  } as unknown as ReviewClient;
  const gate = new ApprovalGate(new Map([["github.review_comment", githubReviewHandler(() => cliente)]]));
  const { runId, stepId } = await passoAguardando();
  await assert.rejects(
    gate.submit({ runId, stepId, kind: "github.review_comment", payload: { owner: "acme", repo: "api", pull: 7, findings: [], headSha: "aaa111" } }, "auto"),
    (err: Error) => err.message === "publish_conflict:head_mudou:aaa111:bbb222",
  );
});

test("decisão que chega com o run ainda running não deixa o run parado sem pendência", async () => {
  const publicados: string[] = [];
  const handler: ActionHandler = { publish: async (_p, externalId) => void publicados.push(externalId) };
  // Aprova no instante entre gravar a pendência e o executor pausar o run.
  class GateComClique extends ApprovalGate {
    override async submitComSaida(req: Parameters<ApprovalGate["submitComSaida"]>[0], mode: Parameters<ApprovalGate["submitComSaida"]>[1]) {
      const resultado = await super.submitComSaida(req, mode);
      const [aberta] = await db.select().from(schema.approvals).where(eq(schema.approvals.stepId, req.stepId));
      await this.decide(aberta!.id, "approved");
      return resultado;
    }
  }
  const gate = new GateComClique(new Map([["teste.publicar", handler]]));
  const executor = new Executor({ mcp: new McpRegistry(new Map()), runtimes: new Map([["native", runtimeFalso]]), gate, machineId: "maquina-de-teste" });
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: `a-${randomUUID()}`,
      name: "A",
      steps: [
        { type: "model", key: "ler", name: "Ler", model: "ollama/modelo", prompt: "revise" },
        { type: "action", key: "publicar", name: "Publicar", action: "teste.publicar", needs: ["ler"] },
        { type: "model", key: "depois", name: "Depois", model: "ollama/modelo", prompt: "resuma", needs: ["publicar"] },
      ],
    }),
    undefined,
    "human",
  );
  const runId = await executor.createRun(versao.id, null);

  assert.equal(await executor.execute(runId), "done");

  assert.equal(await estadoDoRun(runId), "done");
  assert.equal(publicados.length, 1);
  assert.equal((await passo(runId, "depois"))?.status, "done");
});

test("decidir com o hash do que a pessoa viu: se a pendência mudou desde então, a decisão é recusada e nada sai", async () => {
  const { runId, approvalId, executor, publicados } = await montar();
  const visto = impressaoDe((await new ApprovalService().get(approvalId))!.payload);
  await db.update(schema.approvals).set({ payload: { texto: "mudou por fora" } }).where(eq(schema.approvals.id, approvalId));

  await assert.rejects(executor.decide(approvalId, "approved", visto), /a pendência mudou desde que você viu/);

  assert.deepEqual(publicados, []);
  assert.equal((await new ApprovalService().get(approvalId))!.status, "pending");
  assert.equal(await estadoDoRun(runId), "paused");
});

test("decidir com o hash atual passa, e sem hash vale como antes", async () => {
  const um = await montar();
  const atual = (await new ApprovalService().get(um.approvalId))!;
  assert.equal(atual.hash, impressaoDe(atual.payload));
  assert.equal((await um.executor.decide(um.approvalId, "approved", atual.hash)).status, "approved");

  const outro = await montar();
  assert.equal((await outro.executor.decide(outro.approvalId, "approved")).status, "approved");
});
