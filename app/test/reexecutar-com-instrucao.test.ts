import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ApprovalGate, type ActionHandler } from "../src/approval/gate.js";
import { REBAIXADO_NA_REEXECUCAO } from "../src/config/rebaixado.js";
import { LIMITE_DA_INSTRUCAO } from "../src/services/run-service.js";
import { AgentSpec } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { Executor } from "../src/executor/executor.js";
import { McpRegistry } from "../src/mcp/registry.js";
import type { Runtime } from "../src/runtimes/types.js";
import { AgentService } from "../src/services/agent-service.js";
import { RunService } from "../src/services/run-service.js";

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

/** Runtime falso: guarda o prompt de cada chamada e nunca sai da máquina. */
function montar() {
  const prompts: { passo: string; prompt: string; system: string }[] = [];
  const runtime: Runtime = {
    id: "native",
    run: async (req) => {
      prompts.push({ passo: req.prompt.split(" ")[0]!, prompt: req.prompt, system: req.system ?? "" });
      return { text: "ok", promptTokens: 1, completionTokens: 1, costUsd: 0, billable: false, toolsUsed: [] };
    },
  };
  const publicados: string[] = [];
  const rascunhos: string[] = [];
  const handler: ActionHandler = {
    publish: async (_p, externalId) => void publicados.push(externalId),
    draft: async (_p, externalId) => void rascunhos.push(externalId),
  };
  const gate = new ApprovalGate(new Map([["teste.publicar", handler]]));
  const executor = new Executor({
    mcp: new McpRegistry(new Map()),
    runtimes: new Map([["native", runtime]]),
    gate,
    machineId: "maquina-de-teste",
  });
  return { prompts, publicados, rascunhos, executor, service: new RunService(db, async () => executor) };
}

/** revisar (modelo) -> publicar (ação em auto) -> resumir (modelo); `solto` não depende de nada. */
async function preparar() {
  const ctx = montar();
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: `revisor-${randomUUID()}`,
      name: "Revisor",
      steps: [
        { type: "model", key: "revisar", name: "Revisar", model: "ollama/modelo", prompt: "revisar o pull request" },
        { type: "action", key: "publicar", name: "Publicar", action: "teste.publicar", mode: "auto", needs: ["revisar"] },
        { type: "model", key: "resumir", name: "Resumir", model: "ollama/modelo", prompt: "resumir tudo", needs: ["publicar"] },
        { type: "model", key: "solto", name: "Solto", model: "ollama/modelo", prompt: "solto sem dependencia" },
      ],
    }),
    undefined,
    "human",
  );
  const runId = await ctx.executor.createRun(versao.id, null);
  assert.equal(await ctx.executor.execute(runId), "done");
  ctx.prompts.length = 0;
  ctx.publicados.length = 0;
  return { ...ctx, runId };
}

const passo = async (runId: string, stepKey: string) =>
  (await db.select().from(schema.steps).where(and(eq(schema.steps.runId, runId), eq(schema.steps.stepKey, stepKey))))[0]!;

test("a instrução entra no prompt do passo reexecutado e em nenhum outro", async () => {
  const { service, runId, prompts, executor } = await preparar();
  await service.rerunStep(runId, "revisar", { wait: true, instrucao: "olhe o tratamento de erro" });
  // A ação a jusante espera na Fila; aprovar retoma o run e roda o passo seguinte.
  const [pendencia] = await db.select().from(schema.approvals).where(and(eq(schema.approvals.runId, runId), eq(schema.approvals.status, "pending")));
  assert.equal((await executor.decide(pendencia!.id, "approved")).run, "done");

  const doRevisar = prompts.find((p) => p.prompt.startsWith("revisar"));
  assert.ok(doRevisar);
  assert.ok(doRevisar?.prompt.includes("olhe o tratamento de erro"));
  assert.ok(doRevisar.prompt.indexOf("revisar o pull request") < doRevisar.prompt.indexOf("olhe o tratamento de erro"));
  const dosOutros = prompts.filter((p) => !p.prompt.startsWith("revisar"));
  assert.ok(dosOutros.length > 0);
  assert.ok(dosOutros.every((p) => !p.prompt.includes("olhe o tratamento de erro")));
  assert.equal((await passo(runId, "revisar")).instrucao, "olhe o tratamento de erro");
  assert.equal((await passo(runId, "resumir")).instrucao, null);
});

