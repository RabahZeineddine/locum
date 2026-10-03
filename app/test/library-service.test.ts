import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { MockLanguageModelV3 } from "ai/test";
import { ApprovalGate } from "../src/approval/gate.js";
import { AgentSpec } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { Executor } from "../src/executor/executor.js";
import { McpRegistry } from "../src/mcp/registry.js";
import type { ProviderEntry } from "../src/providers/registry.js";
import { NativeRuntime } from "../src/runtimes/native.js";
import { AgentService } from "../src/services/agent-service.js";
import { LibraryService } from "../src/services/library-service.js";
import { PriceService } from "../src/services/price-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/** A biblioteca: agents reutilizáveis e toolsets, e o passo que usa um deles. */

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

const leitura = { server: "jira", tool: "search", class: "read" as const };

test("agent da biblioteca ganha versão nova só quando muda", async () => {
  const biblioteca = new LibraryService(bancoDeTeste());
  const spec = { id: "chamados", name: "Chamados", model: "anthropic/claude-sonnet-5", instructions: "Classifique." };
  const v1 = await biblioteca.saveProfile({ spec, create: true });
  const igual = await biblioteca.saveProfile({ spec });
  const v2 = await biblioteca.saveProfile({ spec: { ...spec, instructions: "Classifique e resuma." } });
  assert.equal(v1.version, 1);
  assert.equal(igual.version, 1);
  assert.equal(v2.version, 2);
  await assert.rejects(biblioteca.saveProfile({ spec, create: true }), /já existe/);
});

test("toolset e ferramentas avulsas se somam sem repetir, e o system junta contexto e instruções", async () => {
  const biblioteca = new LibraryService(bancoDeTeste());
  await biblioteca.saveToolset({ toolset: { id: "jira-leitura", name: "Jira leitura", tools: [leitura] }, create: true });
  await biblioteca.saveProfile({
    spec: {
      id: "parcerias",
      name: "Parcerias",
      model: "anthropic/claude-sonnet-5",
      context: "Time de parcerias.",
      instructions: "Responda curto.",
      toolsets: ["jira-leitura"],
      tools: [leitura, { server: "github", tool: "get_pr", class: "read" }],
    },
  });
  const resolvido = await biblioteca.resolveProfile("parcerias");
  assert.deepEqual(
    resolvido.tools.map((t) => `${t.server}.${t.tool}`),
    ["jira.search", "github.get_pr"],
  );
  assert.match(resolvido.system, /Time de parcerias\.[\s\S]*Responda curto\./);
});

test("escrita externa não entra em toolset nem em agent", async () => {
  const biblioteca = new LibraryService(bancoDeTeste());
  const escrita = { server: "slack", tool: "post", class: "external_write" as const };
  await assert.rejects(
    biblioteca.saveToolset({ toolset: { id: "slack", name: "Slack", tools: [escrita] } }),
    /escrita externa/,
  );
  await assert.rejects(
    biblioteca.saveProfile({ spec: { id: "x", name: "X", model: "a/b", tools: [escrita] } }),
    /escrita externa/,
  );
});

test("toolset inexistente é recusado, e toolset em uso não sai", async () => {
  const biblioteca = new LibraryService(bancoDeTeste());
  await assert.rejects(
    biblioteca.saveProfile({ spec: { id: "x", name: "X", model: "a/b", toolsets: ["nao-existe"] } }),
    /toolset inexistente/,
  );
  await biblioteca.saveToolset({ toolset: { id: "base", name: "Base" } });
  await biblioteca.saveProfile({ spec: { id: "x", name: "X", model: "a/b", toolsets: ["base"] } });
  await assert.rejects(biblioteca.removeToolset("base"), /em uso/);
});

test("agent usado por um fluxo não sai da biblioteca", async () => {
  const banco = bancoDeTeste();
  const biblioteca = new LibraryService(banco);
  await biblioteca.saveProfile({ spec: { id: "revisor", name: "Revisor", model: "a/b" } });
  await new AgentService(banco).upsert(
    AgentSpec.parse({
      id: "fluxo",
      name: "Fluxo",
      steps: [{ type: "model", key: "ler", name: "ler", model: "a/b", prompt: "x", profile: "revisor" }],
    }),
    undefined,
    "human",
  );
  assert.deepEqual((await biblioteca.listProfiles())[0]?.usedBy, ["fluxo"]);
  await assert.rejects(biblioteca.removeProfile("revisor"), /em uso em: fluxo/);
});

test("passo com agent da biblioteca roda com o modelo, o system e a temperatura do agent", async () => {
  const chamadas: Parameters<MockLanguageModelV3["doGenerate"]>[0][] = [];
  const modelo = new MockLanguageModelV3({
    doGenerate: async (options) => {
      chamadas.push(options);
      return {
        content: [{ type: "text", text: "feito" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  const modelosPedidos: string[] = [];
  const entrada: ProviderEntry = {
    available: () => true,
    requires: [],
    model: (id: string) => {
      modelosPedidos.push(id);
      return modelo;
    },
  };
  const biblioteca = new LibraryService(db);
  const perfil = `perfil-${randomUUID().slice(0, 8)}`;
  await biblioteca.saveProfile({
    spec: { id: perfil, name: "Perfil", model: "ollama/do-agent", context: "Sabe de seguros.", temperature: 0.2 },
  });
  const executor = new Executor({
    mcp: new McpRegistry(new Map()),
    runtimes: new Map([["native", new NativeRuntime({ ollama: entrada }, new PriceService(db))]]),
    gate: new ApprovalGate(new Map()),
    machineId: "maquina-de-teste",
    profiles: biblioteca,
  });
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: `fluxo-${randomUUID().slice(0, 8)}`,
      name: "Fluxo",
      steps: [{ type: "model", key: "tarefa", name: "tarefa", model: "ollama/do-passo", prompt: "Resuma.", profile: perfil }],
    }),
    undefined,
    "human",
  );
  const runId = await executor.createRun(versao.id, null);
  assert.equal(await executor.execute(runId), "done");

  assert.deepEqual(modelosPedidos, ["do-agent"]);
  assert.equal(chamadas[0]!.temperature, 0.2);
  const sistema = chamadas[0]!.prompt.find((m) => m.role === "system");
  assert.match(sistema!.content as string, /Sabe de seguros\./);
  const [passo] = await db
    .select()
    .from(schema.steps)
    .where(and(eq(schema.steps.runId, runId), eq(schema.steps.stepKey, "tarefa")));
  assert.deepEqual((passo!.input as { profile: unknown }).profile, { id: perfil, version: 1 });
});
