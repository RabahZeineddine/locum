import { test } from "node:test";
import assert from "node:assert/strict";
import { scanOpenPullRequests, type PollClient } from "../src/sources/github.js";
import type { PollFilters } from "../src/config/types.js";
import { bancoDeTeste } from "./helpers/db.js";
import { githubFalso, type Membros, type Pr } from "./helpers/github-falso.js";

const agora = Date.parse("2026-09-22T12:00:00Z");

/** Roda a varredura e devolve os números dos PRs que entraram, mais os descartes. */
async function varrer(prs: Pr[], filters: PollFilters | undefined, extra: { viewer?: string | null; membros?: Membros; includeDrafts?: boolean } = {}) {
  const db = bancoDeTeste();
  const { client, chamadas } = githubFalso(prs, extra.membros);
  const varredura = await scanOpenPullRequests("o", /.*/, {
    client,
    db,
    now: agora,
    diffMaxChars: 100_000,
    filters,
    viewer: extra.viewer ?? null,
    includeDrafts: extra.includeDrafts,
  });
  const linhas = await db.query.events.findMany();
  const entraram = linhas
    .filter((e) => varredura.eventIds.includes(e.id))
    .map((e) => (e.payload as { pull: number }).pull)
    .sort((a, b) => a - b);
  return { entraram, descartes: varredura.descartes ?? [], chamadas, varredura, db, client };
}

const motivoDe = (r: { descartes: { pr: string; motivo: string }[] }, n: number) =>
  r.descartes.find((d) => d.pr === `o/api#${n}`)?.motivo;

test("authors.include deixa entrar quem está na lista e descarta o resto com o motivo", async () => {
  const r = await varrer(
    [{ number: 1, author: "ana" }, { number: 2, author: "bia" }],
    { authors: { include: ["ANA"] } },
  );
  assert.deepEqual(r.entraram, [1]);
  assert.equal(motivoDe(r, 2), "autor bia fora da lista");
});

test("authors.include aceita @me e resolve pela conta do token", async () => {
  const prs = [{ number: 1, author: "rabah" }, { number: 2, author: "bia" }];
  const r = await varrer(prs, { authors: { include: ["@me"] } }, { viewer: "Rabah" });
  assert.deepEqual(r.entraram, [1]);
  assert.match(r.chamadas.buscas[0]!, /author:Rabah/);
});

test("@me sem conta conferida derruba a batida em vez de passar sem conferir", async () => {
  await assert.rejects(
    varrer([{ number: 1 }], { authors: { exclude: ["@me"] } }, { viewer: null }),
    /conta do GitHub/,
  );
});

test("authors.exclude derruba o autor listado e deixa os outros", async () => {
  const r = await varrer(
    [{ number: 1, author: "dependabot[bot]" }, { number: 2, author: "bia" }],
    { authors: { exclude: ["dependabot[bot]"] } },
  );
  assert.deepEqual(r.entraram, [2]);
  assert.equal(motivoDe(r, 1), "autor dependabot[bot] na lista de exclusão");
});

test("reviewRequested aceita pessoa ou time, e basta um dos dois", async () => {
  const prs: Pr[] = [
    { number: 1, reviewers: ["rabah"] },
    { number: 2, teams: ["backend"] },
    { number: 3, reviewers: ["outra"], teams: ["web"] },
    { number: 4 },
  ];
  const r = await varrer(prs, { reviewRequested: { users: ["@me"], teams: ["o/backend"] } }, { viewer: "rabah" });
  assert.deepEqual(r.entraram, [1, 2]);
  assert.equal(motivoDe(r, 3), "sem review pedido para rabah ou o/backend");
  assert.equal(motivoDe(r, 4), "sem review pedido para rabah ou o/backend");
  // Duas opções de OU: o qualificador seria E, então a decisão fica em código.
  assert.doesNotMatch(r.chamadas.buscas[0]!, /review-requested/);
});

test("reviewRequested com um alvo só vai também para a busca", async () => {
  const r = await varrer([{ number: 1, teams: ["backend"] }], { reviewRequested: { teams: ["o/backend"] } });
  assert.deepEqual(r.entraram, [1]);
  assert.match(r.chamadas.buscas[0]!, /team-review-requested:o\/backend/);
});

