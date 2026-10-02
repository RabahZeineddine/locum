import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { AgentSpec } from "../src/config/types.js";
import { schema } from "../src/db/index.js";
import { AgentService } from "../src/services/agent-service.js";
import { ReconcileService, type AftermathFetcher } from "../src/services/reconcile-service.js";
import type { RunFinding, RunService } from "../src/services/run-service.js";
import { WHOLE_FILE, type PrAftermath } from "../src/sources/github-reconciler.js";
import { bancoDeTeste } from "./helpers/db.js";

const T0 = Date.UTC(2026, 9, 2, 3, 0, 0);

type Execucao = { id: string; source?: string; status?: string; findings: RunFinding[]; payload?: object };

/** Banco com execuções de revisão de pull request e um GitHub de mentira. */
async function montar(execucoes: Execucao[], desfecho: (pull: number) => PrAftermath) {
  const db = bancoDeTeste();
  const versao = await new AgentService(db).upsert(
    AgentSpec.parse({
      id: "revisor",
      name: "Revisor",
      steps: [{ type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt: "revise" }],
    }),
    undefined,
    "human",
  );

  for (const [i, e] of execucoes.entries()) {
    await db.insert(schema.events).values({
      id: `ev-${e.id}`,
      source: e.source ?? "github",
      externalId: `pr-${e.id}`,
      payload: e.payload ?? { owner: "o", repoName: "r", pull: i + 1, headSha: "lido" },
    });
    await db.insert(schema.runs).values({
      id: e.id,
      agentVersionId: versao.id,
      eventId: `ev-${e.id}`,
      status: e.status ?? "done",
      createdAt: Math.floor(T0 / 1000) - 3600 + i,
    });
  }

  const pedidos: number[] = [];
  const fetch: AftermathFetcher = async (_owner, _repo, pull) => {
    pedidos.push(pull);
    return desfecho(pull);
  };
  const runs = {
    get: async (id: string) => execucoes.find((e) => e.id === id) && { id, eventId: `ev-${id}` },
    findings: async (id: string) => execucoes.find((e) => e.id === id)?.findings ?? [],
  } as unknown as RunService;

  return { db, service: new ReconcileService(db, runs, fetch), pedidos };
}

function aftermath(state: PrAftermath["state"], parcial: Partial<PrAftermath> = {}): PrAftermath {
  return { prKey: "o/r#1", state, headSha: "final", signals: [], changedAfter: new Map(), ...parcial };
}

const achado = (file: string, line: number, problem = `problema em ${file}:${line}`): RunFinding => ({
  severity: "high",
  file,
  line,
  problem,
  state: "open",
});

test("cada achado ganha um desfecho, na ordem duplicata, humano, commit, ignorado", async () => {
  const { db, service } = await montar(
    [
      {
        id: "run1",
        findings: [
          achado("a.ts", 10),
          achado("a.ts", 12, "o mesmo trecho visto de novo"),
          achado("b.ts", 40),
          achado("c.ts", 5),
          achado("d.ts", 1),
        ],
      },
    ],
    () =>
      aftermath("merged", {
        signals: [
          { author: "pessoa", kind: "comment", file: "a.ts", line: 11, body: "isto quebra" },
          { author: "pessoa", kind: "comment", file: "z.ts", line: 3, body: "e isto ninguém viu" },
        ],
        changedAfter: new Map([
          ["b.ts", new Set([43])],
          ["c.ts", new Set([WHOLE_FILE])],
        ]),
      }),
  );

  const relatorio = await service.reconcileRun("run1", { at: T0 });
  assert.deepEqual(relatorio.outcomes, {
    confirmed_by_human: 1,
    became_commit: 2,
    ignored: 1,
    disputed: 0,
    duplicate: 1,
  });
  assert.equal(relatorio.unmatchedSignals, 1);

  // Refazer não dobra o gabarito.
  await service.reconcileRun("run1", { at: T0 });
  assert.equal((await db.select().from(schema.findingOutcomes)).length, 5);
  assert.equal((await db.select().from(schema.findings)).length, 5);
  assert.equal((await db.select().from(schema.reviewSignals)).length, 2);
});

test("achado recusado na fila de aprovação conta como contestado, mesmo com o humano no mesmo trecho", async () => {
  const { db, service } = await montar([{ id: "run1", findings: [{ ...achado("a.ts", 10), fix: "conferir" }] }], () =>
    aftermath("closed", { signals: [{ author: "p", kind: "comment", file: "a.ts", line: 10, body: "x" }] }),
  );
  await db.insert(schema.steps).values({ id: "passo", runId: "run1", idx: 1, stepKey: "publicar", name: "Publicar", status: "done" });
  await db.insert(schema.approvals).values({
    id: "ap1",
    runId: "run1",
    stepId: "passo",
    kind: "github.review_comment",
    status: "rejected",
    payload: { findings: [{ problem: "problema em a.ts:10" }] },
  });

  const relatorio = await service.reconcileRun("run1");
  assert.equal(relatorio.outcomes.disputed, 1);
  const [linha] = await db.select().from(schema.findings).where(eq(schema.findings.runId, "run1"));
  assert.equal(linha?.state, "dismissed");
});

test("varredura confere só o que fechou, deixa o aberto para depois e marca de vez o ilegível", async () => {
  const { service, pedidos } = await montar(
    [
      { id: "fechou", findings: [achado("a.ts", 1)] },
      { id: "aberto", findings: [achado("a.ts", 1)] },
      { id: "sem-pr", findings: [], payload: { owner: "o" } },
      { id: "rodando", status: "running", findings: [] },
      { id: "slack", source: "slack:s", findings: [] },
    ],
    (pull) => aftermath(pull === 2 ? "open" : "merged"),
  );

  const primeira = await service.sweep({ at: T0 });
  assert.equal(primeira.checked, 3);
  assert.deepEqual(primeira.settled.map((r) => r.runId), ["fechou"]);
  assert.equal(primeira.stillOpen, 1);
  assert.equal(primeira.unreadable, 1);
  assert.deepEqual(pedidos, [1, 2]);

  const segunda = await service.sweep({ at: T0 });
  assert.equal(segunda.checked, 1);
  assert.equal(segunda.stillOpen, 1);
});

test("falha passageira de uma execução não derruba as outras e volta na batida seguinte", async () => {
  let fora = true;
  const { service } = await montar(
    [
      { id: "um", findings: [] },
      { id: "dois", findings: [] },
    ],
    (pull) => {
      if (pull === 1 && fora) throw new Error("GitHub 502");
      return aftermath("merged");
    },
  );

  const primeira = await service.sweep({ at: T0 });
  assert.deepEqual(primeira.failed, [{ runId: "um", detail: "GitHub 502" }]);
  assert.deepEqual(primeira.settled.map((r) => r.runId), ["dois"]);

  fora = false;
  const segunda = await service.sweep({ at: T0 });
  assert.deepEqual(segunda.settled.map((r) => r.runId), ["um"]);
});
