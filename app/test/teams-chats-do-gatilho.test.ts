import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { schema } from "../src/db/index.js";
import { TriggerConfig } from "../src/config/types.js";
import { pollTeamsInbox } from "../src/sources/teams-inbox.js";
import { bancoDeTeste as bancoVazio } from "./helpers/db.js";

const token = async () => "token-graph";
const PR = "https://github.com/acme/api/pull/7";
const agoraMenos = (minutos: number) => new Date(Date.now() - minutos * 60_000).toISOString();

function mensagem(id: string, html: string) {
  return {
    id,
    createdDateTime: agoraMenos(2),
    messageType: "message",
    deletedDateTime: null,
    from: { user: { id: "OUTRA", displayName: "Outra Pessoa" } },
    body: { contentType: "html", content: html },
    mentions: [],
    webUrl: `https://teams.microsoft.com/l/message/${id}`,
  };
}

/** Graph de mentira que anota cada chamada, inclusive as reações. */
function graphFalso(chats: { id: string; chatType: string; mensagens: unknown[] }[]) {
  const chamadas: string[] = [];
  const fetchFn = (async (entrada: string | URL, init?: RequestInit) => {
    const url = new URL(String(entrada));
    const caminho = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ""));
    chamadas.push(`${init?.method ?? "GET"} ${caminho}`);
    const json = (valor: unknown, status = 200) => new Response(JSON.stringify(valor), { status });
    if (caminho === "/me") return json({ id: "EU" });
    if (caminho === "/me/chats") {
      return json({ value: chats.map((c) => ({ id: c.id, chatType: c.chatType, lastMessagePreview: { createdDateTime: agoraMenos(-1) } })) });
    }
    const chat = chats.find((c) => caminho === `/chats/${c.id}/messages`);
    if (chat) return json({ value: chat.mensagens.map((m) => ({ ...(m as object), chatId: chat.id })) });
    if (/\/setReaction$/.test(caminho)) return new Response(null, { status: 204 });
    return json({}, 404);
  }) as typeof fetch;
  return { fetchFn, chamadas };
}

const semGithub = {
  fetchPr: (async (owner: string, repo: string, pull: number) => ({
    repo: `${owner}/${repo}`,
    owner,
    repoName: repo,
    pull,
    headSha: `sha-${pull}`,
    author: "autor-do-pr",
    draft: false,
    state: "open",
    diff: "d",
  })) as never,
  viewerLogin: async () => null,
};

function bancoDeTeste() {
  const db = bancoVazio();
  db.insert(schema.cursors).values({ source: "teams", key: "inbox", value: new Date(Date.now() - 23 * 3600_000).toISOString() }).run();
  return db;
}

const CHATS = [
  { id: "grupo-a", chatType: "group", mensagens: [mensagem("ma", PR)] },
  { id: "grupo-b", chatType: "group", mensagens: [mensagem("mb", PR)] },
];

async function rodar(chats?: { chatId: string; label?: string }[]) {
  const db = bancoDeTeste();
  const g = graphFalso(CHATS);
  const r = await pollTeamsInbox(
    { mentions: false, dms: false, prLinks: true, ...(chats === undefined ? {} : { chats }) },
    { db, token, ...semGithub, fetchFn: g.fetchFn },
  );
  const linhas = await db.select().from(schema.events).where(eq(schema.events.source, "teams"));
  return { r, chamadas: g.chamadas, ids: linhas.map((e) => (e.payload as { messageId: string }).messageId).sort() };
}

test("o gatilho salvo sem chats segue em todos os chats", () => {
  const antigo = TriggerConfig.parse({ kind: "teams-inbox", prLinks: true });
  assert.deepEqual(antigo.kind === "teams-inbox" && antigo.chats, []);
  assert.throws(() =>
    TriggerConfig.parse({ kind: "teams-inbox", chats: Array.from({ length: 21 }, (_, i) => ({ chatId: `c${i}` })) }),
  );
});

test("lista vazia mantém o atual: todos os chats", async () => {
  const { ids } = await rodar([]);
  assert.deepEqual(ids, ["ma", "mb"]);
});

test("chat fora da lista não gera evento, não é lido e não ganha reação", async () => {
  const { r, chamadas, ids } = await rodar([{ chatId: "grupo-a", label: "Revisões" }]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(ids, ["ma"]);
  assert.equal(chamadas.some((c) => c.includes("grupo-b")), false, chamadas.join("\n"));
  const reacoes = chamadas.filter((c) => c.startsWith("POST") && c.includes("setReaction"));
  assert.deepEqual(reacoes, ["POST /chats/grupo-a/messages/ma/setReaction"]);
});

test("dm e menção também só contam no chat da lista", async () => {
  const db = bancoDeTeste();
  const mencao = { ...mensagem("mm", "oi"), mentions: [{ mentioned: { user: { id: "EU" } } }] };
  const g = graphFalso([
    { id: "dentro", chatType: "oneOnOne", mensagens: [mensagem("m1", "oi")] },
    { id: "fora", chatType: "oneOnOne", mensagens: [mensagem("m2", "oi")] },
    { id: "fora2", chatType: "group", mensagens: [mencao] },
  ]);
  await pollTeamsInbox(
    { mentions: true, dms: true, chats: [{ chatId: "dentro" }] },
    { db, token, ...semGithub, fetchFn: g.fetchFn },
  );
  const linhas = await db.select().from(schema.events).where(eq(schema.events.source, "teams"));
  assert.deepEqual(linhas.map((e) => (e.payload as { messageId: string }).messageId), ["m1"]);
  assert.equal(g.chamadas.some((c) => c.includes("fora")), false);
});

test("a tela lista os chats com tópico ou nomes dos membros sem a própria pessoa", async () => {
  const { listTeamsChats } = await import("../src/teams/chats.js");
  const membro = (userId: string, displayName: string) => ({ userId, displayName });
  const chats = [
    { id: "d", chatType: "oneOnOne", topic: null, members: [membro("EU", "Eu Mesma"), membro("B", "Bia Souza")] },
    { id: "g", chatType: "group", topic: "Revisões", members: [membro("EU", "Eu Mesma"), membro("B", "Bia Souza")] },
    { id: "s", chatType: "group", topic: null, members: [membro("EU", "Eu Mesma"), membro("B", "Bia Souza"), membro("C", "Caio Lima")] },
    { id: "r", chatType: "meeting", topic: "Daily", members: [] },
  ];
  const fetchFn = (async (entrada: string | URL) => {
    const url = new URL(String(entrada));
    const caminho = url.pathname.replace(/^\/v1\.0/, "");
    if (caminho === "/me") return new Response(JSON.stringify({ id: "EU" }));
    assert.equal(caminho, "/me/chats");
    assert.equal(url.searchParams.get("$expand"), "members");
    return new Response(JSON.stringify({ value: chats }));
  }) as typeof fetch;
  const lista = await listTeamsChats({ token, fetchFn });
  assert.deepEqual(lista, [
    { chatId: "d", label: "Bia Souza", chatType: "oneOnOne" },
    { chatId: "s", label: "Bia Souza, Caio Lima", chatType: "group" },
    { chatId: "g", label: "Revisões", chatType: "group" },
  ].sort((a, b) => a.label.localeCompare(b.label)));
});
