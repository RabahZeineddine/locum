import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ApprovalGate } from "../src/approval/gate.js";
import { AgentSpec } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { Executor } from "../src/executor/executor.js";
import type { McpRegistry } from "../src/mcp/registry.js";
import type { Runtime, RuntimeRequest } from "../src/runtimes/types.js";
import { AgentService } from "../src/services/agent-service.js";
import { AutomationService } from "../src/services/automation-service.js";
import { TriggerService } from "../src/services/trigger-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/** O que um passo com campo a preencher faz no ligar, na execução manual, no ensaio e no run de gatilho. */

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

const registroFalso = { missing: () => [], toolsFor: async () => ({ tools: {}, release: () => undefined }) } as unknown as McpRegistry;
const runtime = (pedidos: RuntimeRequest[]): Runtime => ({ id: "native", run: async (req) => (pedidos.push(req), { text: '{"text":"ok"}', promptTokens: 1, completionTokens: 0, costUsd: 0, billable: true, toolsUsed: [] }) });
const modelo = (key: string, extra: Record<string, unknown> = {}) => ({ type: "model", key, name: key, model: "ollama/x", prompt: "oi", ...extra });
const PENDENTE = [{ onde: "avisar", campo: "params.destino", motivo: "destino-a-escolher" }];
const avisar = { type: "action", key: "avisar", name: "avisar", action: "teams.post", mode: "approve", input: "ler", needs: ["ler"] };

async function gravar(steps: unknown[], pendentes: unknown[] = PENDENTE) {
  const id = `inc-${randomUUID().slice(0, 8)}`;
  const versao = await new AgentService().upsert(AgentSpec.parse({ id, name: "Incompleta", steps, pendentes }), undefined, "human");
  return { id, versao };
}
const executor = (pedidos: RuntimeRequest[]) => new Executor({ mcp: registroFalso, runtimes: new Map([["native", runtime(pedidos)]]), gate: new ApprovalGate(new Map()), machineId: "m" });
const passos = async (runId: string) => (await db.select().from(schema.steps).where(eq(schema.steps.runId, runId))).sort((a, b) => a.idx - b.idx);
const run = async (runId: string) => (await db.select().from(schema.runs).where(eq(schema.runs.id, runId)))[0]!;

test("passo com campo a preencher também impede ligar a automação e o gatilho", async () => {
  const bd = bancoDeTeste();
  const agents = new AgentService(bd);
  const triggers = new TriggerService(bd);
  const automations = new AutomationService(agents, triggers, {} as never);
  const spec = AgentSpec.parse({ id: "ligar-incompleta", name: "X", steps: [modelo("ler"), avisar], pendentes: PENDENTE });
  const salva = await automations.save({ spec, triggers: [{ config: { kind: "cron", expression: "0 9 * * *" } }], note: "", create: true });
  await assert.rejects(() => automations.setEnabled("ligar-incompleta", true), /incompleta.*avisar.*params\.destino/);
  await assert.rejects(() => triggers.setEnabled(salva.triggers[0]!.id, true), /incompleta/);
  await assert.rejects(() => automations.save({ spec: salva.version.spec, triggers: [{ id: salva.triggers[0]!.id, config: salva.triggers[0]!.config, enabled: true }], note: "ligar" }), /incompleta/);
});

test("execução manual recusa antes de começar e diz o que falta, sem gastar o passo de modelo", async () => {
  const pedidos: RuntimeRequest[] = [];
  const { versao } = await gravar([modelo("ler"), modelo("depois", { needs: ["ler"], prompt: "" })], [{ onde: "depois", campo: "prompt", motivo: "argumentos" }]);
  const runId = await executor(pedidos).createRun(versao.id, null);
  assert.equal(await executor(pedidos).execute(runId), "failed");
  assert.match((await run(runId)).error ?? "", /nó "depois" incompleto: preencha os argumentos \(prompt\)/);
  assert.equal(pedidos.length, 0);
  assert.ok((await passos(runId)).every((p) => p.status !== "done"));
});

test("ensaio não falha no nó incompleto: mostra o nó como incompleto e segue o que dá", async () => {
  const pedidos: RuntimeRequest[] = [];
  const { versao } = await gravar([modelo("ler"), avisar]);
  const evento = randomUUID();
  await db.insert(schema.events).values({ id: evento, source: "manual", externalId: `t:${evento}`, payload: { repo: "o/r", changedFiles: [], prOwner: "o", prRepo: "r", prNumber: 7, semConversa: true } });
  const runId = await executor(pedidos).createRun(versao.id, evento);
  assert.equal(await executor(pedidos).execute(runId), "done");
  assert.equal(pedidos.length, 1);
  const no = (await passos(runId)).find((p) => p.stepKey === "avisar")!;
  assert.equal(no.status, "done");
  assert.match((no.output as { motivo: string }).motivo, /^incompleto: escolha o destino \(params\.destino\)/);
});

test("passo opcional com campo a preencher falha como opcional, com o motivo, e o run segue", async () => {
  const pedidos: RuntimeRequest[] = [];
  const { id, versao } = await gravar([modelo("ler"), { ...avisar, optional: true }, modelo("depois", { needs: ["ler"] })]);
  const gatilho = await new TriggerService().set(id, { kind: "cron", expression: "0 9 * * *" });
  const runId = await executor(pedidos).createRun(versao.id, null, gatilho.id);
  assert.equal(await executor(pedidos).execute(runId), "done");
  const lista = await passos(runId);
  const opcional = lista.find((p) => p.stepKey === "avisar")!;
  assert.equal(opcional.status, "failed");
  assert.match(opcional.error ?? "", /incompleto: escolha o destino/);
  assert.equal(lista.find((p) => p.stepKey === "depois")!.status, "done");
});
