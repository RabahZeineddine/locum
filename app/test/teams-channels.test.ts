import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { schema } from "../src/db/index.js";
import { teamsAdminConsentUrl, teamsScope } from "../src/services/teams-app.js";
import { channelRepo, pollTeamsInbox } from "../src/sources/teams-inbox.js";
import { listTeamsChannels } from "../src/teams/channels.js";
import { destinoDe, teamsPostHandler } from "../src/teams/action.js";
import { TriggerConfig } from "../src/config/types.js";
import { bancoDeTeste } from "./helpers/db.js";

const token = async () => "token-graph";
const agoraMenos = (minutos: number) => new Date(Date.now() - minutos * 60_000).toISOString();

const EQUIPE = "11111111-2222-3333-4444-555555555555";
const CANAL = "19:geral@thread.tacv2";

function mensagem(id: string, minutos: number, sobre: Record<string, unknown> = {}) {
  return {
    id,
    createdDateTime: agoraMenos(minutos),
    messageType: "message",
    deletedDateTime: null,
    from: { user: { id: "OUTRA", displayName: "Outra Pessoa" } },
    body: { contentType: "html", content: `<p>mensagem ${id}</p>` },
    mentions: [],
    webUrl: `https://teams.microsoft.com/l/message/${id}`,
    ...sobre,
  };
}

const comMencao = { mentions: [{ mentioned: { user: { id: "EU" } } }] };

/** Graph de mentira: `/me`, chats vazios e um canal com threads e respostas. */
function graphFalso(threads: unknown[]) {
  const pedidos: URL[] = [];
  const fetchFn = (async (entrada: string | URL) => {
    const url = new URL(String(entrada));
    pedidos.push(url);
    const json = (valor: unknown, status = 200) => new Response(JSON.stringify(valor), { status });
    const caminho = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ""));
    if (caminho === "/me") return json({ id: "EU" });
    if (caminho === "/me/chats") return json({ value: [] });
    if (caminho === `/teams/${EQUIPE}/channels/${CANAL}/messages`) return json({ value: threads });
    return json({}, 404);
  }) as typeof fetch;
  return { fetchFn, pedidos };
}

test("menção em canal observado vira evento com equipe, canal e thread", async () => {
  const db = bancoDeTeste();
  const { fetchFn, pedidos } = graphFalso([
    {
      ...mensagem("200", 30),
      replies: [mensagem("201", 5, comMencao), mensagem("202", 4)],
    },
    mensagem("300", 3, comMencao),
    mensagem("100", 60 * 48, comMencao),
    mensagem("400", 2, { ...comMencao, from: { user: { id: "EU" } } }),
  ]);

  const resultado = await pollTeamsInbox(
    { mentions: true, dms: true, channels: [{ teamId: EQUIPE, channelId: CANAL, label: "Time / Geral" }] },
    { db, token, fetchFn },
  );

  assert.deepEqual(resultado.errors, []);
  assert.equal(resultado.eventIds.length, 2);
  const canal = pedidos.find((u) => u.pathname.includes("/channels/"))!;
  assert.equal(canal.searchParams.get("$expand"), "replies");

  const eventos = await db.select().from(schema.events).where(eq(schema.events.source, "teams"));
  const porMensagem = new Map(eventos.map((e) => [(e.payload as { messageId: string }).messageId, e.payload]));
  assert.deepEqual([...porMensagem.keys()].sort(), ["201", "300"]);
  const resposta = porMensagem.get("201") as Record<string, unknown>;
  assert.equal(resposta.repo, channelRepo(EQUIPE, CANAL, "200"));
  assert.equal(resposta.threadId, "200");
  assert.equal(resposta.channel, "Time / Geral");
  assert.equal(resposta.text, "mensagem 201");
  assert.equal((porMensagem.get("300") as Record<string, unknown>).threadId, "300");

  const segunda = await pollTeamsInbox(
    { mentions: true, dms: true, channels: [{ teamId: EQUIPE, channelId: CANAL }] },
    { db, token, fetchFn },
  );
  assert.equal(segunda.eventIds.length, 0);
});

test("sem menções ligadas, canal não é lido", async () => {
  const { fetchFn, pedidos } = graphFalso([mensagem("1", 1, comMencao)]);
  await pollTeamsInbox(
    { mentions: false, dms: true, channels: [{ teamId: EQUIPE, channelId: CANAL }] },
    { db: bancoDeTeste(), token, fetchFn },
  );
  assert.equal(pedidos.filter((u) => u.pathname.includes("/channels/")).length, 0);
});

