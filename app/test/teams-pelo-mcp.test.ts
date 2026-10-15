import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { schema } from "../src/db/index.js";
import { pollTeamsInbox } from "../src/sources/teams-inbox.js";
import { teamsPostHandler } from "../src/teams/action.js";
import { reagirNoTeams, REACAO_PEGOU } from "../src/teams/reaction.js";
import { listTeamsChannels } from "../src/teams/channels.js";
import { alvoDaReacao } from "../src/teams/reaction.js";
import { capacidadesDoTeams, compartilhar, soltarSessoes, teamsNoMcp } from "../src/teams/graph.js";
import type { McpCaller } from "../src/sources/mcp-poll.js";
import { bancoDeTeste as bancoVazio } from "./helpers/db.js";

const agoraMenos = (minutos: number) => new Date(Date.now() - minutos * 60_000).toISOString();
const PR = "https://github.com/acme/api/pull/7";
const EQUIPE = "equipe-1";
const CANAL = "19:geral@thread.tacv2";

/**
 * O esquema das ferramentas como o ms365 as publica (0.155.0 e 0.166.1): ids em
 * camelCase, `$top` e `$skip` inteiros, `$select`, `$orderby` e `$expand` texto
 * ou lista, `$filter` e `skiptoken` texto. Texto onde devia ser inteiro volta
 * do servidor como `invalid_query_parameter`.
 */
const TEXTO = { type: "string" };
const INTEIRO = { type: "integer", minimum: 0 };
const TEXTO_OU_LISTA = { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] };
const TIPOS: Record<string, unknown> = {
  $top: INTEIRO,
  $skip: INTEIRO,
  $select: TEXTO_OU_LISTA,
  $orderby: TEXTO_OU_LISTA,
  $expand: TEXTO_OU_LISTA,
  body: { type: "object" },
  confirm: { type: "boolean" },
};
const esquema = (...campos: string[]) => ({
  type: "object",
  properties: Object.fromEntries(campos.map((c) => [c, TIPOS[c] ?? TEXTO])),
});
const consulta = ["$top", "$skip", "$filter", "$orderby", "$select", "$expand", "skiptoken"];
const FERRAMENTAS = [
  { name: "get-current-user", inputSchema: esquema("$select") },
  {
    name: "list-chats",
    inputSchema: { ...esquema(...consulta), properties: { ...esquema(...consulta).properties, $top: { allOf: [INTEIRO, { maximum: 50 }] } } },
  },
  { name: "list-chat-messages", inputSchema: esquema("chatId", ...consulta) },
  { name: "list-channel-messages", inputSchema: esquema("teamId", "channelId", ...consulta) },
  { name: "list-channel-message-replies", inputSchema: esquema("teamId", "channelId", "chatMessageId", ...consulta) },
  { name: "send-chat-message", inputSchema: esquema("chatId", "body", "confirm") },
  { name: "reply-to-channel-message", inputSchema: esquema("teamId", "channelId", "chatMessageId", "body", "confirm") },
  { name: "set-chat-message-reaction", inputSchema: esquema("chatId", "chatMessageId", "body", "confirm") },
  { name: "set-channel-message-reaction", inputSchema: esquema("teamId", "channelId", "chatMessageId", "body", "confirm") },
  { name: "unset-chat-message-reaction", inputSchema: esquema("chatId", "chatMessageId", "body", "confirm") },
  { name: "unset-channel-message-reaction", inputSchema: esquema("teamId", "channelId", "chatMessageId", "body", "confirm") },
].map((t) => ({ ...t, description: "", estimatedTokens: 0 }));

/** O servidor MCP cadastrado, do jeito que `McpService` o devolve. */
function cadastro(nome: string, enabled = true, ferramentas: unknown[] = FERRAMENTAS) {
  return {
    list: async () => [{ config: { name: nome }, enabled }] as never,
    cachedTools: async () => ({ at: 0, tools: ferramentas }) as never,
  };
}

type Chamada = { tool: string; args: Record<string, unknown> };

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