test("a instrução entra numa moldura de marca aleatória que o system declara como pedido da pessoa", async () => {
  const { service, runId, prompts } = await preparar();
  await service.rerunStep(runId, "revisar", { wait: true, instrucao: "mais um ponto" });
  const chamada = prompts.find((p) => p.prompt.startsWith("revisar"))!;
  const marca = /<(instrucao-[0-9a-f]+)>\nmais um ponto\n<\/\1>$/.exec(chamada.prompt)?.[1];
  assert.ok(marca, "a instrução vem entre marcas no fim do prompt");
  assert.ok(chamada.system.includes(marca), "o system cita a marca");

  prompts.length = 0;
  await service.rerunStep(runId, "revisar", { wait: true, instrucao: "mais um ponto" });
  const outra = /<(instrucao-[0-9a-f]+)>/.exec(prompts.find((p) => p.prompt.startsWith("revisar"))!.prompt)?.[1];
  assert.notEqual(outra, marca, "a marca muda a cada renderização");
});

test("instrução acima do limite é recusada com o número", async () => {
  const { service, runId } = await preparar();
  await assert.rejects(service.rerunStep(runId, "revisar", { wait: true, instrucao: "x".repeat(LIMITE_DA_INSTRUCAO + 1) }), new RegExp(String(LIMITE_DA_INSTRUCAO)));
  assert.equal((await passo(runId, "revisar")).status, "done");
});

test("com instrução, a ação a jusante em auto vai para a Fila e o passo fica marcado", async () => {
  const { service, runId, publicados } = await preparar();
  assert.equal(await service.rerunStep(runId, "revisar", { wait: true, instrucao: "olhe o erro" }), "paused");

  assert.deepEqual(publicados, []);
  const publicar = await passo(runId, "publicar");
  assert.equal(publicar.status, "awaiting_approval");
  assert.equal(publicar.rebaixado, REBAIXADO_NA_REEXECUCAO);
  const [pendencia] = await db.select().from(schema.approvals).where(and(eq(schema.approvals.stepId, publicar.id), eq(schema.approvals.status, "pending")));
  assert.ok(pendencia);
});

test("sem instrução, a ação a jusante continua em auto", async () => {
  const { service, runId, publicados } = await preparar();
  assert.equal(await service.rerunStep(runId, "revisar", { wait: true }), "done");
  assert.equal(publicados.length, 1);
  assert.equal((await passo(runId, "publicar")).rebaixado, null);
});

test("reexecutar de novo sem instrução limpa a instrução e o rebaixamento", async () => {
  const { service, runId } = await preparar();
  await service.rerunStep(runId, "revisar", { wait: true, instrucao: "olhe o erro" });
  await service.rerunStep(runId, "revisar", { wait: true });
  assert.equal((await passo(runId, "revisar")).instrucao, null);
  assert.equal((await passo(runId, "publicar")).rebaixado, null);
});

test("a prévia lista os passos que voltam a rodar e as ações que vão para a Fila", async () => {
  const { service, runId } = await preparar();
  const com = await service.rerunPreview(runId, "revisar", { comInstrucao: true });
  assert.deepEqual(com.passos.map((p) => p.stepKey), ["revisar", "publicar", "resumir"]);
  assert.deepEqual(com.rebaixados.map((p) => p.stepKey), ["publicar"]);
  assert.equal(com.rebaixados[0]?.action, "teste.publicar");

  const sem = await service.rerunPreview(runId, "revisar", { comInstrucao: false });
  assert.deepEqual(sem.passos.map((p) => p.stepKey), ["revisar", "publicar", "resumir"]);
  assert.deepEqual(sem.rebaixados, []);

  const folha = await service.rerunPreview(runId, "solto", { comInstrucao: true });
  assert.deepEqual(folha.passos.map((p) => p.stepKey), ["solto"]);
});

test("instrução em passo que não é de modelo é recusada, na prévia e na reexecução", async () => {
  const { service, runId, publicados } = await preparar();
  await assert.rejects(service.rerunStep(runId, "publicar", { wait: true, instrucao: "x" }), /passo de modelo/);
  await assert.rejects(service.rerunPreview(runId, "publicar", { comInstrucao: true }), /passo de modelo/);
  assert.deepEqual(publicados, []);
  assert.equal((await passo(runId, "publicar")).status, "done");
});

test("instrução em branco conta como sem instrução", async () => {
  const { service, runId, publicados } = await preparar();
  assert.equal(await service.rerunStep(runId, "revisar", { wait: true, instrucao: "   " }), "done");
  assert.equal(publicados.length, 1);
  assert.equal((await passo(runId, "revisar")).instrucao, null);
});

const pendenciaAberta = async (runId: string) =>
  (await db.select().from(schema.approvals).where(and(eq(schema.approvals.runId, runId), eq(schema.approvals.status, "pending"))))[0];

