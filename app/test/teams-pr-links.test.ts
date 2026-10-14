import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { schema } from "../src/db/index.js";
import { TriggerConfig } from "../src/config/types.js";
import { extractGithubPrLinks } from "../src/sources/github-pr-link.js";
import { pollTeamsInbox } from "../src/sources/teams-inbox.js";
import { bancoDeTeste } from "./helpers/db.js";

const token = async () => "token-graph";
const agoraMenos = (minutos: number) => new Date(Date.now() - minutos * 60_000).toISOString();

const EQUIPE = "11111111-2222-3333-4444-555555555555";
const CANAL = "19:geral@thread.tacv2";
const PR = "https://github.com/acme/api/pull/7";

test("extrai o link do PR com sufixo, query e âncora", () => {
  const casos: [string, unknown][] = [
    [PR, [{ owner: "acme", repo: "api", pull: 7 }]],
    [`olha ${PR}/files`, [{ owner: "acme", repo: "api", pull: 7 }]],
    [`${PR}/files?w=1#diff-abc`, [{ owner: "acme", repo: "api", pull: 7 }]],
    [`(${PR}).`, [{ owner: "acme", repo: "api", pull: 7 }]],
    [`<a href="${PR}">revisar isto</a>`, [{ owner: "acme", repo: "api", pull: 7 }]],
    ["http://github.com/a.b/c_d-e/pull/10", [{ owner: "a.b", repo: "c_d-e", pull: 10 }]],
  ];
  for (const [texto, esperado] of casos) assert.deepEqual(extractGithubPrLinks(texto), esperado, texto);
});

test("não é link de PR: issue, compare, commit, outro host, número colado", () => {
  for (const texto of [
    "https://github.com/acme/api/issues/7",
    "https://github.com/acme/api/compare/main...x",
    "https://github.com/acme/api/commit/abc123",
    "https://github.com/acme/api/pulls",
    "https://github.com/acme/api/pull/",
    "https://github.com/acme/api/pull/7abc",
    "https://gitlab.com/acme/api/pull/7",
    "https://github.com.evil.io/acme/api/pull/7",
    "https://notgithub.com/acme/api/pull/7",
    "github.com/acme/api/pull/7",
    "sem link nenhum",
  ]) {
    assert.deepEqual(extractGithubPrLinks(texto), [], texto);
  }
});

test("vários links: um por PR, sem repetir, na ordem em que aparecem, até cinco", () => {
  const links = [1, 2, 2, 3, 4, 5, 6, 7].map((n) => `https://github.com/acme/api/pull/${n}`).join(" ");
  assert.deepEqual(
    extractGithubPrLinks(links).map((l) => l.pull),
    [1, 2, 3, 4, 5],
  );
  assert.equal(extractGithubPrLinks(`${PR} ${PR}/files`).length, 1);
  assert.equal(extractGithubPrLinks("https://github.com/Acme/API/pull/7 " + PR).length, 1);
});

test("o gatilho antigo continua valendo e prLinks nasce desligado", () => {
  const antigo = TriggerConfig.parse({ kind: "teams-inbox", mentions: true, dms: false, channels: [] });
  assert.equal(antigo.kind === "teams-inbox" && antigo.prLinks, false);
  const novo = TriggerConfig.parse({ kind: "teams-inbox", prLinks: true });
  assert.equal(novo.kind === "teams-inbox" && novo.prLinks, true);
});

function mensagem(id: string, minutos: number, html: string, sobre: Record<string, unknown> = {}) {
  return {
    id,
    createdDateTime: agoraMenos(minutos),
    messageType: "message",
    deletedDateTime: null,
    from: { user: { id: "OUTRA", displayName: "Outra Pessoa" } },
    body: { contentType: "html", content: html },
    mentions: [],
    webUrl: `https://teams.microsoft.com/l/message/${id}`,
    ...sobre,
  };
}

/** Graph de mentira: `/me`, as conversas dadas e um canal com threads. */
function graphFalso(opcoes: { chats?: { id: string; chatType: string; mensagens: unknown[] }[]; threads?: unknown[] }) {
  const chats = opcoes.chats ?? [];
  const fetchFn = (async (entrada: string | URL) => {
    const url = new URL(String(entrada));
    const json = (valor: unknown, status = 200) => new Response(JSON.stringify(valor), { status });
    const caminho = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ""));
    if (caminho === "/me") return json({ id: "EU" });
    if (caminho === "/me/chats") {
      return json({ value: chats.map((c) => ({ id: c.id, chatType: c.chatType, lastMessagePreview: { createdDateTime: agoraMenos(1) } })) });
    }
    const chat = chats.find((c) => caminho === `/chats/${c.id}/messages`);
    if (chat) return json({ value: chat.mensagens.map((m) => ({ ...(m as object), chatId: chat.id })) });
    if (caminho === `/teams/${EQUIPE}/channels/${CANAL}/messages`) return json({ value: opcoes.threads ?? [] });
    return json({}, 404);
  }) as typeof fetch;
  return { fetchFn };
}