/** Servidor MCP de mentira: devolve o que o ms365 devolveria, no envelope do protocolo. */
function servidorFalso(dados: {
  chats?: { id: string; chatType: string; mensagens: unknown[] }[];
  threads?: unknown[];
  respostas?: Record<string, unknown[]>;
  falha?: string;
}) {
  const chamadas: Chamada[] = [];
  const texto = (valor: unknown) => ({ content: [{ type: "text", text: JSON.stringify(valor) }] });
  const chats = dados.chats ?? [];
  const call = async (_server: string, tool: string, args: Record<string, unknown>) => {
    chamadas.push({ tool, args });
    // O servidor real recusa o que não bate com o esquema.
    for (const [nome, valor] of Object.entries(args)) {
      if (nome === "$top" || nome === "$skip") {
        if (typeof valor !== "number") {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "invalid_query_parameter", parameter: nome }) }] };
        }
      }
    }
    if (dados.falha !== undefined) return { isError: true, content: [{ type: "text", text: dados.falha }] };
    switch (tool) {
      case "get-current-user":
        return texto({ id: "EU", userPrincipalName: "eu@empresa.com" });
      case "list-chats": {
        const pagina = args.skiptoken === "p2" ? chats.slice(1) : chats.slice(0, 1);
        const proxima =
          args.skiptoken === undefined && chats.length > 1
            ? { "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/chats?%24top=50&%24skiptoken=p2" }
            : {};
        const previa = { lastMessagePreview: { createdDateTime: agoraMenos(-1) } };
        return texto({ value: pagina.map((c) => ({ id: c.id, chatType: c.chatType, ...previa })), ...proxima });
      }
      case "list-chat-messages": {
        const chat = chats.find((c) => c.id === args.chatId);
        return texto({ value: (chat?.mensagens ?? []).map((m) => ({ ...(m as object), chatId: chat?.id })) });
      }
      case "list-channel-messages":
        return texto({ value: dados.threads ?? [] });
      case "list-channel-message-replies":
        return texto({ value: dados.respostas?.[String(args.chatMessageId)] ?? [] });
      default:
        return texto({});
    }
  };
  return { call, chamadas };
}

/** PR já enriquecido, para o teste não esbarrar no GitHub. */
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

const semLogin = async () => null;

/** Quem ficou na mão de ontem: o cursor existe, e a primeira batida não é de hoje. */
function bancoDeTeste() {
  const db = bancoVazio();
  const ontem = new Date(Date.now() - 23 * 3600_000).toISOString();
  for (const key of ["inbox", `channel:${EQUIPE}:${CANAL}`]) {
    db.insert(schema.cursors).values({ source: "teams", key, value: ontem }).run();
  }
  return db;
}

async function eventos(db: ReturnType<typeof bancoDeTeste>) {
  const linhas = await db.select().from(schema.events).where(eq(schema.events.source, "teams"));
  return linhas.map((e) => e.payload as Record<string, unknown>);
}

test("sem login nativo, a caixa lê pelo servidor MCP: quem sou, conversas e mensagens", async () => {
  const db = bancoDeTeste();
  const { call, chamadas } = servidorFalso({
    chats: [{ id: "dm", chatType: "oneOnOne", mensagens: [mensagem("m1", 2, "<p>oi</p>")] }],
  });

  const resultado = await pollTeamsInbox(
    { mentions: false, dms: true },
    { db, token: semLogin, mcp: cadastro("qualquer-nome"), call, ...semGithub },
  );

  assert.deepEqual(resultado.errors, []);
  assert.deepEqual((await eventos(db)).map((e) => [e.messageId, e.kind, e.text]), [["m1", "dm", "oi"]]);
  const euMesmo = chamadas[0]!;
  assert.deepEqual([euMesmo.tool, euMesmo.args], ["get-current-user", { $select: "id,userPrincipalName" }]);
  const leitura = chamadas.find((c) => c.tool === "list-chat-messages")!;
  assert.equal(leitura.args.chatId, "dm");
  assert.match(String(leitura.args.$filter), /^lastModifiedDateTime gt /);
  assert.equal(leitura.args.$top, 50);
});

test("a lista de conversas pagina pelo nextLink, que vira o skiptoken da ferramenta", async () => {
  const db = bancoDeTeste();
  const { call, chamadas } = servidorFalso({
    chats: [
      { id: "a", chatType: "oneOnOne", mensagens: [mensagem("ma", 2, "primeira")] },
      { id: "b", chatType: "group", mensagens: [mensagem("mb", 2, "segunda")] },
    ],
  });

  await pollTeamsInbox({ mentions: false, dms: true }, { db, token: semLogin, mcp: cadastro("x"), call, ...semGithub });

  assert.deepEqual((await eventos(db)).map((e) => e.messageId).sort(), ["ma", "mb"]);
  const listas = chamadas.filter((c) => c.tool === "list-chats");
  assert.equal(listas.length, 2);
  assert.equal(listas[1]!.args.skiptoken, "p2");
});