/** M1 -> A(approve) -> M2 -> B(auto): o run para em A, e M2 e B ainda não têm linha. */
async function pausadoNoMeio() {
  const ctx = montar();
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: `meio-${randomUUID()}`,
      name: "Meio",
      steps: [
        { type: "model", key: "m1", name: "M1", model: "ollama/modelo", prompt: "m1 primeiro" },
        { type: "action", key: "a", name: "A", action: "teste.publicar", mode: "approve", needs: ["m1"] },
        { type: "model", key: "m2", name: "M2", model: "ollama/modelo", prompt: "m2 segundo", needs: ["a"] },
        { type: "action", key: "b", name: "B", action: "teste.publicar", mode: "auto", needs: ["m2"] },
      ],
    }),
    undefined,
    "human",
  );
  const runId = await ctx.executor.createRun(versao.id, null);
  assert.equal(await ctx.executor.execute(runId), "paused");
  ctx.prompts.length = 0;
  return { ...ctx, runId };
}

test("run pausado: reexecutar M1 com instrução e aprovar A manda B, que ainda não tinha linha, para a Fila", async () => {
  const { service, executor, runId, publicados } = await pausadoNoMeio();
  assert.equal(await service.rerunStep(runId, "m1", { wait: true, instrucao: "olhe o erro" }), "paused");
  assert.equal((await executor.decide((await pendenciaAberta(runId))!.id, "approved")).run, "paused");

  assert.equal((await passo(runId, "b")).status, "awaiting_approval");
  assert.equal((await passo(runId, "b")).rebaixado, REBAIXADO_NA_REEXECUCAO);
  assert.equal(publicados.length, 1, "só A saiu; B espera o clique");
});

test("run pausado: reexecutar M2, que ainda não tem linha, leva a instrução ao prompt dele", async () => {
  const { service, executor, runId, prompts } = await pausadoNoMeio();
  await service.rerunStep(runId, "m2", { wait: true, instrucao: "só o tratamento de erro" });
  assert.equal((await passo(runId, "m2")).instrucao, "só o tratamento de erro");
  await executor.decide((await pendenciaAberta(runId))!.id, "approved");
  const doM2 = prompts.find((p) => p.prompt.startsWith("m2"));
  assert.ok(doM2?.prompt.includes("só o tratamento de erro"));
});

test("reexecutar só um passo do meio sem instrução não tira a trava enquanto o ancestral ainda tem instrução", async () => {
  const ctx = montar();
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: `cadeia-${randomUUID()}`,
      name: "Cadeia",
      steps: [
        { type: "model", key: "revisar", name: "Revisar", model: "ollama/modelo", prompt: "revisar" },
        { type: "model", key: "resumir", name: "Resumir", model: "ollama/modelo", prompt: "resumir", needs: ["revisar"] },
        { type: "action", key: "publicar", name: "Publicar", action: "teste.publicar", mode: "auto", needs: ["resumir"] },
      ],
    }),
    undefined,
    "human",
  );
  const { service, publicados } = ctx;
  const runId = await ctx.executor.createRun(versao.id, null);
  assert.equal(await ctx.executor.execute(runId), "done");
  publicados.length = 0;
  await service.rerunStep(runId, "revisar", { wait: true, instrucao: "olhe o erro" });
  assert.equal(await service.rerunStep(runId, "resumir", { wait: true }), "paused");
  assert.deepEqual(publicados, []);
  assert.equal((await passo(runId, "publicar")).status, "awaiting_approval");
  assert.equal((await passo(runId, "revisar")).instrucao, "olhe o erro");
});

test("a instrução do ancestral vale até ele ser reexecutado de novo: sem instrução a trava cai", async () => {
  const { service, runId, publicados } = await preparar();
  await service.rerunStep(runId, "revisar", { wait: true, instrucao: "olhe o erro" });
  assert.equal(await service.rerunStep(runId, "revisar", { wait: true, instrucao: "outra" }), "paused");
  assert.equal((await passo(runId, "revisar")).instrucao, "outra");
});

test("ação em draft a jusante também vai para a Fila com instrução", async () => {
  const ctx = montar();
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: `rascunho-${randomUUID()}`,
      name: "Rascunho",
      steps: [
        { type: "model", key: "ler", name: "Ler", model: "ollama/modelo", prompt: "ler" },
        { type: "action", key: "rascunhar", name: "Rascunhar", action: "teste.publicar", mode: "draft", needs: ["ler"] },
      ],
    }),
    undefined,
    "human",
  );
  const runId = await ctx.executor.createRun(versao.id, null);
  assert.equal(await ctx.executor.execute(runId), "done");
  assert.equal(ctx.rascunhos.length, 1);
  assert.equal(await ctx.service.rerunStep(runId, "ler", { wait: true, instrucao: "x" }), "paused");
  assert.equal(ctx.rascunhos.length, 1, "nenhum rascunho novo saiu");
  assert.equal((await passo(runId, "rascunhar")).status, "awaiting_approval");
  const prev = await ctx.service.rerunPreview(runId, "ler", { comInstrucao: true });
  assert.deepEqual(prev.rebaixados.map((p) => p.stepKey), ["rascunhar"]);
});