test("canal que falha vira erro com o nome dele, e a caixa segue", async () => {
  const fetchFn = (async (entrada: string | URL) => {
    const caminho = new URL(String(entrada)).pathname;
    if (caminho.endsWith("/me")) return new Response(JSON.stringify({ id: "EU" }));
    if (caminho.endsWith("/me/chats")) return new Response(JSON.stringify({ value: [] }));
    return new Response(JSON.stringify({ error: { code: "Forbidden" } }), { status: 403 });
  }) as typeof fetch;
  const resultado = await pollTeamsInbox(
    { mentions: true, dms: true, channels: [{ teamId: EQUIPE, channelId: CANAL, label: "Geral" }] },
    { db: bancoDeTeste(), token, fetchFn },
  );
  assert.deepEqual(resultado.errors, [{ kind: "channel", channel: "Geral", error: "Graph respondeu 403: Forbidden" }]);
});

test("resposta em canal vai para a thread lida, e thread desconhecida é recusada", async () => {
  const db = bancoDeTeste();
  await db.insert(schema.events).values({
    id: "ev-canal",
    source: "teams",
    externalId: `teams:channel:${CANAL}:201`,
    payload: {
      repo: channelRepo(EQUIPE, CANAL, "200"),
      teamId: EQUIPE,
      channelId: CANAL,
      threadId: "200",
      channel: "Time / Geral",
      text: "alguém sabe do deploy?",
      author: "Outra Pessoa",
      webUrl: null,
    },
  });
  const pedidos: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    pedidos.push({ url, init });
    return new Response("{}", { status: 201 });
  }) as unknown as typeof fetch;
  const handler = teamsPostHandler({ db, token: async () => "t", fetchFn, graphUrl: "https://graph.test" });

  const proposta = await handler.propose!({ repo: channelRepo(EQUIPE, CANAL, "200"), text: "subiu às 10h" }, null);
  assert.deepEqual(proposta, {
    chatId: CANAL,
    text: "subiu às 10h",
    subject: "alguém sabe do deploy?",
    author: "Outra Pessoa",
    webUrl: null,
    channel: { teamId: EQUIPE, channelId: CANAL, threadId: "200", label: "Time / Geral" },
  });
  await assert.rejects(
    handler.propose!({ repo: channelRepo(EQUIPE, CANAL, "999"), text: "oi" }, null),
    /nao aparece no que o Locum leu do canal/,
  );

  await handler.publish(proposta, "id");
  assert.equal(
    pedidos[0]!.url,
    `https://graph.test/teams/${EQUIPE}/channels/19%3Ageral%40thread.tacv2/messages/200/replies`,
  );
  assert.deepEqual(JSON.parse(String(pedidos[0]!.init.body)), { body: { contentType: "text", content: "subiu às 10h" } });
});

test("repo de canal malformado cai para conversa e é recusado", () => {
  assert.throws(() => destinoDe({ repo: "teams-channel/so-equipe" }), /evento de conversa/);
  assert.deepEqual(destinoDe({ repo: "teams/19:dm" }), { tipo: "chat", chatId: "19:dm" });
});

test("escopos de canal só entram quando ligados", () => {
  assert.doesNotMatch(teamsScope(), /ChannelMessage/);
  assert.match(teamsScope(true), /ChannelMessage\.Read\.All/);
  assert.match(teamsScope(true), /ChannelMessage\.Send/);
  const consentimento = new URL(teamsAdminConsentUrl("empresa.com.br", "id", "s", true));
  assert.match(consentimento.searchParams.get("scope")!, /graph\.microsoft\.com\/ChannelMessage\.Read\.All/);
});

test("gatilho antigo do Teams continua válido, sem canais", () => {
  const config = TriggerConfig.parse({ kind: "teams-inbox", mentions: true, dms: true });
  assert.equal(config.kind === "teams-inbox" && config.channels.length, 0);
});

test("lista equipes e canais, e 403 diz para ligar os escopos", async () => {
  const fetchFn = (async (entrada: string | URL) => {
    const caminho = decodeURIComponent(new URL(String(entrada)).pathname);
    if (caminho.endsWith("/me/joinedTeams")) return new Response(JSON.stringify({ value: [{ id: EQUIPE, displayName: "Time" }] }));
    if (caminho.endsWith(`/teams/${EQUIPE}/channels`)) {
      return new Response(JSON.stringify({ value: [{ id: CANAL, displayName: "Geral" }] }));
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  assert.deepEqual(await listTeamsChannels({ token, fetchFn }), [
    { teamId: EQUIPE, teamName: "Time", channelId: CANAL, channelName: "Geral" },
  ]);

  const proibido = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(listTeamsChannels({ token, fetchFn: proibido }), /ligue canais e conecte de novo/);
});