test("a mensagem da própria pessoa não acorda, a menos que traga link de PR", async () => {
  const db = bancoDeTeste();
  const eu = { from: { user: { id: "EU" } } };
  const { call } = servidorFalso({
    chats: [{ id: "g", chatType: "group", mensagens: [mensagem("m1", 2, PR, eu), mensagem("m2", 2, "só conversa", eu)] }],
  });

  await pollTeamsInbox(
    { mentions: true, dms: true, prLinks: true },
    { db, token: semLogin, mcp: cadastro("x"), call, ...semGithub },
  );

  assert.deepEqual((await eventos(db)).map((e) => e.messageId), ["m1"]);
});

test("chat em grupo com link de PR vira evento do PR e o 👀 sai pela ferramenta de reação", async () => {
  const db = bancoDeTeste();
  const { call, chamadas } = servidorFalso({
    chats: [{ id: "g", chatType: "group", mensagens: [mensagem("m1", 2, `<p>revisa ${PR}</p>`)] }],
  });

  const resultado = await pollTeamsInbox(
    { mentions: false, dms: false, prLinks: true },
    { db, token: semLogin, mcp: cadastro("x"), call, ...semGithub },
  );

  assert.deepEqual(resultado.errors, []);
  const [evento] = await eventos(db);
  assert.deepEqual([evento?.kind, evento?.prOwner, evento?.prRepo, evento?.prNumber], ["pr", "acme", "api", 7]);
  const reacao = chamadas.find((c) => c.tool === "set-chat-message-reaction")!;
  assert.deepEqual(reacao.args, { chatId: "g", chatMessageId: "m1", body: { reactionType: REACAO_PEGOU }, confirm: true });
});

test("canal de equipe: threads e respostas chegam pelas ferramentas de canal", async () => {
  const db = bancoDeTeste();
  const raiz = mensagem("t1", 5, "<p>bom dia</p>");
  const resposta = mensagem("r1", 2, `<p>olha ${PR}</p>`);
  const { call, chamadas } = servidorFalso({ threads: [raiz], respostas: { t1: [resposta] } });

  const resultado = await pollTeamsInbox(
    { mentions: false, dms: false, prLinks: true, channels: [{ teamId: EQUIPE, channelId: CANAL, label: "Geral" }] },
    { db, token: semLogin, mcp: cadastro("x"), call, ...semGithub },
  );

  assert.deepEqual(resultado.errors.filter((e) => e.kind === "channel"), []);
  const canal = (await eventos(db)).find((e) => e.kind === "pr" && e.channelId === CANAL);
  assert.equal(canal?.teamsReplyToId, "t1");
  const respostas = chamadas.find((c) => c.tool === "list-channel-message-replies")!;
  assert.deepEqual([respostas.args.teamId, respostas.args.channelId, respostas.args.chatMessageId], [EQUIPE, CANAL, "t1"]);
});

test("o login nativo tem precedência: o servidor MCP nem é chamado", async () => {
  const db = bancoDeTeste();
  const { call, chamadas } = servidorFalso({});
  const fetchFn = (async (entrada: string | URL) =>
    new Response(JSON.stringify(String(entrada).includes("/me?") ? { id: "EU" } : { value: [] }))) as typeof fetch;

  await pollTeamsInbox(
    { mentions: false, dms: true },
    { db, token: async () => "t", fetchFn, mcp: cadastro("x"), call, ...semGithub },
  );

  assert.equal(chamadas.length, 0);
});

test("o servidor é achado pelas ferramentas, não pelo nome, e o desligado não vale", async () => {
  assert.equal((await teamsNoMcp(cadastro("nome-qualquer")))?.server, "nome-qualquer");
  assert.equal((await teamsNoMcp(cadastro("ms365", true, [{ name: "list-chats" }])))?.leitura ?? null, null);
  const desligado = await teamsNoMcp(cadastro("ms365", false));
  assert.deepEqual([desligado?.server, desligado?.ligado, desligado?.responder, desligado?.reagir], ["ms365", false, true, true]);
  assert.deepEqual(capacidadesDoTeams(["get-current-user", "list-chats", "list-chat-messages"]), {
    leitura: true,
    canal: false,
    responder: false,
    reagir: false,
  });
});

