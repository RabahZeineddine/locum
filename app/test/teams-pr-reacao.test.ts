import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { alvoDoEvento, destinoDoEvento } from "../src/executor/executor.js";
import { McpRegistry } from "../src/mcp/registry.js";
import { mcpService } from "../src/services/mcp-service.js";
import { githubReviewHandler, type ReviewClient } from "../src/sources/github.js";
import { pollTeamsInbox } from "../src/sources/teams-inbox.js";
import { alvoDaReacao, reagirNoTeams } from "../src/teams/reaction.js";
import { bancoDeTeste as bancoVazio } from "./helpers/db.js";
import { schema } from "../src/db/index.js";

/** Banco de quem já varreu ontem, para a primeira batida não descartar o link. */
function bancoDeTeste() {
  const db = bancoVazio();
  db.insert(schema.cursors)
    .values({ source: "teams", key: "inbox", value: new Date(Date.now() - 24 * 3600_000).toISOString() })
    .run();
  return db;
}

const token = async () => "token-graph";
const GRAPH = "https://graph.test/v1.0";
const agoraMenos = (minutos: number) => new Date(Date.now() - minutos * 60_000).toISOString();
const PR = "https://github.com/acme/api/pull/7";

type Pedido = { url: string; metodo: string; auth: string | null; corpo: unknown };

/** Graph de mentira que anota as reações. `recusa` faz o endpoint de reação responder com erro. */
function graphDeReacoes(opcoes: { recusa?: number } = {}) {
  const pedidos: Pedido[] = [];
  const fetchFn = (async (entrada: string | URL, init?: RequestInit) => {
    const url = String(entrada);
    pedidos.push({
      url: decodeURIComponent(url.replace(GRAPH, "")),
      metodo: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("authorization"),
      corpo: init?.body === undefined ? null : JSON.parse(String(init.body)),
    });
    return opcoes.recusa === undefined
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ error: { code: "Forbidden" } }), { status: opcoes.recusa });
  }) as typeof fetch;
  return { pedidos, opcoes: { token, fetchFn, graphUrl: GRAPH } };
}

const CHAT = { teamsChatId: "19:chat@thread.v2", teamsMessageId: "1700" };
const CANAL = { teamsTeamId: "T1", teamsChannelId: "19:canal@thread.tacv2", teamsMessageId: "300" };
const REPLY = { ...CANAL, teamsMessageId: "301", teamsReplyToId: "300" };

test("o caminho da reação em chat, canal e resposta de thread", async () => {
  const g = graphDeReacoes();
  await reagirNoTeams(alvoDaReacao(CHAT)!, "set", "👀", g.opcoes);
  await reagirNoTeams(alvoDaReacao(CANAL)!, "set", "👀", g.opcoes);
  await reagirNoTeams(alvoDaReacao(REPLY)!, "unset", "👀", g.opcoes);

  assert.deepEqual(
    g.pedidos.map((p) => [p.metodo, p.url, p.corpo, p.auth]),
    [
      ["POST", "/chats/19:chat@thread.v2/messages/1700/setReaction", { reactionType: "👀" }, "Bearer token-graph"],
      ["POST", "/teams/T1/channels/19:canal@thread.tacv2/messages/300/setReaction", { reactionType: "👀" }, "Bearer token-graph"],
      ["POST", "/teams/T1/channels/19:canal@thread.tacv2/messages/300/replies/301/unsetReaction", { reactionType: "👀" }, "Bearer token-graph"],
    ],
  );
});

test("sem campos do Teams no evento não há onde reagir", () => {
  assert.equal(alvoDaReacao({ owner: "acme", repo: "api" }), null);
  assert.equal(alvoDaReacao({ teamsMessageId: "1" }), null);
  assert.equal(alvoDaReacao(null), null);
});

test("o Graph recusar a reação estoura para quem chama decidir", async () => {
  const g = graphDeReacoes({ recusa: 403 });
  await assert.rejects(reagirNoTeams(alvoDaReacao(CHAT)!, "set", "👀", g.opcoes), /403: Forbidden/);
});

const CONTEXTO = { repo: "acme/api", owner: "acme", repoName: "api", pull: 7, diff: "d", title: "t", author: "autor-do-pr", headSha: "sha1", state: "open", merged: false, draft: false };

function graphDaCaixa(chats: unknown[]) {
  const reacoes = graphDeReacoes();
  const fetchFn = (async (entrada: string | URL, init?: RequestInit) => {
    const url = new URL(String(entrada));
    const caminho = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ""));
    if (init?.method === "POST") return reacoes.opcoes.fetchFn(entrada, init);
    const json = (valor: unknown) => new Response(JSON.stringify(valor));
    if (caminho === "/me") return json({ id: "EU" });
    if (caminho === "/me/chats") {
      return json({ value: [{ id: "g", chatType: "group", lastMessagePreview: { createdDateTime: agoraMenos(1) } }] });
    }
    if (caminho === "/chats/g/messages") return json({ value: chats });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, pedidos: reacoes.pedidos };
}

