import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AgentSpec } from "../src/config/types.js";
import { schema } from "../src/db/index.js";
import { AgentService } from "../src/services/agent-service.js";
import { RunService } from "../src/services/run-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/**
 * Banco que conta consulta, com uma quantidade de execuções escolhida.
 *
 * Cada execução tem um passo terminado com dois achados na saída, um passo
 * parado esperando e um que quebrou, para a contagem agregada ter o que somar.
 */
async function bancoCom(execucoes: number) {
  const contador = { consultas: 0 };
  const db = bancoDeTeste({ logger: { logQuery: () => void contador.consultas++ } });
  const versao = await new AgentService(db).upsert(
    AgentSpec.parse({
      id: "revisor",
      name: "Revisor",
      steps: [{ type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt: "revise" }],
    }),
    undefined,
    "human",
  );

  const runIds: string[] = [];
  for (let i = 0; i < execucoes; i++) {
    const runId = randomUUID();
    runIds.push(runId);
    await db.insert(schema.runs).values({ id: runId, agentVersionId: versao.id, status: "done" });
    await db.insert(schema.steps).values([
      {
        id: randomUUID(),
        runId,
        idx: 0,
        stepKey: "ler",
        name: "Ler",
        status: "done",
        output: {
          findings: [
            { severity: "high", problem: "referência nula" },
            { severity: "low", problem: "nome confuso", file: "a.ts", line: 3 },
            { problem: "sem severidade, fica fora" },
            "texto solto, fica fora",
          ],
        },
      },
      { id: randomUUID(), runId, idx: 1, stepKey: "esperar", name: "Esperar", status: "awaiting_approval" },
      { id: randomUUID(), runId, idx: 2, stepKey: "quebrar", name: "Quebrar", status: "failed", output: "texto" },
    ]);
  }
  contador.consultas = 0;
  return { db, contador, runIds };
}

test("lista de execuções faz o mesmo número de consultas com 1 ou 30 linhas", async () => {
  const pequeno = await bancoCom(1);
  const linhas = await new RunService(pequeno.db).list({ limit: 500 });
  const comUma = pequeno.contador.consultas;

  const grande = await bancoCom(30);
  const muitas = await new RunService(grande.db).list({ limit: 500 });

  assert.equal(linhas.length, 1);
  assert.equal(muitas.length, 30);
  assert.equal(grande.contador.consultas, comUma);
});

test("contagem agregada da lista bate com os passos e achados de cada execução", async () => {
  const { db } = await bancoCom(3);
  for (const run of await new RunService(db).list()) {
    assert.equal(run.stepTotal, 3);
    assert.equal(run.stepDone, 1);
    assert.equal(run.stepPending, 1);
    assert.equal(run.stepFailed, 1);
    assert.equal(run.findingCount, 2);
  }
});

test("execução sem passo nenhum aparece na lista com contagem zero", async () => {
  const db = bancoDeTeste();
  const versao = await new AgentService(db).upsert(
    AgentSpec.parse({
      id: "vazio",
      name: "Vazio",
      steps: [{ type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt: "x" }],
    }),
    undefined,
    "human",
  );
  await db.insert(schema.runs).values({ id: randomUUID(), agentVersionId: versao.id, status: "queued" });

  const [run] = await new RunService(db).list();
  assert.equal(run?.stepTotal, 0);
  assert.equal(run?.findingCount, 0);
});

test("achados de várias execuções saem em lote, com número fixo de consultas", async () => {
  const pequeno = await bancoCom(1);
  await new RunService(pequeno.db).findingsByRun(pequeno.runIds);
  const comUma = pequeno.contador.consultas;

  const grande = await bancoCom(30);
  const porRun = await new RunService(grande.db).findingsByRun(grande.runIds);

  assert.equal(grande.contador.consultas, comUma);
  assert.equal(Object.keys(porRun).length, 30);
  for (const runId of grande.runIds) {
    assert.deepEqual(
      porRun[runId]?.map((f) => f.problem),
      ["referência nula", "nome confuso"],
    );
  }
});