test("teamMembers deixa entrar o autor que é membro do time", async () => {
  const membros = { "o/backend": ["ana"], "o/web": ["bia"] };
  const prs: Pr[] = [{ number: 1, author: "ana" }, { number: 2, author: "bia" }, { number: 3, author: "caio" }];
  const r = await varrer(prs, { teamMembers: ["o/backend"] }, { membros });
  assert.deepEqual(r.entraram, [1]);
  assert.equal(motivoDe(r, 3), "autor caio fora do time o/backend");

  const ou = await varrer(prs, { teamMembers: ["o/backend", "o/web"] }, { membros });
  assert.deepEqual(ou.entraram, [1, 2]);
  assert.equal(motivoDe(ou, 3), "autor caio fora dos times o/backend, o/web");
});

test("teamMembers consulta cada time uma vez por batida", async () => {
  const prs: Pr[] = [{ number: 1, author: "ana" }, { number: 2, author: "ana" }, { number: 3, author: "bia" }];
  const r = await varrer(prs, { teamMembers: ["o/backend"] }, { membros: { "o/backend": ["ana", "bia"] } });
  assert.deepEqual(r.chamadas.membros, ["o/backend"]);
});

for (const status of [403, 404]) {
  test(`teamMembers falha fechado quando o GitHub responde ${status}`, async () => {
    const r = await varrer([{ number: 1, author: "ana" }], { teamMembers: ["o/backend"] }, { membros: { "o/backend": { status } } });
    assert.deepEqual(r.entraram, []);
    assert.equal(motivoDe(r, 1), "não deu para conferir o time o/backend: o token precisa de read:org");
  });
}

test("teamMembers com erro que não é de acesso derruba a batida, para o cursor não andar", async () => {
  await assert.rejects(
    varrer([{ number: 1 }], { teamMembers: ["o/backend"] }, { membros: { "o/backend": { status: 502 } } }),
    /Not Found/,
  );
});

test("labels.include entra com qualquer uma e labels.exclude derruba", async () => {
  const prs: Pr[] = [
    { number: 1, labels: ["bug"] },
    { number: 2, labels: ["Feature", "wip"] },
    { number: 3, labels: ["docs"] },
    { number: 4, labels: [] },
  ];
  const r = await varrer(prs, { labels: { include: ["bug", "feature"], exclude: ["wip"] } });
  assert.deepEqual(r.entraram, [1]);
  assert.equal(motivoDe(r, 2), "com a label wip");
  assert.equal(motivoDe(r, 3), "sem a label bug ou feature");
  assert.equal(motivoDe(r, 4), "sem a label bug ou feature");
  assert.match(r.chamadas.buscas[0]!, /label:"bug","feature"/);
  assert.match(r.chamadas.buscas[0]!, /-label:"wip"/);
});

test("baseBranches aceita glob", async () => {
  const prs: Pr[] = [
    { number: 1, base: "main" },
    { number: 2, base: "release/1.4" },
    { number: 3, base: "feature/x" },
  ];
  const r = await varrer(prs, { baseBranches: ["main", "release/*"] });
  assert.deepEqual(r.entraram, [1, 2]);
  assert.equal(motivoDe(r, 3), "base feature/x fora de main, release/*");
});

test("baseBranches de um nome exato também vai para a busca", async () => {
  const r = await varrer([{ number: 1 }], { baseBranches: ["main"] });
  assert.match(r.chamadas.buscas[0]!, /base:main/);
  const glob = await varrer([{ number: 1 }], { baseBranches: ["release/*"] });
  assert.doesNotMatch(glob.chamadas.buscas[0]!, /base:/);
});

test("paths.include e paths.exclude olham os arquivos alterados", async () => {
  const prs: Pr[] = [
    { number: 1, files: ["src/a.ts", "README.md"] },
    { number: 2, files: ["docs/guia.md", "src/leia-me.md"] },
    { number: 3, files: ["scripts/x.sh"] },
  ];
  const r = await varrer(prs, { paths: { include: ["src/**"], exclude: ["**/*.md"] } });
  assert.deepEqual(r.entraram, [1]);
  assert.equal(motivoDe(r, 2), "só mexe em **/*.md");
  assert.equal(motivoDe(r, 3), "nenhum arquivo em src/**");
});

test("paths só com exclusão derruba o PR que só mexe nos arquivos excluídos", async () => {
  const prs: Pr[] = [
    { number: 1, files: ["docs/a.md", "docs/b.md"] },
    { number: 2, files: ["docs/a.md", "src/b.ts"] },
  ];
  const r = await varrer(prs, { paths: { exclude: ["docs/**"] } });
  assert.deepEqual(r.entraram, [2]);
  assert.equal(motivoDe(r, 1), "só mexe em docs/**");
});

