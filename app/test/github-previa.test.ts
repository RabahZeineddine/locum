import { test } from "node:test";
import assert from "node:assert/strict";
import { scanOpenPullRequests } from "../src/sources/github.js";
import { previaDoGatilho } from "../src/services/trigger-preview.js";
import type { PollFilters } from "../src/config/types.js";
import { bancoDeTeste } from "./helpers/db.js";
import { githubFalso, type Pr } from "./helpers/github-falso.js";

const agora = Date.parse("2026-09-22T12:00:00Z");

const gatilho = (filters?: PollFilters, extra: Record<string, unknown> = {}) => ({
  kind: "poll" as const,
  source: "github",
  owner: "o",
  repoMatch: ".*",
  ...extra,
  ...(filters === undefined ? {} : { filters }),
});

const PRS: Pr[] = [
  { number: 1, author: "ana", labels: ["bug"], additions: 10 },
  { number: 2, author: "bia", labels: ["bug"], additions: 10 },
  { number: 3, author: "ana", labels: ["docs"], additions: 900 },
  { number: 4, author: "ana", labels: ["bug"], draft: true },
  { number: 5, author: "ana", labels: ["bug"], base: "dev" },
];
const FILTROS: PollFilters = {
  authors: { include: ["ana"] },
  labels: { include: ["bug"] },
  baseBranches: ["main"],
  maxChangedLines: 300,
};

test("a prévia diz, por PR, se entra e por quê", async () => {
  const { client } = githubFalso(PRS);
  const db = bancoDeTeste();
  const previa = await previaDoGatilho(gatilho(FILTROS), { client, db, viewer: async () => null });
  const por = Object.fromEntries(previa.itens.map((i) => [i.pr, i]));
  assert.equal(por["o/api#1"]?.entra, true);
  assert.equal(por["o/api#2"]?.motivo, "autor bia fora da lista");
  assert.equal(por["o/api#3"]?.motivo, "sem a label bug");
  assert.equal(por["o/api#4"]?.motivo, "draft");
  assert.equal(por["o/api#5"]?.motivo, "base dev fora de main");
  assert.equal(por["o/api#1"]?.titulo, "PR 1");
  assert.equal(por["o/api#1"]?.autor, "ana");
  assert.equal(por["o/api#1"]?.url, "https://example.invalid/pr/1");
});

test("a prévia entra exatamente nos PRs em que a varredura grava evento", async () => {
  const { client } = githubFalso(PRS);
  const previa = await previaDoGatilho(gatilho(FILTROS), { client, db: bancoDeTeste(), viewer: async () => null });
  const dosFiltros = previa.itens.filter((i) => i.entra).map((i) => i.pr);

  const db = bancoDeTeste();
  const varredura = await scanOpenPullRequests("o", /.*/, { client, db, now: agora, diffMaxChars: 100_000, filters: FILTROS });
  const eventos = await db.query.events.findMany();
  const gravados = eventos.filter((e) => varredura.created.includes(e.id)).map((e) => `o/api#${(e.payload as { pull: number }).pull}`);
  assert.deepEqual(dosFiltros.sort(), gravados.sort());
  assert.deepEqual(
    previa.itens.filter((i) => !i.entra).map((i) => [i.pr, i.motivo]).sort(),
    (varredura.descartes ?? []).map((d) => [d.pr, d.motivo]).sort(),
  );
});

test("a prévia não escreve cursor, evento nem descarte", async () => {
  const { client } = githubFalso(PRS);
  const db = bancoDeTeste();
  await previaDoGatilho(gatilho(FILTROS), { client, db, viewer: async () => null });
  assert.deepEqual(await db.query.events.findMany(), []);
  assert.deepEqual(await db.query.cursors.findMany(), []);
});

test("a prévia também olha PR de dias atrás, sem janela de cursor", async () => {
  const { client, chamadas } = githubFalso(PRS);
  await previaDoGatilho(gatilho(), { client, db: bancoDeTeste(), viewer: async () => null });
  assert.doesNotMatch(chamadas.buscas[0]!, /updated:/);
  assert.match(chamadas.buscas[0]!, /is:pr is:open org:o/);
});

test("com rascunhos ligados o PR em draft entra", async () => {
  const { client } = githubFalso(PRS);
  const previa = await previaDoGatilho(gatilho(undefined, { includeDrafts: true }), { client, db: bancoDeTeste(), viewer: async () => null });
  assert.equal(previa.itens.find((i) => i.pr === "o/api#4")?.entra, true);
});

test("a prévia marca o PR que já virou evento e resolve @me pela conta", async () => {
  const { client } = githubFalso(PRS);
  const db = bancoDeTeste();
  await scanOpenPullRequests("o", /.*/, { client, db, now: agora, diffMaxChars: 100_000 });
  const previa = await previaDoGatilho(gatilho({ authors: { include: ["@me"] } }), { client, db, viewer: async () => "bia" });
  const dois = previa.itens.find((i) => i.pr === "o/api#2");
  assert.equal(dois?.entra, true);
  assert.equal(dois?.jaVirouEvento, true);
  assert.equal(previa.itens.find((i) => i.pr === "o/api#1")?.entra, false);
});

test("a prévia limita a 50 PRs e avisa quando cortou", async () => {
  const muitos: Pr[] = Array.from({ length: 80 }, (_, i) => ({ number: i + 1 }));
  const { client } = githubFalso(muitos);
  const previa = await previaDoGatilho(gatilho(), { client, db: bancoDeTeste(), viewer: async () => null });
  assert.equal(previa.itens.length, 50);
  assert.equal(previa.cortada, true);
});

test("a prévia recusa gatilho que não é de varredura do GitHub", async () => {
  await assert.rejects(previaDoGatilho({ kind: "cron", expression: "* * * * *" } as never, { db: bancoDeTeste() }), /varredura do GitHub/);
});