test("lote prefere a tabela de achados quando o reconciliador já gravou", async () => {
  const { db, runIds } = await bancoCom(2);
  const [gravado, soNoPasso] = runIds as [string, string];
  await db.insert(schema.findings).values({
    id: randomUUID(),
    runId: gravado,
    severity: "critical",
    body: "vazamento de segredo",
    state: "posted",
  });

  const service = new RunService(db);
  const porRun = await service.findingsByRun([gravado, soNoPasso, "run-que-nao-existe"]);

  assert.deepEqual(porRun[gravado]?.map((f) => [f.problem, f.state]), [["vazamento de segredo", "posted"]]);
  assert.equal(porRun[soNoPasso]?.length, 2);
  assert.deepEqual(porRun["run-que-nao-existe"], []);
  assert.deepEqual(await service.findings(gravado), porRun[gravado]);
});

test("a lista conta os passos que terminaram em ensaio, e só eles", async () => {
  const db = bancoDeTeste();
  const versao = await new AgentService(db).upsert(
    AgentSpec.parse({
      id: "ensaiado",
      name: "Ensaiado",
      steps: [{ type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt: "x" }],
    }),
    undefined,
    "human",
  );
  const comEnsaio = randomUUID();
  const semEnsaio = randomUUID();
  for (const runId of [comEnsaio, semEnsaio]) {
    await db.insert(schema.runs).values({ id: runId, agentVersionId: versao.id, status: "done" });
  }
  await db.insert(schema.steps).values([
    { id: randomUUID(), runId: comEnsaio, idx: 0, stepKey: "ler", name: "Ler", status: "done", output: "texto solto" },
    { id: randomUUID(), runId: comEnsaio, idx: 1, stepKey: "postar", name: "Postar", status: "done", output: { state: "ensaio", motivo: "sem-conversa", text: "oi" } },
    { id: randomUUID(), runId: semEnsaio, idx: 0, stepKey: "postar", name: "Postar", status: "done", output: { state: "published" } },
  ]);

  const porId = new Map((await new RunService(db).list()).map((r) => [r.id, r.stepDryRun]));
  assert.equal(porId.get(comEnsaio), 1);
  assert.equal(porId.get(semEnsaio), 0);
});

test("o detalhe do run traz o teto por run dos agents da biblioteca que os passos usam", async () => {
  const db = bancoDeTeste();
  const { LibraryService } = await import("../src/services/library-service.js");
  const biblioteca = new LibraryService(db);
  await biblioteca.saveProfile({ spec: { id: "com-teto", name: "Com teto", model: "ollama/x", budget: { perRunUsd: 0.3 } } });
  await biblioteca.saveProfile({ spec: { id: "sem-teto", name: "Sem teto", model: "ollama/x" } });
  const versao = await new AgentService(db).upsert(
    AgentSpec.parse({
      id: "com-agents",
      name: "Com agents",
      steps: [
        { type: "model", key: "a", name: "A", profile: "com-teto", model: "ollama/x", prompt: "x" },
        { type: "model", key: "b", name: "B", profile: "sem-teto", model: "ollama/x", prompt: "x" },
      ],
    }),
    undefined,
    "human",
  );
  const runId = randomUUID();
  await db.insert(schema.runs).values({ id: runId, agentVersionId: versao.id, status: "done" });
  assert.deepEqual((await new RunService(db).get(runId))?.tetosDosAgents, { "com-teto": 0.3 });
});

test("só passo de modelo conta achado: a resposta de ferramenta com `findings` fica fora", async () => {
  const db = bancoDeTeste();
  const versao = await new AgentService(db).upsert(
    AgentSpec.parse({
      id: "misto",
      name: "Misto",
      steps: [
        { type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt: "revise" },
        { type: "action", key: "chamar", name: "Chamar", action: "mcp.call", needs: ["ler"], mode: "auto", params: { server: "s", tool: "t", args: {} } },
      ],
    }),
    undefined,
    "human",
  );
  const runId = randomUUID();
  await db.insert(schema.runs).values({ id: runId, agentVersionId: versao.id, status: "done" });
  const achados = { findings: [{ severity: "high", problem: "de verdade" }] };
  await db.insert(schema.steps).values([
    { id: randomUUID(), runId, idx: 0, stepKey: "ler", name: "Ler", status: "done", output: achados },
    { id: randomUUID(), runId, idx: 1, stepKey: "chamar", name: "Chamar", status: "done", output: { findings: [{ severity: "low", problem: "veio da ferramenta" }] } },
  ]);
  const [run] = await new RunService(db).list();
  assert.equal(run?.findingCount, 1);
  const porRun = await new RunService(db).findingsByRun([runId]);
  assert.deepEqual(porRun[runId]?.map((f) => f.problem), ["de verdade"]);
});