test("servidor desligado ou ausente: erro que diz o que fazer e onde, sem jargão", async () => {
  const opcoes = { db: bancoDeTeste(), token: semLogin, ...semGithub };
  await assert.rejects(
    pollTeamsInbox({ mentions: false, dms: true }, { ...opcoes, mcp: cadastro("ms365", false) }),
    /"ms365", que está desligado\. Ligue em Conexões\./,
  );
  await assert.rejects(
    pollTeamsInbox({ mentions: false, dms: true }, { ...opcoes, mcp: { list: async () => [], cachedTools: async () => null } }),
    /Em Conexões, entre com o Teams ou ligue um servidor/,
  );
});

test("servidor fora do ar, sem login ou recusando: cada um com a mensagem certa, sem o corpo cru inteiro", async () => {
  const rodar = async (call: McpCaller) => {
    const r = await pollTeamsInbox(
      { mentions: false, dms: true },
      { db: bancoDeTeste(), token: semLogin, mcp: cadastro("ms365"), call, ...semGithub },
    );
    return r.errors[0]!.error;
  };
  const fora = await rodar(async () => {
    throw new Error("spawn npx ENOENT " + "x".repeat(500));
  });
  assert.match(fora, /servidor "ms365", que não respondeu/);
  assert.match(fora, /Em Conexões, confira se ele está ligado e com login\./);
  assert.ok(fora.length < 400);

  const semLoginNoServidor = await rodar(servidorFalso({ falha: "No accounts found. Please login first." }).call);
  assert.equal(semLoginNoServidor, 'O servidor "ms365" está sem login no Microsoft 365. Refaça o login dele em Conexões.');

  const recusa = await rodar(servidorFalso({ falha: '{"error":"Graph API error: 403 Forbidden"}' }).call);
  assert.match(recusa, /^O servidor "ms365" recusou o pedido do Teams: .*403/);
});

test("resposta que não é JSON (modo toon) vira erro claro, e não uma caixa vazia", async () => {
  const call = async (_s: string, tool: string) => ({
    content: [{ type: "text", text: tool === "get-current-user" ? "id: EU" : "value[0]:" }],
  });
  const r = await pollTeamsInbox(
    { mentions: false, dms: true },
    { db: bancoDeTeste(), token: semLogin, mcp: cadastro("ms365"), call, ...semGithub },
  );
  assert.match(r.errors[0]!.error, /formato que o Locum não lê\. Desligue o modo toon/);
});

test("responder numa conversa: send-chat-message com o texto em HTML e a confirmação do ms365", async () => {
  const { call, chamadas } = servidorFalso({});
  const handler = teamsPostHandler({ db: bancoDeTeste(), token: semLogin, mcp: cadastro("ms365"), call });

  await handler.publish(
    { chatId: "19:dm", text: "vê <isso> & aquilo\nvaleu", subject: "x", author: null, webUrl: null },
    "id",
  );

  assert.deepEqual(chamadas, [
    {
      tool: "send-chat-message",
      args: {
        chatId: "19:dm",
        body: { body: { contentType: "html", content: "vê &lt;isso&gt; &amp; aquilo<br>valeu" } },
        confirm: true,
      },
    },
  ]);
});

test("responder numa thread de canal: reply-to-channel-message", async () => {
  const { call, chamadas } = servidorFalso({});
  const handler = teamsPostHandler({ db: bancoDeTeste(), token: semLogin, mcp: cadastro("ms365"), call });

  await handler.publish(
    {
      chatId: CANAL,
      text: "feito",
      subject: "x",
      author: null,
      webUrl: null,
      channel: { teamId: EQUIPE, channelId: CANAL, threadId: "t1", label: null },
    },
    "id",
  );

  const [chamada] = chamadas;
  assert.equal(chamada?.tool, "reply-to-channel-message");
  assert.deepEqual(
    [chamada?.args.teamId, chamada?.args.channelId, chamada?.args.chatMessageId],
    [EQUIPE, CANAL, "t1"],
  );
});