test("um glob com ! na frente do include vale como exclusão", async () => {
  const r = await varrer([{ number: 1, files: ["a.md"] }, { number: 2, files: ["a.ts"] }], { paths: { include: ["**", "!**/*.md"] } });
  assert.deepEqual(r.entraram, [2]);
});

test("maxChangedLines soma additions e deletions", async () => {
  const prs: Pr[] = [
    { number: 1, additions: 200, deletions: 100 },
    { number: 2, additions: 200, deletions: 145 },
  ];
  const r = await varrer(prs, { maxChangedLines: 300 });
  assert.deepEqual(r.entraram, [1]);
  assert.equal(motivoDe(r, 2), "345 linhas, teto 300");
});

test("rascunho descartado também aparece com o motivo", async () => {
  const r = await varrer([{ number: 1, draft: true }], undefined);
  assert.deepEqual(r.entraram, []);
  assert.equal(motivoDe(r, 1), "draft");
});

test("filtros diferentes combinam em E, e a lista de cada um em OU", async () => {
  const prs: Pr[] = [
    { number: 1, author: "ana", labels: ["bug"], base: "main" },
    { number: 2, author: "bia", labels: ["feature"], base: "main" },
    { number: 3, author: "ana", labels: ["bug"], base: "dev" },
    { number: 4, author: "caio", labels: ["bug"], base: "main" },
  ];
  const r = await varrer(prs, {
    authors: { include: ["ana", "bia"] },
    labels: { include: ["bug", "feature"] },
    baseBranches: ["main"],
  });
  assert.deepEqual(r.entraram, [1, 2]);
  assert.equal(motivoDe(r, 3), "base dev fora de main");
  assert.equal(motivoDe(r, 4), "autor caio fora da lista");
});

test("sem filters a varredura faz o que fazia: mesma consulta e mesmos eventos", async () => {
  const prs: Pr[] = [{ number: 1, author: "x", labels: ["a"], base: "dev" }, { number: 2 }];
  const sem = await varrer(prs, undefined);
  const vazio = await varrer(prs, {});
  assert.deepEqual(sem.entraram, [1, 2]);
  assert.deepEqual(vazio.entraram, [1, 2]);
  assert.equal(sem.chamadas.buscas[0], "is:pr is:open org:o draft:false updated:>=2026-09-21T12:00:00Z");
  assert.equal(vazio.chamadas.buscas[0], sem.chamadas.buscas[0]);
  assert.deepEqual(sem.descartes, []);
});

test("mudar os filtros não reprocessa o que já virou evento", async () => {
  const db = bancoDeTeste();
  const { client } = githubFalso([
    { number: 1, author: "ana", labels: ["bug"] },
    { number: 2, author: "bia", labels: ["bug"] },
  ]);
  const base = { client, db, now: agora, diffMaxChars: 100_000, viewer: null };

  const primeira = await scanOpenPullRequests("o", /.*/, { ...base, filters: { authors: { include: ["ana"] } } });
  assert.equal(primeira.created.length, 1);

  // Outro filtro, outro cursor: a janela recomeça, e o PR 1 volta a passar.
  const segunda = await scanOpenPullRequests("o", /.*/, { ...base, filters: { labels: { include: ["bug"] } } });
  assert.equal(segunda.created.length, 1, "só o PR 2, que ainda não era evento");
  assert.deepEqual(segunda.eventIds.filter((id) => primeira.eventIds.includes(id)), primeira.eventIds);
  assert.equal(segunda.eventIds.length, 2);

  const terceira = await scanOpenPullRequests("o", /.*/, { ...base, filters: { authors: { include: ["ana", "bia"] } } });
  assert.deepEqual(terceira.created, []);
  assert.equal(terceira.eventIds.length, 2);
});

test("PR já conhecido que o filtro novo recusa não volta para o gatilho", async () => {
  const db = bancoDeTeste();
  const { client, chamadas } = githubFalso([{ number: 1, files: ["docs/a.md"] }]);
  const base = { client, db, now: agora, diffMaxChars: 100_000, viewer: null };

  const aberta = await scanOpenPullRequests("o", /.*/, base);
  assert.equal(aberta.eventIds.length, 1);
  const arquivosAntes = chamadas.listFiles;

  const filtrada = await scanOpenPullRequests("o", /.*/, { ...base, filters: { paths: { exclude: ["docs/**"] } } });
  assert.deepEqual(filtrada.eventIds, []);
  assert.equal(filtrada.descartes?.[0]?.motivo, "só mexe em docs/**");
  assert.equal(chamadas.listFiles, arquivosAntes, "os arquivos saem do evento, sem nova ida ao GitHub");
});
