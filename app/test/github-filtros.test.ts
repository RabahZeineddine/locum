import { test } from "node:test";
import assert from "node:assert/strict";
import { scanOpenPullRequests, type PollClient } from "../src/sources/github.js";
import type { Authorship, PollFilters } from "../src/config/types.js";
import { bancoDeTeste } from "./helpers/db.js";
import { githubFalso, type Membros, type Mundo, type Pr } from "./helpers/github-falso.js";

const agora = Date.parse("2026-09-22T12:00:00Z");

/** Roda a varredura e devolve os números dos PRs que entraram, mais os descartes. */
async function varrer(prs: Pr[], filters: PollFilters | undefined, extra: { viewer?: string | null; membros?: Membros; includeDrafts?: boolean; authorship?: Authorship; mundo?: Mundo } = {}) {
  const db = bancoDeTeste();
  const { client, chamadas } = githubFalso(prs, extra.membros, extra.mundo);
  const varredura = await scanOpenPullRequests("o", /.*/, {
    client,
    db,
    now: agora,
    diffMaxChars: 100_000,
    filters,
    viewer: extra.viewer ?? null,
    includeDrafts: extra.includeDrafts,
    authorship: extra.authorship,
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
  assert.doesNotMatch(r.chamadas.buscas[0]!, /author:/);
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
  const r = await varrer(prs, { reviewRequested: { users: ["@me"], teams: ["o/backend"] } }, { viewer: "rabah", membros: { "o/backend": [], "o/web": [] } });
  assert.deepEqual(r.entraram, [1, 2]);
  assert.equal(motivoDe(r, 3), "sem review pedido para rabah ou o/backend");
  assert.equal(motivoDe(r, 4), "sem review pedido para rabah ou o/backend");
  // Duas opções de OU: o qualificador seria E, então a decisão fica em código.
  assert.doesNotMatch(r.chamadas.buscas[0]!, /review-requested/);
});

test("login e time nunca vão para a consulta: login que não existe não derruba a busca", async () => {
  const prs: Pr[] = [{ number: 1, author: "ana", teams: ["backend"] }];
  const r = await varrer(prs, {
    authors: { include: ["fantasma"], exclude: ["outro-fantasma"] },
    reviewRequested: { users: ["terceiro-fantasma"] },
  });
  assert.deepEqual(r.entraram, []);
  assert.doesNotMatch(r.chamadas.buscas[0]!, /author:|review-requested:/);

  const time = await varrer(prs, { reviewRequested: { teams: ["o/backend"] } });
  assert.deepEqual(time.entraram, [1]);
  assert.doesNotMatch(time.chamadas.buscas[0]!, /team-review-requested/);
});

test("review pedido a um time de que a pessoa é membro conta como pedido a ela", async () => {
  const prs: Pr[] = [{ number: 1, teams: ["backend"] }, { number: 2, teams: ["web"] }, { number: 3 }];
  const membros = { "o/backend": ["rabah"], "o/web": ["outra"] };
  const r = await varrer(prs, { reviewRequested: { users: ["@me"] } }, { viewer: "Rabah", membros });
  assert.deepEqual(r.entraram, [1]);
  assert.equal(motivoDe(r, 2), "sem review pedido para Rabah");
});

/** A batida falha e o cursor não anda: corrigido o que deu errado, os PRs voltam. */
async function falhaSemAndar(membro: Membros[string], erro: RegExp) {
  const db = bancoDeTeste();
  const { client } = githubFalso([{ number: 1, author: "ana" }], { "o/backend": membro });
  await assert.rejects(
    scanOpenPullRequests("o", /.*/, { client, db, now: agora, diffMaxChars: 100_000, filters: { teamMembers: ["o/backend"] } }),
    erro,
  );
  assert.deepEqual(await db.query.cursors.findMany(), [], "o cursor não andou");
  assert.deepEqual(await db.query.events.findMany(), []);
}

/** Time ilegível: a batida segue, o PR fica de fora com o motivo e o erro de configuração é devolvido. */
async function timeIlegivel(membro: Membros[string], razao: string) {
  const r = await varrer([{ number: 1, author: "ana" }], { teamMembers: ["o/backend"] }, { membros: { "o/backend": membro } });
  assert.deepEqual(r.entraram, []);
  assert.equal(motivoDe(r, 1), `time o/backend ilegível: ${razao}`);
  assert.deepEqual(r.varredura.configuracao, [`time o/backend ilegível: ${razao}`]);
  assert.equal((await r.db.query.cursors.findMany()).length, 1, "o cursor andou: um time ilegível não prende o gatilho");
}

test("time sem read:org (403) deixa o PR de fora dizendo o que fazer, e a batida segue", async () => {
  await timeIlegivel({ status: 403, message: "Resource not accessible by personal access token" }, "o token precisa de read:org");
});

test("time atrás de SSO não autorizado pede para autorizar o token na org", async () => {
  await timeIlegivel({ status: 403, message: "Resource protected by organization SAML enforcement", headers: { "x-github-sso": "required" } }, "autorize o token no SSO da org");
});

test("time inexistente ou invisível (404) é erro de configuração, e a batida segue", async () => {
  await timeIlegivel({ status: 404 }, "time não encontrado ou sem acesso");
});

test("um time ilegível não prende o PR que outro time do filtro confirma", async () => {
  const membros = { "o/backend": ["ana"], "o/sumido": { status: 404 } } as Membros;
  const prs: Pr[] = [{ number: 1, author: "ana" }, { number: 2, author: "bia" }];
  const r = await varrer(prs, { teamMembers: ["o/sumido", "o/backend"] }, { membros });
  assert.deepEqual(r.entraram, [1]);
  assert.equal(motivoDe(r, 2), "autor bia fora do time o/backend; time o/sumido ilegível: time não encontrado ou sem acesso");
  assert.equal(r.varredura.configuracao?.length, 1);
});

test("review pedido a time ilegível conta como não pedido, com a nota no motivo, sem derrubar a batida", async () => {
  const prs: Pr[] = [{ number: 1, teams: ["backend"] }, { number: 2, reviewers: ["rabah"] }];
  const r = await varrer(prs, { reviewRequested: { users: ["rabah"] } }, { membros: { "o/backend": { status: 403 } } });
  assert.deepEqual(r.entraram, [2]);
  assert.equal(motivoDe(r, 1), "sem review pedido para rabah (time o/backend ilegível: o token precisa de read:org)");
  assert.deepEqual(r.varredura.configuracao, ["time o/backend ilegível: o token precisa de read:org"]);
});

test("limite de uso, 5xx e rede sobem como vieram, sem virar motivo de permissão", async () => {
  await falhaSemAndar({ status: 403, message: "API rate limit exceeded", headers: { "x-ratelimit-remaining": "0" } }, /rate limit/);
  await falhaSemAndar({ status: 403, message: "You have exceeded a secondary rate limit" }, /secondary rate limit/);
  await falhaSemAndar({ status: 429, message: "Too Many Requests" }, /Too Many Requests/);
  await falhaSemAndar({ status: 502, message: "Bad Gateway" }, /Bad Gateway/);
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

test("o padrão que a tela monta pelo nome (api-*) casa com o repositório, sem o dono na frente", async () => {
  const db = bancoDeTeste();
  const { client } = githubFalso([{ number: 1, repo: "api-x" }, { number: 2, repo: "web" }]);
  const varredura = await scanOpenPullRequests("o", /^api-.*$/, { client, db, now: agora, diffMaxChars: 100_000 });
  assert.equal(varredura.eventIds.length, 1);
  assert.equal((await db.query.events.findMany())[0]?.externalId, "pr:o/api-x#1:sha:sha1");

  // O padrão antigo, escrito com o dono (`^o/api$`), continua valendo.
  const comDono = await scanOpenPullRequests("o", /^o\/web$/, { client, db: bancoDeTeste(), now: agora, diffMaxChars: 100_000 });
  assert.equal(comDono.eventIds.length, 1);
});

test("padrão de repositório com dono continua valendo só contra dono/repo", async () => {
  const prs: Pr[] = [{ number: 1, repo: "legacy-a" }, { number: 2, repo: "novo" }];
  const db = bancoDeTeste();
  const { client } = githubFalso(prs);
  const varredura = await scanOpenPullRequests("o", /^(?!o\/legacy-)/, { client, db, now: agora, diffMaxChars: 100_000 });
  const eventos = await db.query.events.findMany();
  assert.deepEqual(eventos.filter((e) => varredura.eventIds.includes(e.id)).map((e) => (e.payload as { pull: number }).pull), [2]);
});

test("glob de caminho sem barra casa em qualquer pasta, e aceita {a,b} e [..]", async () => {
  const prs: Pr[] = [
    { number: 1, files: ["docs/guia.md"] },
    { number: 2, files: ["src/a.ts"] },
    { number: 3, files: ["src/b.js", "lib/v1.json"] },
  ];
  const r = await varrer(prs, { paths: { exclude: ["*.md"] } });
  assert.deepEqual(r.entraram, [2, 3]);
  const chaves = await varrer(prs, { paths: { include: ["**/*.{ts,js}", "lib/v[0-9].json"] } });
  assert.deepEqual(chaves.entraram, [2, 3]);
});

test("autoria others descarta o PR do dono do token, com o mesmo motivo de sempre", async () => {
  const prs: Pr[] = [{ number: 1, author: "rabah" }, { number: 2, author: "ana" }];
  const r = await varrer(prs, undefined, { viewer: "Rabah", authorship: "others" });
  assert.deepEqual(r.entraram, [2]);
  assert.equal(motivoDe(r, 1), 'PR de rabah, que é você (autoria "others")');
  const mine = await varrer(prs, undefined, { viewer: "Rabah", authorship: "mine" });
  assert.deepEqual(mine.entraram, [1]);
  await assert.rejects(varrer(prs, undefined, { viewer: null, authorship: "others" }), /conta do GitHub/);
});

test("others com authors.include @me não deixa passar ninguém, na varredura e na prévia", async () => {
  const prs: Pr[] = [{ number: 1, author: "rabah" }, { number: 2, author: "ana" }];
  const r = await varrer(prs, { authors: { include: ["@me"] } }, { viewer: "rabah", authorship: "others" });
  assert.deepEqual(r.entraram, []);
});

test("app fechado por dias: o cursor parado não vira teto, e o PR aberto antes entra", async () => {
  const db = bancoDeTeste();
  const { client, chamadas } = githubFalso([{ number: 1 }]);
  const base = { client, db, now: agora, diffMaxChars: 100_000, authorship: "others" as const, viewer: "rabah", triggerId: "g1" };
  await scanOpenPullRequests("o", /.*/, base);
  const tresDias = agora + 3 * 24 * 3600_000;
  await scanOpenPullRequests("o", /.*/, { ...base, now: tresDias });
  assert.match(chamadas.buscas.at(-1)!, /updated:>=2026-09-22T10:00:00Z/, "a janela segue do cursor, e não de 24h atrás");
});

test("gatilho others sem filtros que já varria herda o cursor do escopo, sem teto de 24h", async () => {
  const db = bancoDeTeste();
  const { client, chamadas } = githubFalso([{ number: 1 }]);
  const { schema } = await import("../src/db/index.js");
  await db.insert(schema.cursors).values({ source: "github", key: "prs:o", value: "2026-09-10T00:00:00Z" });
  await scanOpenPullRequests("o", /.*/, { client, db, now: agora, diffMaxChars: 100_000, authorship: "others", viewer: "rabah", triggerId: "g1" });
  assert.match(chamadas.buscas.at(-1)!, /updated:>=2026-09-10T00:00:00Z/);
  // Sem autoria nem filtro a chave é a de sempre.
  const chaves = (await db.query.cursors.findMany()).filter((c) => c.source === "github").map((c) => c.key);
  assert.ok(chaves.includes("prs:o") && chaves.length === 2);
});

test("mudar o filtro herda o cursor que o gatilho tinha, e o hash que nunca teve cursor olha 24h", async () => {
  const db = bancoDeTeste();
  const { client, chamadas } = githubFalso([{ number: 1 }]);
  const base = { client, db, now: agora, diffMaxChars: 100_000, triggerId: "g1" };
  await scanOpenPullRequests("o", /.*/, { ...base, filters: { maxChangedLines: 500 } });
  const { schema } = await import("../src/db/index.js");
  await db.update(schema.cursors).set({ value: "2026-09-18T00:00:00Z" }).where((await import("drizzle-orm")).eq(schema.cursors.source, "github"));
  await scanOpenPullRequests("o", /.*/, { ...base, now: agora + 3600_000, filters: { maxChangedLines: 300 } });
  assert.match(chamadas.buscas.at(-1)!, /updated:>=2026-09-18T00:00:00Z/);

  // Outro gatilho, sem histórico nenhum: primeira vez, 24h.
  await scanOpenPullRequests("o", /.*/, { ...base, triggerId: "g2", filters: { maxChangedLines: 100 } });
  assert.match(chamadas.buscas.at(-1)!, /updated:>=2026-09-21T12:00:00Z/);
});

test("docs e docs/ pegam o que está dentro da pasta, e !x na exclusão é exclusão literal", async () => {
  const prs: Pr[] = [{ number: 1, files: ["docs/a.md"] }, { number: 2, files: ["src/a.ts"] }, { number: 3, files: ["x/a.ts"] }];
  assert.deepEqual((await varrer(prs, { paths: { exclude: ["docs"] } })).entraram, [2, 3]);
  assert.deepEqual((await varrer(prs, { paths: { exclude: ["docs/"] } })).entraram, [2, 3]);
  assert.deepEqual((await varrer(prs, { paths: { include: ["docs/"] } })).entraram, [1]);
  assert.deepEqual((await varrer(prs, { paths: { exclude: ["!src/**"] } })).entraram, [1, 3]);
});
