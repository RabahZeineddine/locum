import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { schema } from "../src/db/index.js";
import { TriggerConfig } from "../src/config/types.js";
import { extractGithubPrLinks } from "../src/sources/github-pr-link.js";
import { pollTeamsInbox } from "../src/sources/teams-inbox.js";
import { bancoDeTeste as bancoVazio } from "./helpers/db.js";

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
    ["https://www.github.com/acme/api/pull/7", [{ owner: "acme", repo: "api", pull: 7 }]],
    [`<code>${PR}</code> mas veja <a href="${PR}/files">isto</a>`, [{ owner: "acme", repo: "api", pull: 7 }]],
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
    `<code>${PR}</code>`,
    `<pre>\n${PR}\n</pre>`,
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
      return json({ value: chats.map((c) => ({ id: c.id, chatType: c.chatType, lastMessagePreview: { createdDateTime: agoraMenos(-1) } })) });
    }
    const chat = chats.find((c) => caminho === `/chats/${c.id}/messages`);
    if (chat) return json({ value: chat.mensagens.map((m) => ({ ...(m as object), chatId: chat.id })) });
    if (caminho === `/teams/${EQUIPE}/channels/${CANAL}/messages`) return json({ value: opcoes.threads ?? [] });
    return json({}, 404);
  }) as typeof fetch;
  return { fetchFn };
}

/** PR já enriquecido, para os testes de detecção não esbarrarem no GitHub. */
const semGithub = {
  fetchPr: (async (owner: string, repo: string, pull: number) => ({
    repo: `${owner}/${repo}`,
    owner,
    repoName: repo,
    pull,
    headSha: `sha-${owner}-${repo}-${pull}`,
    author: "autor-do-pr",
    draft: false,
    state: "open",
    diff: "d",
  })) as never,
  viewerLogin: async () => null,
};

const CANAIS = [{ teamId: EQUIPE, channelId: CANAL, label: "Time / Geral" }];

/** Banco de quem já varreu ontem: o cursor compartilhado antigo existe, e a primeira batida não é de hoje. */
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