const mensagemComPr = {
  id: "m1",
  chatId: "g",
  createdDateTime: agoraMenos(2),
  messageType: "message",
  from: { user: { id: "OUTRA", displayName: "Outra" } },
  body: { contentType: "html", content: PR },
};

test("ao pegar o PR o Locum reage com 👀 na mensagem", async () => {
  const { fetchFn, pedidos } = graphDaCaixa([mensagemComPr]);
  await pollTeamsInbox(
    { mentions: false, dms: false, prLinks: true },
    { db: bancoDeTeste(), token, fetchFn, graphUrl: GRAPH, viewerLogin: async () => null, fetchPr: (async () => CONTEXTO) as never },
  );
  assert.deepEqual(
    pedidos.map((p) => [p.url, p.corpo]),
    [["/chats/g/messages/m1/setReaction", { reactionType: "👀" }]],
  );
});

test("PR que não deu para buscar não ganha 👀, e erro na reação não derruba a varredura", async () => {
  const falhou = graphDaCaixa([mensagemComPr]);
  await pollTeamsInbox(
    { mentions: false, dms: false, prLinks: true },
    {
      db: bancoDeTeste(),
      token,
      fetchFn: falhou.fetchFn,
      graphUrl: GRAPH,
      fetchPr: (async () => {
        throw new Error("fora");
      }) as never,
    },
  );
  assert.deepEqual(falhou.pedidos, []);

  const recusa = graphDeReacoes({ recusa: 403 });
  const caixa = graphDaCaixa([mensagemComPr]);
  const fetchFn = (async (entrada: string | URL, init?: RequestInit) =>
    init?.method === "POST" ? recusa.opcoes.fetchFn(entrada, init) : caixa.fetchFn(entrada, init)) as typeof fetch;
  const db = bancoDeTeste();
  const resultado = await pollTeamsInbox(
    { mentions: false, dms: false, prLinks: true },
    { db, token, fetchFn, graphUrl: GRAPH, viewerLogin: async () => null, fetchPr: (async () => CONTEXTO) as never },
  );
  assert.equal(resultado.eventIds.length, 1);
  assert.deepEqual(resultado.errors, []);
  assert.equal(recusa.pedidos.length, 1);
});

const clienteDoGithub = {
  rest: { pulls: { createReview: async () => ({}), listReviews: async () => ({ data: [] }) } },
} as unknown as ReviewClient;
const REVIEW = { owner: "acme", repo: "api", pull: 7, findings: [] };

test("ao publicar, tira o 👀 e põe a reação do veredito, no chat, no canal e na resposta", async () => {
  const esperado = { APPROVE: "✅", REQUEST_CHANGES: "⚠️", COMMENT: "💬" } as const;
  for (const [verdict, emoji] of Object.entries(esperado)) {
    for (const [origem, caminho] of [
      [CHAT, "/chats/19:chat@thread.v2/messages/1700"],
      [CANAL, "/teams/T1/channels/19:canal@thread.tacv2/messages/300"],
      [REPLY, "/teams/T1/channels/19:canal@thread.tacv2/messages/300/replies/301"],
    ] as const) {
      const g = graphDeReacoes();
      await githubReviewHandler(() => clienteDoGithub, { teams: g.opcoes }).publish(
        { ...REVIEW, ...origem, verdict },
        `ext-${verdict}-${caminho}`,
      );
      assert.deepEqual(
        g.pedidos.map((p) => [p.url, p.corpo]),
        [
          [`${caminho}/unsetReaction`, { reactionType: "👀" }],
          [`${caminho}/setReaction`, { reactionType: emoji }],
        ],
        `${verdict} ${caminho}`,
      );
    }
  }
});

test("erro do Graph na reação nunca impede o review de sair", async () => {
  let criadas = 0;
  const cliente = {
    rest: {
      pulls: {
        createReview: async () => {
          criadas++;
          return {};
        },
        listReviews: async () => ({ data: [] }),
      },
    },
  } as unknown as ReviewClient;
  const g = graphDeReacoes({ recusa: 500 });
  await githubReviewHandler(() => cliente, { teams: g.opcoes }).publish({ ...REVIEW, ...CHAT, verdict: "APPROVE" }, "ext-x");
  assert.equal(criadas, 1);
  // Cada reação é tentada sozinha: a recusa de tirar o 👀 não impede de pôr o veredito.
  assert.equal(g.pedidos.length, 2);

  await githubReviewHandler(() => cliente, {
    teams: { token: async () => null, fetchFn: g.opcoes.fetchFn },
  }).publish({ ...REVIEW, ...CHAT }, "ext-y");
  assert.equal(criadas, 2);
});

