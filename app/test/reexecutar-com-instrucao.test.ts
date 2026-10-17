import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ApprovalGate, type ActionHandler } from "../src/approval/gate.js";
import { REBAIXADO_NA_REEXECUCAO } from "../src/config/rebaixado.js";
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
  const prompts: { passo: string; prompt: string }[] = [];
  const runtime: Runtime = {
    id: "native",
    run: async (req) => {
      prompts.push({ passo: req.prompt.split(" ")[0]!, prompt: req.prompt });
      return { text: "ok", promptTokens: 1, completionTokens: 1, costUsd: 0, billable: false, toolsUsed: [] };
    },
  };
  const publicados: string[] = [];
  const handler: ActionHandler = { publish: async (_p, externalId) => void publicados.push(externalId) };
  const gate = new ApprovalGate(new Map([["teste.publicar", handler]]));
  const executor = new Executor({
    mcp: new McpRegistry(new Map()),
    runtimes: new Map([["native", runtime]]),
    gate,
    machineId: "maquina-de-teste",
  });
  return { prompts, publicados, executor, service: new RunService(db, async () => executor) };
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

test("o rótulo do bloco é parâmetro, e o padrão vale sem ele", async () => {
  const { service, runId, prompts } = await preparar();
  await service.rerunStep(runId, "revisar", { wait: true, instrucao: "mais um ponto", rotuloDaInstrucao: "PEDIDO EXTRA:" });
  assert.match(prompts.find((p) => p.prompt.startsWith("revisar"))!.prompt, /PEDIDO EXTRA:\nmais um ponto$/);

  prompts.length = 0;
  await service.rerunStep(runId, "revisar", { wait: true, instrucao: "outro ponto" });
  assert.match(prompts.find((p) => p.prompt.startsWith("revisar"))!.prompt, /reexecutou[^\n]*\noutro ponto$/);
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