test("a falha da ferramenta estoura no publish, para a pendência não fechar", async () => {
  const { call } = servidorFalso({ falha: "boom" });
  const handler = teamsPostHandler({ db: bancoDeTeste(), token: semLogin, mcp: cadastro("ms365"), call });
  await assert.rejects(
    handler.publish({ chatId: "c", text: "oi", subject: "x", author: null, webUrl: null }, "id"),
    /recusou o pedido do Teams: boom/,
  );
});

test("reagir: chat e canal usam a ferramenta de cada um; a ferramenta que o servidor não tem estoura", async () => {
  const { call, chamadas } = servidorFalso({});
  const opcoes = { token: semLogin, mcp: cadastro("ms365"), call };

  await reagirNoTeams({ tipo: "chat", chatId: "c", messageId: "m" }, "unset", "👀", opcoes);
  await reagirNoTeams({ tipo: "canal", teamId: EQUIPE, channelId: CANAL, messageId: "m" }, "set", "✅", opcoes);

  assert.deepEqual(chamadas.map((c) => c.tool), ["unset-chat-message-reaction", "set-channel-message-reaction"]);
  assert.equal((chamadas[1]!.args.body as { reactionType: string }).reactionType, "✅");

  await assert.rejects(
    reagirNoTeams({ tipo: "chat", chatId: "c", messageId: "m" }, "set", "👀", {
      ...opcoes,
      mcp: cadastro("ms365", true, FERRAMENTAS.filter((t) => !t.name.includes("reaction"))),
    }),
    /não oferece o que o Teams pede aqui \(set-chat-message-reaction\)/,
  );
});

/** As ferramentas de um ms365 com mais de uma conta: todas ganham o campo `account`. */
const MULTICONTA = FERRAMENTAS.map((t) => ({
  ...t,
  inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, account: { type: "string" } } },
}));

test("ms365 com mais de uma conta: a conta da leitura vai em toda chamada, no evento e na resposta aprovada", async () => {
  const db = bancoDeTeste();
  const { call, chamadas } = servidorFalso({
    chats: [{ id: "g", chatType: "group", mensagens: [mensagem("m1", 2, `<p>${PR}</p>`)] }],
  });
  const mcp = cadastro("ms365", true, MULTICONTA);

  await pollTeamsInbox({ mentions: false, dms: false, prLinks: true }, { db, token: semLogin, mcp, call, ...semGithub });

  assert.equal(chamadas[0]!.args.account, undefined, "a primeira chamada ainda não sabe a conta");
  for (const c of chamadas.slice(1)) assert.equal(c.args.account, "eu@empresa.com", c.tool);
  const [evento] = await eventos(db);
  assert.equal(evento?.teamsAccount, "eu@empresa.com");

  // O 👀 e a resposta saem pela conta gravada, não pela padrão do servidor naquele dia.
  const alvo = alvoDaReacao(evento);
  assert.equal(alvo?.account, "eu@empresa.com");
  const depois = servidorFalso({});
  await reagirNoTeams(alvo!, "set", "✅", { token: semLogin, mcp, call: depois.call });
  await teamsPostHandler({ db, token: semLogin, mcp, call: depois.call }).publish(
    { chatId: "g", text: "ok", subject: "x", author: null, webUrl: null, account: "eu@empresa.com" },
    "id",
  );
  assert.deepEqual(depois.chamadas.map((c) => c.args.account), ["eu@empresa.com", "eu@empresa.com"]);
});

test("a lista de chats da tela sai pela conta gravada do gatilho", async () => {
  const db = bancoDeTeste();
  await db.insert(schema.settings).values({ key: "teams.account.inbox:g1", value: "eu@empresa.com" });
  const { call, chamadas } = servidorFalso({ chats: [{ id: "g", chatType: "group", mensagens: [] }] });
  const mcp = cadastro("ms365", true, MULTICONTA);
  const { listTeamsChats } = await import("../src/teams/chats.js");

  await listTeamsChats({ token: semLogin, mcp, call, db, triggerId: "g1" });

  assert.ok(chamadas.length > 0);
  for (const c of chamadas) assert.equal(c.args.account, "eu@empresa.com", c.tool);
});

test("servidor de uma conta só não recebe account, e o evento não leva conta", async () => {
  const db = bancoDeTeste();
  const { call, chamadas } = servidorFalso({
    chats: [{ id: "d", chatType: "oneOnOne", mensagens: [mensagem("m1", 2, "oi")] }],
  });
  await pollTeamsInbox({ mentions: false, dms: true }, { db, token: semLogin, mcp: cadastro("ms365"), call, ...semGithub });
  assert.ok(chamadas.every((c) => !("account" in c.args)));
  assert.equal((await eventos(db))[0]?.teamsAccount, undefined);
});

