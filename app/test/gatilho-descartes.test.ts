import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { schema } from "../src/db/index.js";
import type { PollFilters, TriggerConfig } from "../src/config/types.js";
import type { ExecutionService } from "../src/services/execution-service.js";
import type { McpService } from "../src/services/mcp-service.js";
import type { SlackService } from "../src/services/slack-service.js";
import type { TriggerEntry, TriggerService } from "../src/services/trigger-service.js";
import { scanOpenPullRequests } from "../src/sources/github.js";
import { Scheduler, type PollFn, type SweepFn } from "../src/triggers/scheduler.js";
import { bancoDeTeste } from "./helpers/db.js";
import { githubFalso, type Pr } from "./helpers/github-falso.js";

const MINUTO = 60_000;
const T0 = Date.parse("2026-09-22T12:00:00Z");

function gatilho(filters?: PollFilters, authorship: "any" | "mine" | "others" = "any"): TriggerEntry {
  const config = {
    kind: "poll",
    source: "github",
    owner: "o",
    repoMatch: ".*",
    authorship,
    includeDrafts: false,
    everyMinutes: 15,
    ...(filters === undefined ? {} : { filters }),
  } as TriggerConfig;
  return { id: "g1", agentId: "agent-g1", config, enabled: true };
}

function montar(opcoes: { gatilho: () => TriggerEntry; poll: PollFn; viewer?: string | null; db?: ReturnType<typeof bancoDeTeste> }) {
  const db = opcoes.db ?? bancoDeTeste();
  // O run de mentira não tem versão de agent por trás.
  db.run(sql`PRAGMA foreign_keys = OFF`);
  const iniciados: { eventId: string | null }[] = [];
  const triggers = { enabled: async () => [opcoes.gatilho()], list: async () => [opcoes.gatilho()] } as unknown as TriggerService;
  const executions = {
    startForEvent: async (input: { eventId: string | null; triggerId: string }) => {
      iniciados.push({ eventId: input.eventId });
      const runId = `run-${iniciados.length}`;
      // O que o agendador consulta para saber que o gatilho já rodou o evento.
      await db.insert(schema.runs).values({ id: runId, agentVersionId: "v", triggerId: input.triggerId, eventId: input.eventId });
      return { runId };
    },
  } as unknown as ExecutionService;
  const semConferencia: SweepFn = async () => ({ checked: 0, settled: [], stillOpen: 0, unreadable: 0, failed: [] }) as never;
  const scheduler = new Scheduler(
    db,
    triggers,
    executions,
    {} as McpService,
    {} as SlackService,
    opcoes.poll,
    semConferencia,
    async () => (opcoes.viewer === undefined ? "eu" : opcoes.viewer),
  );
  return { db, scheduler, iniciados };
}

test("a batida entrega os filtros e a conta do token à varredura", async () => {
  const recebido: unknown[] = [];
  const filters: PollFilters = { authors: { include: ["@me"] } };
  const { scheduler } = montar({
    gatilho: () => gatilho(filters),
    poll: async (_owner, _repo, options) => {
      recebido.push(options);
      return { eventIds: [], created: [] };
    },
    viewer: "rabah",
  });
  await scheduler.tick({ at: T0 });
  assert.deepEqual(recebido, [{ includeDrafts: false, filters, viewer: "rabah" }]);
});

test("o descarte da varredura fica guardado com o motivo e aparece no detail da batida", async () => {
  const { scheduler } = montar({
    gatilho: () => gatilho({ maxChangedLines: 300 }),
    poll: async () => ({
      eventIds: [],
      created: [],
      descartes: [{ pr: "o/api#7", titulo: "Grande", autor: "ana", motivo: "345 linhas, teto 300" }],
    }),
  });
  const batida = await scheduler.tick({ at: T0 });
  assert.match(batida.outcomes[0]?.detail ?? "", /o\/api#7: 345 linhas, teto 300/);

  const guardados = await scheduler.descartes("g1");
  assert.equal(guardados.length, 1);
  assert.equal(guardados[0]?.motivo, "345 linhas, teto 300");
  assert.equal(guardados[0]?.titulo, "Grande");
  assert.equal(guardados[0]?.em, T0);
});

test("o mesmo descarte repetido a cada batida vira uma linha só, e a lista guarda os 50 mais novos", async () => {
  let rodada = 0;
  const { scheduler } = montar({
    gatilho: () => gatilho({ maxChangedLines: 1 }),
    poll: async () => {
      rodada++;
      const novos = Array.from({ length: 30 }, (_, i) => ({ pr: `o/api#${rodada * 100 + i}`, motivo: "draft" }));
      return { eventIds: [], created: [], descartes: [{ pr: "o/api#1", motivo: "draft" }, ...novos] };
    },
  });
  await scheduler.tick({ at: T0 });
  await scheduler.tick({ at: T0 + 20 * MINUTO });
  const guardados = await scheduler.descartes("g1");
  assert.equal(guardados.length, 50);
  assert.equal(guardados.filter((d) => d.pr === "o/api#1").length, 1);
  assert.equal(guardados[0]?.em, T0 + 20 * MINUTO);
});

test("o PR que o filtro de autoria barra também vira descarte com o motivo", async () => {
  const { db, scheduler } = montar({
    gatilho: () => gatilho(undefined, "others"),
    poll: async () => {
      await db.insert(schema.events).values({
        id: "e1",
        source: "github",
        externalId: "pr-1",
        payload: { author: "eu", repo: "o/api", pull: 4, title: "Meu", url: "https://example.invalid/4" },
      });
      return { eventIds: ["e1"], created: ["e1"] };
    },
  });
  await scheduler.tick({ at: T0 });
  const [descarte] = await scheduler.descartes("g1");
  assert.equal(descarte?.pr, "o/api#4");
  assert.match(descarte?.motivo ?? "", /autoria "others"/);
});

test("trocar o filtro do gatilho não abre run de novo para o PR que já rodou", async () => {
  const prs: Pr[] = [{ number: 1, author: "ana", labels: ["bug"] }];
  const { client } = githubFalso(prs);
  let atual: PollFilters = { authors: { include: ["ana"] } };
  const db = bancoDeTeste();
  const { scheduler, iniciados } = montar({
    db,
    gatilho: () => gatilho(atual),
    poll: (owner, repo, options) => scanOpenPullRequests(owner, repo, { ...options, client, db, now: T0, diffMaxChars: 100_000 }),
  });

  await scheduler.tick({ at: T0 });
  assert.equal(iniciados.length, 1);

  atual = { labels: { include: ["bug"] } };
  await scheduler.tick({ at: T0 + 20 * MINUTO });
  atual = {};
  await scheduler.tick({ at: T0 + 40 * MINUTO });
  assert.equal(iniciados.length, 1, "o mesmo commit não roda de novo, qualquer que seja o filtro");
});
