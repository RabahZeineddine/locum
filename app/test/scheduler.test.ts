import { test } from "node:test";
import assert from "node:assert/strict";
import { schema } from "../src/db/index.js";
import type { TriggerConfig } from "../src/config/types.js";
import type { ExecutionService } from "../src/services/execution-service.js";
import type { McpService } from "../src/services/mcp-service.js";
import type { SlackService } from "../src/services/slack-service.js";
import type { TriggerEntry, TriggerService } from "../src/services/trigger-service.js";
import { Scheduler, type PollFn, type SweepFn, type ViewerFn } from "../src/triggers/scheduler.js";
import { bancoDeTeste } from "./helpers/db.js";

const MINUTO = 60_000;
const T0 = Date.UTC(2026, 9, 2, 3, 0, 0);

type Montagem = {
  gatilhos: TriggerEntry[];
  poll?: PollFn;
  sweep?: SweepFn;
  viewer?: ViewerFn;
};

/** Um agendador com cadastro em memória e um executor que só anota o que recebeu. */
function montar({ gatilhos, poll, sweep, viewer }: Montagem) {
  const db = bancoDeTeste();
  const iniciados: { eventId: string | null; triggerId: string }[] = [];
  const triggers = {
    enabled: async () => gatilhos.filter((g) => g.enabled),
    list: async () => gatilhos,
  } as unknown as TriggerService;
  const executions = {
    startForEvent: async (input: { eventId: string | null; triggerId: string }) => {
      iniciados.push({ eventId: input.eventId, triggerId: input.triggerId });
      return { runId: `run-${iniciados.length}` };
    },
  } as unknown as ExecutionService;
  const semConferencia: SweepFn = async () => ({ checked: 0, settled: [], stillOpen: 0, unreadable: 0, failed: [] }) as never;
  const scheduler = new Scheduler(
    db,
    triggers,
    executions,
    {} as McpService,
    {} as SlackService,
    poll ?? (async () => []),
    sweep ?? semConferencia,
    viewer ?? (async () => "eu"),
  );
  return { db, scheduler, iniciados };
}

function gatilho(id: string, config: TriggerConfig, enabled = true): TriggerEntry {
  return { id, agentId: `agent-${id}`, config, enabled };
}

test("gatilho de relógio dispara, espera a cadência e dispara de novo", async () => {
  const { scheduler, iniciados } = montar({
    gatilhos: [gatilho("g1", { kind: "schedule", everyMinutes: 30 } as TriggerConfig)],
  });

  const primeira = await scheduler.tick({ at: T0 });
  assert.equal(primeira.outcomes[0]?.status, "fired");
  assert.equal(primeira.nextDueAt, T0 + 30 * MINUTO);

  const cedo = await scheduler.tick({ at: T0 + 10 * MINUTO });
  assert.equal(cedo.outcomes[0]?.status, "waiting");
  assert.equal(cedo.outcomes[0]?.nextDueAt, T0 + 30 * MINUTO);

  // Depois de um sono longo, uma batida só, e não uma por janela perdida.
  const depoisDoSono = await scheduler.tick({ at: T0 + 5 * 60 * MINUTO, reason: "wake" });
  assert.equal(depoisDoSono.outcomes[0]?.status, "fired");
  assert.equal(iniciados.length, 2);
});

test("gatilho que falha anda o relógio do mesmo jeito, e webhook não entra na batida", async () => {
  const { scheduler } = montar({
    gatilhos: [
      gatilho("quebrado", { kind: "poll", source: "gitlab", repoMatch: ".", authorship: "any", includeDrafts: false, everyMinutes: 15 } as TriggerConfig),
      gatilho("gancho", { kind: "webhook" } as TriggerConfig),
    ],
  });

  const batida = await scheduler.tick({ at: T0 });
  const [quebrado, gancho] = batida.outcomes;
  assert.equal(quebrado?.status, "failed");
  assert.match(quebrado?.detail ?? "", /gitlab/);
  assert.equal(gancho?.status, "skipped");
  assert.equal(batida.nextDueAt, T0 + 15 * MINUTO);

  const seguinte = await scheduler.tick({ at: T0 + MINUTO });
  assert.equal(seguinte.outcomes[0]?.status, "waiting");
});

test("filtro de autoria acorda só os pull requests da pessoa e conta os descartados", async () => {
  const { db, scheduler, iniciados } = montar({
    gatilhos: [
      gatilho("meus", { kind: "poll", source: "github", owner: "org", repoMatch: ".", authorship: "mine", includeDrafts: false, everyMinutes: 15 } as TriggerConfig),
    ],
    poll: async () => {
      await db.insert(schema.events).values([
        { id: "e1", source: "github", externalId: "pr-1", payload: { author: "eu" } },
        { id: "e2", source: "github", externalId: "pr-2", payload: { author: "outra" } },
      ]);
      return ["e1", "e2"];
    },
  });

  const batida = await scheduler.tick({ at: T0 });
  const resultado = batida.outcomes[0];
  assert.equal(resultado?.status, "fired");
  assert.equal(resultado?.events, 2);
  assert.deepEqual(iniciados.map((i) => i.eventId), ["e1"]);
  assert.match(resultado?.detail ?? "", /1 evento\(s\) fora do filtro/);
});

test("autoria sem conta conferida recusa a batida em vez de acordar todo mundo", async () => {
  const { db, scheduler, iniciados } = montar({
    gatilhos: [
      gatilho("meus", { kind: "poll", source: "github", owner: "org", repoMatch: ".", authorship: "mine", includeDrafts: false, everyMinutes: 15 } as TriggerConfig),
    ],
    poll: async () => {
      await db.insert(schema.events).values({ id: "e1", source: "github", externalId: "pr-1", payload: { author: "eu" } });
      return ["e1"];
    },
    viewer: async () => null,
  });

  const batida = await scheduler.tick({ at: T0 });
  assert.equal(batida.outcomes[0]?.status, "failed");
  assert.equal(iniciados.length, 0);
});

test("conferência que estoura não derruba a batida", async () => {
  const { scheduler } = montar({
    gatilhos: [gatilho("g1", { kind: "schedule", everyMinutes: 30 } as TriggerConfig)],
    sweep: async () => {
      throw new Error("GitHub fora do ar");
    },
  });

  const batida = await scheduler.tick({ at: T0 });
  assert.equal(batida.outcomes[0]?.status, "fired");
  assert.equal(batida.reconciled.detail, "GitHub fora do ar");
});

test("agenda mostra gatilho desabilitado sem prometer batida, e o que nunca disparou está vencido", async () => {
  const { scheduler } = montar({
    gatilhos: [
      gatilho("ligado", { kind: "schedule", everyMinutes: 30 } as TriggerConfig),
      gatilho("desligado", { kind: "schedule", everyMinutes: 30 } as TriggerConfig, false),
    ],
  });

  const agenda = await scheduler.schedule(T0);
  assert.deepEqual(
    agenda.map((s) => [s.triggerId, s.nextDueAt, s.everyMinutes]),
    [
      ["ligado", T0, 30],
      ["desligado", null, 30],
    ],
  );
  assert.equal(await scheduler.nextDueAt(T0), T0);
});