test("reação em resposta de thread de canal fica na raiz da thread, nas duas pontas", async () => {
  const { call, chamadas } = servidorFalso({});
  const alvo = { tipo: "canal", teamId: EQUIPE, channelId: CANAL, messageId: "r1", replyToId: "t1" } as const;
  const opcoes = { token: semLogin, mcp: cadastro("ms365"), call };

  await reagirNoTeams(alvo, "unset", "👀", opcoes);
  await reagirNoTeams(alvo, "set", "✅", opcoes);

  assert.deepEqual(chamadas.map((c) => [c.tool, c.args.chatMessageId]), [
    ["unset-channel-message-reaction", "t1"],
    ["set-channel-message-reaction", "t1"],
  ]);
});

const CONFIG = { name: "ms365", transport: "stdio", command: ["npx"] } as never;

test("operações próximas reaproveitam a sessão do servidor, e ela fecha depois de solta", async () => {
  let abertas = 0;
  let fechadas = 0;
  const abrir = async () => {
    abertas++;
    return { call: async () => ({}), close: async () => void fechadas++ };
  };
  try {
    const a = await compartilhar("ms365", CONFIG, abrir);
    const b = await compartilhar("ms365", CONFIG, abrir);
    await a.close();
    await b.close();
    const c = await compartilhar("ms365", CONFIG, abrir);
    await c.close();
    assert.equal(abertas, 1);
    assert.equal(fechadas, 0, "ociosa, mas ainda de pé para a próxima operação");
  } finally {
    await soltarSessoes();
  }
  assert.equal(fechadas, 1);
});

test("servidor editado descarta a sessão viva: a que está em uso termina e fecha ao soltar, e a nova reabre", async () => {
  let abertas = 0;
  let fechadas = 0;
  const abrir = async () => {
    abertas++;
    return { call: async () => ({}), close: async () => void fechadas++ };
  };
  try {
    const velha = await compartilhar("ms365", CONFIG, abrir);
    const nova = await compartilhar("ms365", { ...(CONFIG as object), command: ["npx", "-y"] } as never, abrir);
    assert.equal(abertas, 2);
    assert.equal(fechadas, 0, "a velha ainda está em uso");
    await velha.close();
    assert.equal(fechadas, 1);
    await nova.close();
  } finally {
    await soltarSessoes();
  }
});

test("servidor desligado entre o cadastro e a chamada: erro de ligar em Conexões, sem sessão", async () => {
  await assert.rejects(
    pollTeamsInbox(
      { mentions: false, dms: true },
      { db: bancoDeTeste(), token: semLogin, mcp: cadastro("ms365"), configDoServidor: async () => null, ...semGithub },
    ),
    /"ms365", que está desligado\. Ligue em Conexões\./,
  );
});

test("a recusa que fala em skiptoken é recusa, e não falta de login", async () => {
  const { call } = servidorFalso({ falha: '{"error":"invalid_skiptoken","tool":"list-chats"}' });
  const r = await pollTeamsInbox(
    { mentions: false, dms: true },
    { db: bancoDeTeste(), token: semLogin, mcp: cadastro("ms365"), call, ...semGithub },
  );
  assert.match(r.errors[0]!.error, /recusou o pedido do Teams: .*invalid_skiptoken/);
});

test("a conta é a username que o list-accounts do servidor mostra, sem diferenciar maiúscula", async () => {
  const { call: base, chamadas } = servidorFalso({
    chats: [{ id: "d", chatType: "oneOnOne", mensagens: [mensagem("m1", 2, "oi")] }],
  });
  const call = async (server: string, tool: string, args: Record<string, unknown>) =>
    tool === "list-accounts"
      ? { content: [{ type: "text", text: JSON.stringify({ accounts: [{ email: "Eu@Empresa.com" }, { email: "outra@x.com" }] }) }] }
      : base(server, tool, args);
  const db = bancoDeTeste();
  const mcp = cadastro("ms365", true, [...MULTICONTA, { name: "list-accounts", inputSchema: esquema(), description: "", estimatedTokens: 0 }]);

  await pollTeamsInbox({ mentions: false, dms: true }, { db, token: semLogin, mcp, call, ...semGithub });

  assert.equal((await eventos(db))[0]?.teamsAccount, "Eu@Empresa.com");
  assert.ok(chamadas.slice(1).every((c) => c.args.account === "Eu@Empresa.com"));
});