const CANAIS = [{ teamId: EQUIPE, channelId: CANAL, label: "Time / Geral" }];

async function eventos(db: ReturnType<typeof bancoDeTeste>) {
  const linhas = await db.select().from(schema.events).where(eq(schema.events.source, "teams"));
  return linhas.map((e) => e.payload as Record<string, unknown>);
}

test("canal sem menção com link de PR só acorda com prLinks", async () => {
  const threads = [mensagem("300", 3, `<p>revisa? <a href="${PR}">PR</a></p>`)];

  const sem = bancoDeTeste();
  await pollTeamsInbox({ mentions: true, dms: true, channels: CANAIS }, { db: sem, token, ...graphFalso({ threads }) });
  assert.equal((await eventos(sem)).length, 0);

  const com = bancoDeTeste();
  const resultado = await pollTeamsInbox(
    { mentions: false, dms: false, prLinks: true, channels: CANAIS },
    { db: com, token, ...graphFalso({ threads }) },
  );
  assert.deepEqual(resultado.errors, []);
  const [evento, ...resto] = await eventos(com);
  assert.equal(resto.length, 0);
  assert.equal(evento?.kind, "pr");
  assert.equal(evento?.repo, "acme/api");
  assert.deepEqual([evento?.prOwner, evento?.prRepo, evento?.prNumber], ["acme", "api", 7]);
});

test("mensagem de canal sem link de PR continua sem acordar, mesmo com prLinks", async () => {
  const db = bancoDeTeste();
  await pollTeamsInbox(
    { mentions: false, dms: false, prLinks: true, channels: CANAIS },
    { db, token, ...graphFalso({ threads: [mensagem("1", 2, "<p>bom dia https://github.com/acme/api/issues/3</p>")] }) },
  );
  assert.equal((await eventos(db)).length, 0);
});

test("chat em grupo e direto acordam com link; reunião só com menção", async () => {
  const db = bancoDeTeste();
  const chats = [
    { id: "g", chatType: "group", mensagens: [mensagem("m1", 2, PR)] },
    { id: "d", chatType: "oneOnOne", mensagens: [mensagem("m2", 2, `${PR}/files`)] },
    { id: "r", chatType: "meeting", mensagens: [mensagem("m3", 2, PR)] },
    { id: "r2", chatType: "meeting", mensagens: [mensagem("m4", 2, PR, { mentions: [{ mentioned: { user: { id: "EU" } } }] })] },
  ];
  await pollTeamsInbox({ mentions: false, dms: false, prLinks: true }, { db, token, ...graphFalso({ chats }) });
  const ids = (await eventos(db)).map((e) => e.messageId).sort();
  assert.deepEqual(ids, ["m1", "m2"]);

  const so = bancoDeTeste();
  await pollTeamsInbox({ mentions: true, dms: false, prLinks: true }, { db: so, token, ...graphFalso({ chats }) });
  assert.deepEqual((await eventos(so)).map((e) => e.messageId).sort(), ["m1", "m2", "m4"]);
});

test("mensagem do próprio usuário com link conta; sem link, não", async () => {
  const db = bancoDeTeste();
  const eu = { from: { user: { id: "EU" } } };
  const chats = [
    { id: "g", chatType: "group", mensagens: [mensagem("m1", 2, PR, eu), mensagem("m2", 2, "só conversa", eu)] },
  ];
  await pollTeamsInbox({ mentions: true, dms: true, prLinks: true }, { db, token, ...graphFalso({ chats }) });
  assert.deepEqual((await eventos(db)).map((e) => e.messageId), ["m1"]);

  const sem = bancoDeTeste();
  await pollTeamsInbox({ mentions: true, dms: true }, { db: sem, token, ...graphFalso({ chats }) });
  assert.equal((await eventos(sem)).length, 0);
});

test("dois links na mesma mensagem viram um evento por PR, sem duplicar na batida seguinte", async () => {
  const db = bancoDeTeste();
  const chats = [
    { id: "g", chatType: "group", mensagens: [mensagem("m1", 2, `${PR} e https://github.com/acme/web/pull/9`)] },
  ];
  const watch = { mentions: false, dms: false, prLinks: true };
  const primeira = await pollTeamsInbox(watch, { db, token, ...graphFalso({ chats }) });
  assert.equal(primeira.eventIds.length, 2);
  const prs = (await eventos(db)).map((e) => e.repo).sort();
  assert.deepEqual(prs, ["acme/api", "acme/web"]);

  const segunda = await pollTeamsInbox(watch, { db, token, ...graphFalso({ chats }) });
  assert.equal(segunda.eventIds.length, 0);
});
