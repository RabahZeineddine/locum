import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { MockLanguageModelV3 } from "ai/test";
import { ApprovalGate } from "../src/approval/gate.js";
import { AgentSpec } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { Executor, stablePrefix } from "../src/executor/executor.js";
import { McpRegistry } from "../src/mcp/registry.js";
import type { ProviderEntry } from "../src/providers/registry.js";
import { NativeRuntime } from "../src/runtimes/native.js";
import { prReviewSpec } from "../src/examples/agents.js";
import { AgentService } from "../src/services/agent-service.js";
import { PriceService } from "../src/services/price-service.js";

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

const marca = { anthropic: { cacheControl: { type: "ephemeral" } } };

type Chamada = Parameters<MockLanguageModelV3["doGenerate"]>[0];

/** Modelo falso que guarda o que recebeu e devolve o uso pedido. */
function modeloQueGuarda(cacheRead: number | undefined) {
  const chamadas: Chamada[] = [];
  const modelo = new MockLanguageModelV3({
    doGenerate: async (options) => {
      chamadas.push(options);
      return {
        content: [{ type: "text", text: '{"ok":true}' }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 5000, noCache: 5000 - (cacheRead ?? 0), cacheRead, cacheWrite: undefined },
          outputTokens: { total: 10, text: 10, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return { modelo, chamadas };
}

function runtimeCom(modelo: MockLanguageModelV3, provedor: string) {
  const entrada: ProviderEntry = { available: () => true, requires: [], model: () => modelo };
  return new NativeRuntime({ [provedor]: entrada }, new PriceService(db));
}

test("runtime nativo manda o estável antes do variável e marca o fim do estável para cache", async () => {
  const { modelo, chamadas } = modeloQueGuarda(undefined);
  const runtime = runtimeCom(modelo, "anthropic");
  const estavel = "Instruções fixas da auditoria.\n\nDiff:\n";

  await runtime.run({
    provider: "anthropic",
    model: "m",
    system: "texto das skills",
    prompt: `${estavel}+ linha nova`,
    stablePrefix: estavel,
    tools: {},
    maxSteps: 1,
    outputSchema: { type: "object" },
  });

  const [sistema, usuario, ...resto] = chamadas[0]!.prompt;
  assert.equal(resto.length, 0);
  assert.equal(sistema?.role, "system");
  assert.match(sistema!.content as string, /texto das skills/);
  assert.match(sistema!.content as string, /schema/);
  assert.equal(sistema!.providerOptions, undefined, "a marca fica no fim do estável, não no meio");

  assert.equal(usuario?.role, "user");
  const partes = usuario!.content as Array<{ type: string; text: string; providerOptions?: unknown }>;
  assert.deepEqual(
    partes.map((p) => p.text),
    [estavel, "+ linha nova"],
  );
  assert.deepEqual(partes[0]!.providerOptions, marca);
  assert.equal(partes[1]!.providerOptions, undefined, "o variável não entra no cache");
});

test("sem trecho estável no prompt, a marca vai no fim do sistema", async () => {
  const { modelo, chamadas } = modeloQueGuarda(undefined);
  const runtime = runtimeCom(modelo, "anthropic");

  await runtime.run({ provider: "anthropic", model: "m", system: "skills", prompt: "{variável}", tools: {}, maxSteps: 1 });

  const [sistema, usuario] = chamadas[0]!.prompt;
  assert.deepEqual(sistema!.providerOptions, marca);
  const partes = usuario!.content as Array<{ text: string; providerOptions?: unknown }>;
  assert.deepEqual(partes.map((p) => p.text), ["{variável}"]);
  assert.equal(partes[0]!.providerOptions, undefined);
});

test("prefixo que não bate com o começo do prompt é ignorado, sem perder texto", async () => {
  const { modelo, chamadas } = modeloQueGuarda(undefined);
  const runtime = runtimeCom(modelo, "anthropic");

  await runtime.run({ provider: "anthropic", model: "m", prompt: "outro texto", stablePrefix: "fixo", tools: {}, maxSteps: 1 });

  const [usuario] = chamadas[0]!.prompt;
  const partes = usuario!.content as Array<{ text: string }>;
  assert.equal(partes.map((p) => p.text).join(""), "outro texto");
});

test("runtime nativo devolve os tokens lidos de cache quando o provedor informa", async () => {
  const comCache = runtimeCom(modeloQueGuarda(4200).modelo, "anthropic");
  const semCache = runtimeCom(modeloQueGuarda(undefined).modelo, "anthropic");
  const pedido = { provider: "anthropic", model: "m", prompt: "oi", tools: {}, maxSteps: 1 };

  assert.equal((await comCache.run(pedido)).cacheReadTokens, 4200);
  assert.equal((await semCache.run(pedido)).cacheReadTokens, undefined);
});

test("o executor separa o trecho estável do template e grava os tokens de cache no passo", async () => {
  const provedor = "ollama";
  const { modelo, chamadas } = modeloQueGuarda(3100);
  const executor = new Executor({
    mcp: new McpRegistry(new Map()),
    runtimes: new Map([["native", runtimeCom(modelo, provedor)]]),
    gate: new ApprovalGate(new Map()),
    machineId: "maquina-de-teste",
  });
  const agentId = `cache-${randomUUID()}`;
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: agentId,
      name: "Cache",
      steps: [
        {
          type: "model",
          key: "ler",
          name: "ler",
          model: "ollama/qualquer",
          prompt: "Regras fixas.\n\nRepositório: {{event.repo}}\nDiff:\n{{event.diff}}",
          outputSchema: { type: "object" },
        },
      ],
    }),
    undefined,
    "human",
  );
  const eventId = randomUUID();
  await db.insert(schema.events).values({
    id: eventId,
    source: "teste",
    externalId: eventId,
    payload: { repo: "dono/repo", changedFiles: [], diff: "+ x" },
  });
  const runId = await executor.createRun(versao.id, eventId);

  assert.equal(await executor.execute(runId), "done");

  const [usuario] = chamadas[0]!.prompt.filter((m) => m.role === "user");
  const partes = usuario!.content as Array<{ text: string; providerOptions?: unknown }>;
  assert.equal(partes[0]!.text, "Regras fixas.\n\nRepositório: ");
  assert.deepEqual(partes[0]!.providerOptions, marca);
  // O diff vem de fora: entra entre as marcas de dado externo.
  assert.equal(partes[1]!.text, 'dono/repo\nDiff:\n<dado-externo origem="event.diff">\n+ x\n</dado-externo>');

  const [passo] = await db
    .select()
    .from(schema.steps)
    .where(and(eq(schema.steps.runId, runId), eq(schema.steps.stepKey, "ler")));
  assert.equal(passo!.cacheReadTokens, 3100);
});

test("triagem e auditoria do pr-review trazem as instruções no trecho estável e o diff depois", () => {
  for (const chave of ["triage", "audit"]) {
    const passo = prReviewSpec.steps.find((s) => s.key === chave);
    assert.ok(passo?.type === "model", chave);
    const estavel = stablePrefix(passo.prompt);
    assert.doesNotMatch(estavel, /\{\{/, chave);
    assert.match(estavel, chave === "triage" ? /category:/ : /Severidade:[\s\S]*Veredito[\s\S]*dependency:/, chave);
    assert.ok(passo.prompt.indexOf("{{event.diff}}") > estavel.length, chave);
  }
});
