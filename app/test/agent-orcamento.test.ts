import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { MockLanguageModelV3 } from "ai/test";
import { ApprovalGate } from "../src/approval/gate.js";
import { AgentSpec } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { recordSpend, today } from "../src/executor/budget.js";
import { Executor } from "../src/executor/executor.js";
import { McpRegistry } from "../src/mcp/registry.js";
import { consultarAgent, type ConsultaDeps } from "../src/native-tools/ask.js";
import type { ProviderEntry } from "../src/providers/registry.js";
import { NativeRuntime } from "../src/runtimes/native.js";
import type { RuntimeRequest } from "../src/runtimes/types.js";
import { AgentService } from "../src/services/agent-service.js";
import { LibraryService } from "../src/services/library-service.js";
import { PriceService } from "../src/services/price-service.js";
import type { LoadedSkill } from "../src/skills/loader.js";

/** Orçamento e skills do agent da biblioteca, no executor e no ask_agent. */

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

function modeloQueGasta(tokens: number) {
  const chamadas: unknown[] = [];
  const modelo = new MockLanguageModelV3({
    doGenerate: async (opcoes) => {
      chamadas.push(opcoes);
      return {
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: tokens, noCache: tokens, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 0, text: 0, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return { modelo, chamadas };
}

async function fluxoComAgent(biblioteca: LibraryService, perfil: string, modelo: MockLanguageModelV3, skills?: Map<string, LoadedSkill>) {
  const entrada: ProviderEntry = { available: () => true, requires: [], model: () => modelo };
  const executor = new Executor({
    mcp: new McpRegistry(new Map()),
    runtimes: new Map([["native", new NativeRuntime({ ollama: entrada }, new PriceService(db))]]),
    gate: new ApprovalGate(new Map()),
    machineId: "maquina-de-teste",
    profiles: biblioteca,
    skills,
  });
  const fluxo = `fluxo-${randomUUID().slice(0, 8)}`;
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: fluxo,
      name: "Fluxo",
      steps: [{ type: "model", key: "tarefa", name: "tarefa", model: "ollama/x", prompt: "Resuma.", profile: perfil }],
    }),
    undefined,
    "human",
  );
  const runId = await executor.createRun(versao.id, null);
  return { executor, runId, fluxo };
}

const gastoDe = async (agentId: string) =>
  (await db.select().from(schema.usageDaily).where(and(eq(schema.usageDaily.day, today()), eq(schema.usageDaily.agentId, agentId))))[0];

test("o executor para o passo do agent que já gastou o teto do dia e grava o gasto do que roda", async () => {
  const biblioteca = new LibraryService(db);
  const perfil = `teto-${randomUUID().slice(0, 8)}`;
  await biblioteca.saveProfile({ spec: { id: perfil, name: "Teto", model: "ollama/x", budget: { perDayTokens: 100 } } });

  const { modelo, chamadas } = modeloQueGasta(60);
  const primeiro = await fluxoComAgent(biblioteca, perfil, modelo);
  assert.equal(await primeiro.executor.execute(primeiro.runId), "done");
  assert.equal((await gastoDe(`biblioteca:${perfil}`))?.tokens, 60);

  // Outro run do mesmo agent passa só com o que sobrou, e o seguinte já não passa.
  const segundo = await fluxoComAgent(biblioteca, perfil, modelo);
  assert.equal(await segundo.executor.execute(segundo.runId), "done");
  const terceiro = await fluxoComAgent(biblioteca, perfil, modelo);
  assert.equal(await terceiro.executor.execute(terceiro.runId), "paused");
  assert.equal(chamadas.length, 2);
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, terceiro.runId));
  assert.match(run!.error ?? "", /orçamento de day estourado/);
});

test("as skills do agent entram no system do passo", async () => {
  const biblioteca = new LibraryService(db);
  const perfil = `skill-${randomUUID().slice(0, 8)}`;
  await biblioteca.saveProfile({ spec: { id: perfil, name: "Skill", model: "ollama/x", skills: ["revisao"] } });
  const catalogo = new Map<string, LoadedSkill>([
    ["revisao", { name: "revisao", description: "d", body: "Confira os testes.", origin: "/x/SKILL.md", hash: "abc" }],
  ]);
  const { modelo, chamadas } = modeloQueGasta(1);
  const { executor, runId } = await fluxoComAgent(biblioteca, perfil, modelo, catalogo);
  assert.equal(await executor.execute(runId), "done");
  const sistema = (chamadas[0] as { prompt: { role: string; content: unknown }[] }).prompt.find((m) => m.role === "system");
  assert.match(sistema!.content as string, /## Skill: revisao[\s\S]*Confira os testes\./);
});

function depsDaConsulta(opcoes: { budget?: object; skills?: string[] }, pedidos: RuntimeRequest[], gastos: unknown[]): ConsultaDeps {
  const spec = {
    id: "triador",
    name: "Triador",
    description: "",
    context: "",
    instructions: "",
    model: "anthropic/x",
    toolsets: [],
    tools: [],
    connections: [],
    skills: (opcoes.skills ?? []).map((skill) => ({ skill, when: { always: true } })),
    budget: opcoes.budget ?? {},
    maxSteps: 4,
  };
  return {
    library: {
      resolveProfile: async () => ({
        version: { id: "v", profileId: "triador", version: 1, note: null, createdAt: 0, spec },
        tools: [],
        confirmar: [],
        semServidor: [],
        system: "Base.",
      }),
    },
    fallbacks: async () => [],
    skills: new Map([["revisao", { name: "revisao", description: "d", body: "Confira os testes.", origin: "/x", hash: "h" }]]),
    build: async () => ({
      mcp: { toolsFor: async () => ({ tools: {}, release: () => {} }) },
      runtimes: new Map([
        [
          "native",
          {
            id: "native",
            run: async (req: RuntimeRequest) => {
              pedidos.push(req);
              return { text: "ok", promptTokens: 10, completionTokens: 5, costUsd: 0.01, billable: true, toolsUsed: [] };
            },
          },
        ],
      ]),
    }),
    spend: async (...a) => void gastos.push(a),
  };
}

test("ask_agent confere o teto do dia do agent antes de rodar e põe as skills dele no system", async () => {
  const anterior = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "chave-de-teste";
  try {
    const pedidos: RuntimeRequest[] = [];
    const gastos: unknown[] = [];
    const resposta = await consultarAgent("triador", "oi", depsDaConsulta({ skills: ["revisao"] }, pedidos, gastos));
    assert.equal(resposta.answer, "ok");
    assert.match(pedidos[0]!.system!, /Base\.[\s\S]*## Skill: revisao[\s\S]*Confira os testes\./);

    await recordSpend("biblioteca:triador", { usd: 0, tokens: 500 }, false);
    const barrado: RuntimeRequest[] = [];
    await assert.rejects(
      consultarAgent("triador", "oi", { ...depsDaConsulta({ budget: { perDayTokens: 100 } }, barrado, []) }),
      /orçamento de day estourado/,
    );
    assert.equal(barrado.length, 0);
  } finally {
    if (anterior === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = anterior;
  }
});