test("várias contas e nenhuma padrão: o erro diz o que fazer; a conta da primeira batida vale nas seguintes", async () => {
  const { call: base } = servidorFalso({
    chats: [{ id: "d", chatType: "oneOnOne", mensagens: [mensagem("m1", 2, "oi")] }],
  });
  const mcp = cadastro("ms365", true, MULTICONTA);
  const db = bancoDeTeste();
  const semPadrao = async (server: string, tool: string, args: Record<string, unknown>) =>
    args.account === undefined
      ? { isError: true, content: [{ type: "text", text: "Multiple accounts configured but no default selected." }] }
      : base(server, tool, args);

  const falha = await pollTeamsInbox({ mentions: false, dms: true }, { db, token: semLogin, mcp, call: semPadrao, ...semGithub });
  assert.match(falha.errors[0]!.error, /tem várias contas e nenhuma escolhida\. Escolha a conta padrão dele/);

  // Com a conta gravada pela primeira batida boa, a padrão deixa de importar.
  const { call: boa } = servidorFalso({
    chats: [{ id: "d", chatType: "oneOnOne", mensagens: [mensagem("m1", 2, "oi")] }],
  });
  await pollTeamsInbox({ mentions: false, dms: true, }, { db, token: semLogin, mcp, call: boa, ...semGithub, triggerId: "t1" });
  const chamadas: Chamada[] = [];
  const registrando = async (server: string, tool: string, args: Record<string, unknown>) => {
    chamadas.push({ tool, args });
    return semPadrao(server, tool, args);
  };
  const depois = await pollTeamsInbox(
    { mentions: false, dms: true },
    { db, token: semLogin, mcp, call: registrando, ...semGithub, triggerId: "t1" },
  );
  assert.deepEqual(depois.errors, []);
  assert.equal(chamadas[0]!.args.account, "eu@empresa.com");
});

test("pendência sem conta num servidor com várias contas não publica", async () => {
  const { call, chamadas } = servidorFalso({});
  const handler = teamsPostHandler({ db: bancoDeTeste(), token: semLogin, mcp: cadastro("ms365", true, MULTICONTA), call });
  await assert.rejects(
    handler.publish({ chatId: "c", text: "oi", subject: "x", author: null, webUrl: null }, "id"),
    /tem várias contas e esta resposta não diz por qual sair\. Rejeite e gere a resposta de novo\./,
  );
  assert.equal(chamadas.length, 0);
});

test("listar equipes e canais para o gatilho passa pelo servidor MCP, e sem Teams nenhum o erro diz onde conectar", async () => {
  const chamadas: Chamada[] = [];
  const call = async (_s: string, tool: string, args: Record<string, unknown>) => {
    chamadas.push({ tool, args });
    const texto = (valor: unknown) => ({ content: [{ type: "text", text: JSON.stringify(valor) }] });
    if (tool === "list-joined-teams") return texto({ value: [{ id: EQUIPE, displayName: "Time" }] });
    return texto({ value: [{ id: CANAL, displayName: "Geral" }] });
  };
  // O ms365 não aceita query em `list-joined-teams`: o $select do Graph some em vez de virar recusa.
  const ferramentas = [
    ...FERRAMENTAS,
    { name: "list-joined-teams", inputSchema: esquema(), description: "", estimatedTokens: 0 },
    { name: "list-team-channels", inputSchema: esquema("teamId", "$select"), description: "", estimatedTokens: 0 },
  ];

  const lista = await listTeamsChannels({ token: semLogin, mcp: cadastro("ms365", true, ferramentas), call });

  assert.deepEqual(lista, [{ teamId: EQUIPE, teamName: "Time", channelId: CANAL, channelName: "Geral" }]);
  assert.deepEqual(chamadas, [
    { tool: "list-joined-teams", args: {} },
    { tool: "list-team-channels", args: { teamId: EQUIPE, $select: "id,displayName" } },
  ]);

  await assert.rejects(
    listTeamsChannels({ token: semLogin, mcp: { list: async () => [], cachedTools: async () => null } }),
    /Em Conexões, entre com o Teams ou ligue um servidor/,
  );
});