const original = { enabledConfigs: mcpService.enabledConfigs, fromList: McpRegistry.fromList };
afterEach(() => {
  mcpService.enabledConfigs = original.enabledConfigs;
  McpRegistry.fromList = original.fromList;
});

test("review sem campos do Teams não chama o Graph, e o do Slack não chama o Teams", async () => {
  const g = graphDeReacoes();
  await githubReviewHandler(() => clienteDoGithub, { teams: g.opcoes }).publish({ ...REVIEW, verdict: "APPROVE" }, "ext-1");

  mcpService.enabledConfigs = (async () => []) as never;
  McpRegistry.fromList = (() => ({ callTool: async () => ({}), closeAll: async () => undefined })) as never;
  await githubReviewHandler(() => clienteDoGithub, { teams: g.opcoes }).publish(
    { ...REVIEW, slackChannel: "C1", slackTs: "1" },
    "ext-2",
  );
  assert.deepEqual(g.pedidos, []);
});

test("o destino da reação sai do evento e a saída do modelo não troca", () => {
  const evento = { owner: "acme", repo: "acme/api", repoName: "api", pull: 7, headSha: "abc", ...CANAL, teamsReplyToId: "300" };
  const alvo = alvoDoEvento(evento as never);
  for (const [campo, valor] of Object.entries(CANAL)) assert.equal(alvo[campo], valor, campo);
  assert.equal(alvo.teamsReplyToId, "300");

  const destino = destinoDoEvento(alvo);
  assert.equal(destino.teamsChannelId, CANAL.teamsChannelId);
  assert.equal(destino.teamsMessageId, CANAL.teamsMessageId);
});

/** Uma varredura de link de PR com o contexto dado, devolvendo o resultado e o que foi ao Graph. */
async function varrer(contextos: Record<string, unknown>[], opcoes: { eu?: string | null; mensagens?: unknown[] } = {}) {
  const { fetchFn, pedidos } = graphDaCaixa(opcoes.mensagens ?? [mensagemComPr]);
  let n = 0;
  const db = bancoDeTeste();
  const resultado = await pollTeamsInbox(
    { mentions: false, dms: false, prLinks: true },
    {
      db,
      token,
      fetchFn,
      graphUrl: GRAPH,
      viewerLogin: async () => opcoes.eu ?? null,
      fetchPr: (async () => ({ ...CONTEXTO, ...contextos[n++] })) as never,
    },
  );
  return { resultado, pedidos, db };
}

test("PR do próprio usuário não gera evento, não reage e não acorda o agent", async () => {
  const { resultado, pedidos, db } = await varrer([{}], { eu: "Autor-do-PR" });
  assert.deepEqual([resultado.eventIds, resultado.inWindow, pedidos], [[], [], []]);
  const [evento] = await db.select().from(schema.events);
  assert.equal((evento?.payload as { prDescartado?: string }).prDescartado, "proprio");
});

test("PR fechado, mergeado ou em rascunho não acorda nem recebe 👀", async () => {
  for (const [sobre, motivo] of [
    [{ state: "closed" }, "fechado"],
    [{ merged: true }, "mergeado"],
    [{ draft: true }, "rascunho"],
  ] as const) {
    const { resultado, pedidos, db } = await varrer([sobre]);
    assert.deepEqual([resultado.inWindow, pedidos], [[], []], motivo);
    const [evento] = await db.select().from(schema.events);
    assert.equal((evento?.payload as { prDescartado?: string }).prDescartado, motivo);
  }
});

test("o mesmo PR no mesmo commit só gera um evento, e commit novo gera outro", async () => {
  const outra = { ...mensagemComPr, id: "m2", createdDateTime: agoraMenos(1) };
  const repetido = await varrer([{}, {}], { mensagens: [mensagemComPr, outra] });
  assert.equal(repetido.resultado.inWindow.length, 1);
  assert.equal(repetido.pedidos.length, 1);

  const novo = await varrer([{}, { headSha: "sha2" }], { mensagens: [mensagemComPr, outra] });
  assert.equal(novo.resultado.inWindow.length, 2);
  assert.equal(novo.pedidos.length, 2);
});

test("evento recente do mesmo PR e commit, de outra fonte, também conta como já revisado", async () => {
  const db = bancoDeTeste();
  await db.insert(schema.events).values({
    id: "antigo",
    source: "github",
    externalId: "pr:7:sha:sha1",
    payload: { owner: "acme", repoName: "api", pull: 7, headSha: "sha1" },
  });
  const { fetchFn } = graphDaCaixa([mensagemComPr]);
  const resultado = await pollTeamsInbox(
    { mentions: false, dms: false, prLinks: true },
    { db, token, fetchFn, graphUrl: GRAPH, viewerLogin: async () => null, fetchPr: (async () => CONTEXTO) as never },
  );
  assert.deepEqual(resultado.inWindow, []);
});