test("a prévia lista as ações rebaixadas por ancestral com instrução e os passos que ainda não têm linha", async () => {
  const { service, runId } = await pausadoNoMeio();
  const prev = await service.rerunPreview(runId, "m1", { comInstrucao: true });
  assert.deepEqual(prev.rebaixados.map((p) => p.stepKey), ["b"]);
  await service.rerunStep(runId, "m1", { wait: true, instrucao: "x" });
  // Reexecutar só m2 sem instrução: m1 ainda tem a dele, então b continua na lista.
  const depois = await service.rerunPreview(runId, "m2", { comInstrucao: false });
  assert.deepEqual(depois.rebaixados.map((p) => p.stepKey), ["b"]);
  assert.ok(depois.cobradosDeNovo.length > 0);
});

test("a prévia traz as recusas do rerun como bloqueios e os avulsos que vão expirar", async () => {
  const { service, runId } = await preparar();
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  await db.insert(schema.steps).values({ id: randomUUID(), runId, idx: 9, stepKey: "avulso-1", name: "teste.publicar", origem: "avulso", status: "awaiting_approval", input: { derivaDe: "revisar" } });
  const livre = await service.rerunPreview(runId, "revisar", { comInstrucao: false });
  assert.deepEqual(livre.bloqueios, []);
  assert.deepEqual(livre.avulsosQueExpiram.map((p) => p.stepKey), ["avulso-1"]);

  await db.update(schema.runs).set({ status: "running" }).where(eq(schema.runs.id, runId));
  assert.deepEqual((await service.rerunPreview(runId, "revisar", {})).bloqueios.map((b) => b.codigo), ["em-andamento"]);
  await db.update(schema.runs).set({ status: run!.status }).where(eq(schema.runs.id, runId));

  await db.update(schema.agents).set({ archivedAt: 1 }).where(eq(schema.agents.id, (await service.get(runId))!.agentId));
  assert.deepEqual((await service.rerunPreview(runId, "revisar", {})).bloqueios.map((b) => b.codigo), ["arquivada"]);
});

test("duas reexecuções ao mesmo tempo: só uma passa, a outra é recusada como em andamento", async () => {
  const { service, runId } = await preparar();
  const [a, b] = await Promise.allSettled([service.rerunStep(runId, "revisar", { wait: false }), service.rerunStep(runId, "revisar", { wait: false })]);
  assert.equal([a, b].filter((r) => r.status === "fulfilled").length, 1);
});

test("enquanto qualquer passo do run tem instrução, toda ação roda em approve, mesmo sem ser descendente dele", async () => {
  const ctx = montar();
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: `citado-${randomUUID()}`,
      name: "Citado",
      steps: [
        { type: "model", key: "revisar", name: "Revisar", model: "ollama/modelo", prompt: "revisar" },
        { type: "model", key: "outro", name: "Outro", model: "ollama/modelo", prompt: "outro" },
        { type: "action", key: "publicar", name: "Publicar", action: "teste.publicar", mode: "auto", needs: ["outro"], params: { body: "{{steps.revisar.text}}" } },
      ],
    }),
    undefined,
    "human",
  );
  const runId = await ctx.executor.createRun(versao.id, null);
  assert.equal(await ctx.executor.execute(runId), "done");
  ctx.publicados.length = 0;
  await ctx.service.rerunStep(runId, "revisar", { wait: true, instrucao: "olhe o erro" });
  assert.equal(await ctx.service.rerunStep(runId, "outro", { wait: true }), "paused");
  assert.deepEqual(ctx.publicados, []);
  assert.equal((await passo(runId, "publicar")).status, "awaiting_approval");
  const prev = await ctx.service.rerunPreview(runId, "outro", { comInstrucao: false });
  assert.deepEqual(prev.rebaixados.map((p) => p.stepKey), ["publicar"]);
});

test("a prévia não lista como rebaixada a ação pulada que não vai rodar", async () => {
  const { service, runId } = await preparar();
  const publicar = await passo(runId, "publicar");
  await db.update(schema.steps).set({ status: "skipped", error: "rejected" }).where(eq(schema.steps.id, publicar.id));
  assert.deepEqual((await service.rerunPreview(runId, "solto", { comInstrucao: true })).rebaixados, []);
  await db.update(schema.steps).set({ error: "not_run" }).where(eq(schema.steps.id, publicar.id));
  assert.deepEqual((await service.rerunPreview(runId, "solto", { comInstrucao: true })).rebaixados.map((p) => p.stepKey), ["publicar"]);
});