test("canal sem menção com link de PR só acorda com prLinks", async () => {
  const threads = [mensagem("300", 3, `<p>revisa? <a href="${PR}">PR</a></p>`)];

  const sem = bancoDeTeste();
  await pollTeamsInbox({ mentions: true, dms: true, channels: CANAIS }, { db: sem, token, ...semGithub, ...graphFalso({ threads }) });
  assert.equal((await eventos(sem)).length, 0);

  const com = bancoDeTeste();
  const resultado = await pollTeamsInbox(
    { mentions: false, dms: false, prLinks: true, channels: CANAIS },
    { db: com, token, ...semGithub, ...graphFalso({ threads }) },
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
    { db, token, ...semGithub, ...graphFalso({ threads: [mensagem("1", 2, "<p>bom dia https://github.com/acme/api/issues/3</p>")] }) },
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
  await pollTeamsInbox({ mentions: false, dms: false, prLinks: true }, { db, token, ...semGithub, ...graphFalso({ chats }) });
  const ids = (await eventos(db)).map((e) => e.messageId).sort();
  assert.deepEqual(ids, ["m1", "m2"]);

  const so = bancoDeTeste();
  await pollTeamsInbox({ mentions: true, dms: false, prLinks: true }, { db: so, token, ...semGithub, ...graphFalso({ chats }) });
  assert.deepEqual((await eventos(so)).map((e) => e.messageId).sort(), ["m1", "m2", "m4"]);
});

test("mensagem do próprio usuário com link conta; sem link, não", async () => {
  const db = bancoDeTeste();
  const eu = { from: { user: { id: "EU" } } };
  const chats = [
    { id: "g", chatType: "group", mensagens: [mensagem("m1", 2, PR, eu), mensagem("m2", 2, "só conversa", eu)] },
  ];
  await pollTeamsInbox({ mentions: true, dms: true, prLinks: true }, { db, token, ...semGithub, ...graphFalso({ chats }) });
  assert.deepEqual((await eventos(db)).map((e) => e.messageId), ["m1"]);

  const sem = bancoDeTeste();
  await pollTeamsInbox({ mentions: true, dms: true }, { db: sem, token, ...semGithub, ...graphFalso({ chats }) });
  assert.equal((await eventos(sem)).length, 0);
});

test("dois links na mesma mensagem viram um evento por PR, sem duplicar na batida seguinte", async () => {
  const db = bancoDeTeste();
  const chats = [
    { id: "g", chatType: "group", mensagens: [mensagem("m1", 2, `${PR} e https://github.com/acme/web/pull/9`)] },
  ];
  const watch = { mentions: false, dms: false, prLinks: true };
  const primeira = await pollTeamsInbox(watch, { db, token, ...semGithub, ...graphFalso({ chats }) });
  assert.equal(primeira.eventIds.length, 2);
  const prs = (await eventos(db)).map((e) => e.repo).sort();
  assert.deepEqual(prs, ["acme/api", "acme/web"]);

  const segunda = await pollTeamsInbox(watch, { db, token, ...semGithub, ...graphFalso({ chats }) });
  assert.equal(segunda.eventIds.length, 0);
});

const CONTEXTO_DO_PR = {
  repo: "acme/api",
  owner: "acme",
  repoName: "api",
  pull: 7,
  title: "Corrige o pedido",
  description: "descrição",
  headSha: "abc123",
  changedFiles: ["src/a.ts"],
  diff: "diff --git a/src/a.ts b/src/a.ts",
  omittedFiles: [],
  omittedSummary: "nenhum",
  ci: { summary: "verde" },
  author: "autor-do-pr",
  url: "https://github.com/acme/api/pull/7",
};

test("o evento com PR é enriquecido com o contexto do PR e guarda a mensagem de origem", async () => {
  const db = bancoDeTeste();
  const pedidos: unknown[][] = [];
  const fetchPr = (async (...args: unknown[]) => {
    pedidos.push(args);
    return CONTEXTO_DO_PR;
  }) as never;
  const chats = [{ id: "g", chatType: "group", mensagens: [mensagem("m1", 2, PR)] }];

  await pollTeamsInbox({ mentions: false, dms: false, prLinks: true }, { db, token, fetchPr, viewerLogin: async () => null, ...graphFalso({ chats }) });

  assert.deepEqual(pedidos, [["acme", "api", 7]]);
  const [evento] = await eventos(db);
  for (const campo of ["repo", "title", "description", "diff", "omittedSummary", "owner", "repoName", "pull", "headSha"]) {
    assert.deepEqual(evento?.[campo], (CONTEXTO_DO_PR as Record<string, unknown>)[campo], campo);
  }
  assert.deepEqual(evento?.ci, { summary: "verde" });
  assert.equal(evento?.author, "autor-do-pr");
  assert.equal(evento?.teamsAuthor, "Outra Pessoa");
  assert.equal(evento?.teamsChatId, "g");
  assert.equal(evento?.teamsMessageId, "m1");
  assert.equal(evento?.prError, undefined);
});

test("canal e resposta em thread guardam equipe, canal, mensagem e a thread", async () => {
  const db = bancoDeTeste();
  const fetchPr = (async () => CONTEXTO_DO_PR) as never;
  const threads = [{ ...mensagem("200", 30, "<p>raiz</p>"), replies: [mensagem("201", 2, PR)] }, mensagem("300", 2, PR)];

  await pollTeamsInbox(
    { mentions: false, dms: false, prLinks: true, channels: CANAIS },
    { db, token, fetchPr, viewerLogin: async () => null, ...graphFalso({ threads }) },
  );

  const porMensagem = new Map((await eventos(db)).map((e) => [e.teamsMessageId, e]));
  const raiz = porMensagem.get("300")!;
  assert.deepEqual([raiz.teamsTeamId, raiz.teamsChannelId, raiz.teamsReplyToId], [EQUIPE, CANAL, undefined]);
  const resposta = porMensagem.get("201")!;
  assert.deepEqual([resposta.teamsTeamId, resposta.teamsChannelId, resposta.teamsReplyToId], [EQUIPE, CANAL, "200"]);
  assert.equal(resposta.diff, CONTEXTO_DO_PR.diff);
});

test("falha ao buscar o PR não derruba a varredura nem o evento", async () => {
  const db = bancoDeTeste();
  const fetchPr = (async () => {
    throw new Error("GitHub fora");
  }) as never;
  const chats = [{ id: "g", chatType: "group", mensagens: [mensagem("m1", 2, PR), mensagem("m2", 1, "oi")] }];

  const resultado = await pollTeamsInbox(
    { mentions: false, dms: true, prLinks: true },
    { db, token, fetchPr, viewerLogin: async () => null, ...graphFalso({ chats }) },
  );

  // O PR que não deu para buscar não acorda o agent; a conversa comum acorda.
  assert.equal(resultado.eventIds.length, 1);
  assert.equal(resultado.inWindow.length, 1);
  assert.equal(resultado.errors.length, 1);
  assert.match(resultado.errors[0]!.error, /GitHub fora/);
  const evento = (await eventos(db)).find((e) => e.messageId === "m1")!;
  assert.equal(evento.diff, undefined);
  assert.equal(evento.prNumber, 7);
  assert.match(String(evento.prError), /GitHub fora/);
});

test("mensagem sem prLinks não busca PR", async () => {
  const db = bancoDeTeste();
  let buscas = 0;
  const fetchPr = (async () => {
    buscas++;
    return CONTEXTO_DO_PR;
  }) as never;
  const chats = [{ id: "g", chatType: "group", mensagens: [mensagem("m1", 2, PR)] }];
  await pollTeamsInbox({ mentions: false, dms: true }, { db, token, fetchPr, viewerLogin: async () => null, ...graphFalso({ chats }) });
  assert.equal(buscas, 0);
  assert.equal((await eventos(db))[0]?.diff, undefined);
});

const OPCOES = { token, ...semGithub };

test("dois gatilhos sobre a mesma mensagem, nas duas ordens, cada um vê o seu evento", async () => {
  const chats = [{ id: "g", chatType: "group", mensagens: [mensagem("m1", 2, PR)] }];
  const resposta = { mentions: false, dms: true };
  const revisao = { mentions: false, dms: false, prLinks: true };

  for (const ordem of [["resposta", "revisao"], ["revisao", "resposta"]]) {
    const db = bancoDeTeste();
    const achados: Record<string, string[]> = {};
    for (const quem of ordem) {
      const r = await pollTeamsInbox(quem === "resposta" ? resposta : revisao, {
        db,
        triggerId: quem,
        ...OPCOES,
        ...graphFalso({ chats }),
      });
      const linhas = await db.select().from(schema.events);
      achados[quem] = linhas.filter((e) => r.inWindow.includes(e.id)).map((e) => String((e.payload as { kind: string }).kind));
    }
    assert.deepEqual(achados, { resposta: ["dm"], revisao: ["pr"] }, ordem.join(" > "));
  }
});

test("o gatilho sem cursor próprio parte do compartilhado de antes, sem reprocessar", async () => {
  const db = bancoVazio();
  db.insert(schema.cursors)
    .values({ source: "teams", key: "inbox", value: agoraMenos(60) })
    .run();
  const chats = [
    { id: "g", chatType: "group", mensagens: [mensagem("velha", 180, "antiga"), mensagem("nova", 30, "recente")] },
  ];
  await pollTeamsInbox({ mentions: false, dms: true }, { db, triggerId: "T", ...OPCOES, ...graphFalso({ chats }) });
  const ids = (await eventos(db)).map((e) => e.messageId);
  assert.deepEqual(ids, ["nova"]);

  const cursores = await db.select().from(schema.cursors);
  assert.deepEqual(cursores.map((c) => c.key).sort(), ["inbox", "inbox:T"]);
  assert.equal(cursores.find((c) => c.key === "inbox")?.value.slice(0, 13), agoraMenos(60).slice(0, 13));
});

test("primeira batida sem cursor nenhum não puxa link de PR anterior à ativação", async () => {
  const db = bancoVazio();
  const chats = [
    {
      id: "g",
      chatType: "group",
      mensagens: [mensagem("ontem", 120, PR), mensagem("conversa", 90, "bom dia")],
    },
  ];
  const watch = { mentions: false, dms: false, prLinks: true };
  await pollTeamsInbox(watch, { db, triggerId: "T", ...OPCOES, ...graphFalso({ chats }) });
  assert.deepEqual(await eventos(db), []);

  // Com dms ligado a mensagem antiga ainda acorda como conversa, mas sem virar evento de PR.
  const comDms = bancoVazio();
  await pollTeamsInbox({ ...watch, dms: true }, { db: comDms, triggerId: "T", ...OPCOES, ...graphFalso({ chats }) });
  assert.deepEqual(
    (await eventos(comDms)).map((e) => [e.messageId, e.kind, e.prOwner]).sort(),
    [["conversa", "dm", undefined], ["ontem", "dm", undefined]],
  );

  const depois = [...chats, { id: "h", chatType: "group", mensagens: [mensagem("agora", 0, PR)] }];
  await pollTeamsInbox(watch, { db, triggerId: "T", ...OPCOES, ...graphFalso({ chats: depois }) });
  assert.ok((await eventos(db)).some((e) => e.messageId === "agora" && e.kind === "pr"));
});

test("canal novo, sem cursor, também só vê link a partir de agora", async () => {
  const db = bancoVazio();
  const threads = [mensagem("antigo", 120, PR)];
  await pollTeamsInbox(
    { mentions: false, dms: false, prLinks: true, channels: CANAIS },
    { db, triggerId: "T", ...OPCOES, ...graphFalso({ threads }) },
  );
  assert.equal((await eventos(db)).length, 0);
});

test("cursor antigo de 2h é herdado; de 30 dias não é, e nenhum link anterior à ativação acorda", async () => {
  const chats = [
    {
      id: "g",
      chatType: "group",
      mensagens: [mensagem("ha3h", 180, PR), mensagem("ha1h", 60, `${PR}/files`), mensagem("recente", 0.5, "oi")],
    },
  ];
  const watch = { mentions: false, dms: false, prLinks: true };

  const recente = bancoVazio();
  recente.insert(schema.cursors).values({ source: "teams", key: "inbox", value: agoraMenos(120) }).run();
  await pollTeamsInbox(watch, { db: recente, triggerId: "T", ...OPCOES, ...graphFalso({ chats }) });
  // Herdou as 2h: só o que é posterior a elas conta, e a de 3h fica de fora.
  assert.deepEqual((await eventos(recente)).map((e) => e.messageId), ["ha1h"]);

  const velho = bancoVazio();
  velho.insert(schema.cursors).values({ source: "teams", key: "inbox", value: agoraMenos(30 * 24 * 60) }).run();
  await pollTeamsInbox(watch, { db: velho, triggerId: "T", ...OPCOES, ...graphFalso({ chats }) });
  assert.deepEqual(await eventos(velho), []);

  // O gatilho com dms ainda lê a janela de um dia, e só ela, não o mês.
  const comDms = bancoVazio();
  comDms.insert(schema.cursors).values({ source: "teams", key: "inbox", value: agoraMenos(30 * 24 * 60) }).run();
  const antigas = [{ id: "g", chatType: "group", mensagens: [mensagem("mes", 30 * 24 * 60, "velha"), mensagem("hoje", 60, "oi")] }];
  await pollTeamsInbox({ ...watch, dms: true }, { db: comDms, triggerId: "T", ...OPCOES, ...graphFalso({ chats: antigas }) });
  assert.deepEqual((await eventos(comDms)).map((e) => e.messageId), ["hoje"]);
});
