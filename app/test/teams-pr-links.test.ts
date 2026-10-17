import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { schema } from "../src/db/index.js";
import { TriggerConfig } from "../src/config/types.js";
import { extractGithubPrLinks, extrairLinksDePr } from "../src/sources/github-pr-link.js";
import { pollTeamsInbox } from "../src/sources/teams-inbox.js";
import { bancoDeTeste as bancoVazio, plantarGatilho } from "./helpers/db.js";

/** Banco com o gatilho `T` que os testes passam como `triggerId`: a gravação de estado confere que ele existe. */
function bancoComT() {
  const db = bancoVazio();
  plantarGatilho(db, { id: "T", agentId: "dono", config: { kind: "schedule", everyMinutes: 30 }, enabled: true });
  return db;
}

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
  const db = bancoComT();
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

const WEB = "https://github.com/acme/web/pull/9";
const WATCH_PR = { mentions: false, dms: false, prLinks: true, agruparPrs: true };
const WATCH_SEPARADO = { mentions: false, dms: false, prLinks: true };
const chatCom = (html: string) => [{ id: "g", chatType: "group", mensagens: [mensagem("m1", 2, html)] }];

test("dois links na mesma mensagem viram um evento só, com a lista de PRs, sem duplicar na batida seguinte", async () => {
  const db = bancoDeTeste();
  const chats = chatCom(`${PR} e ${WEB}`);
  const primeira = await pollTeamsInbox(WATCH_PR, { db, token, ...semGithub, ...graphFalso({ chats }) });
  assert.equal(primeira.eventIds.length, 1);
  const [evento, ...resto] = await eventos(db);
  assert.equal(resto.length, 0);
  const prs = evento!.prs as Record<string, unknown>[];
  assert.deepEqual(prs.map((p) => [p.repo, p.prNumber, p.diff]), [["acme/api", 7, "d"], ["acme/web", 9, "d"]]);
  assert.deepEqual(prs.map((p) => p.prOwner), ["acme", "acme"]);
  // O que as specs gravadas leem continua sendo o primeiro PR.
  assert.deepEqual([evento!.repo, evento!.prNumber, evento!.diff, evento!.teamsMessageId], ["acme/api", 7, "d", "m1"]);
  assert.match(String(evento!.prsTexto), /acme\/api#7[\s\S]*acme\/web#9/);
  assert.equal(evento!.prsCortados, undefined);

  const segunda = await pollTeamsInbox(WATCH_PR, { db, token, ...semGithub, ...graphFalso({ chats }) });
  assert.equal(segunda.eventIds.length, 0);
});

test("PR que já tem review sai da lista, e se todos já têm nada é gerado", async () => {
  const db = bancoDeTeste();
  const antes = await pollTeamsInbox(WATCH_PR, { db, token, ...semGithub, ...graphFalso({ chats: chatCom(PR) }) });
  assert.equal(antes.eventIds.length, 1);

  // Outra mensagem cita o PR já pego e um novo: só o novo entra.
  const mista = [{ id: "g2", chatType: "group", mensagens: [mensagem("m2", 1, `${PR} ${WEB}`)] }];
  const r = await pollTeamsInbox(WATCH_PR, { db, token, ...semGithub, ...graphFalso({ chats: mista }) });
  assert.deepEqual(r.descartes.map((d) => [d.pr, d.motivo]), [["acme/api#7", "repetido"]]);
  const segundo = (await eventos(db)).find((e) => e.messageId === "m2");
  assert.deepEqual((segundo!.prs as { prNumber: number }[]).map((p) => p.prNumber), [9]);
  assert.equal(segundo!.prNumber, 9);

  // Agora os dois já foram: a mensagem nova não gera evento.
  const todos = [{ id: "g3", chatType: "group", mensagens: [mensagem("m3", 1, `${PR} ${WEB}`)] }];
  const nada = await pollTeamsInbox(WATCH_PR, { db, token, ...semGithub, ...graphFalso({ chats: todos }) });
  assert.deepEqual(nada.inWindow, []);
  assert.equal((await eventos(db)).filter((e) => e.prs !== undefined).length, 2);
});

test("gatilho sem agruparPrs (o padrão e o já gravado) gera um evento por PR, e o dedupe é por PR", async () => {
  const db = bancoDeTeste();
  const chats = chatCom(`${PR} e ${WEB}`);
  const primeira = await pollTeamsInbox(WATCH_SEPARADO, { db, token, ...semGithub, ...graphFalso({ chats }) });
  assert.equal(primeira.eventIds.length, 2);
  const lista = await eventos(db);
  assert.deepEqual(lista.map((e) => e.repo).sort(), ["acme/api", "acme/web"]);
  assert.ok(lista.every((e) => (e.prs as unknown[]).length === 1));

  const segunda = await pollTeamsInbox(WATCH_SEPARADO, { db, token, ...semGithub, ...graphFalso({ chats }) });
  assert.equal(segunda.eventIds.length, 0);
  // Mensagem nova com o PR já revisado e um novo: só o novo gera evento.
  const nova = [{ id: "g2", chatType: "group", mensagens: [mensagem("m2", -0.2, `${PR} https://github.com/acme/web/pull/10`)] }];
  const r = await pollTeamsInbox(WATCH_SEPARADO, { db, token, ...semGithub, ...graphFalso({ chats: nova }) });
  assert.deepEqual(r.descartes.map((d) => [d.pr, d.motivo]), [["acme/api#7", "repetido"]]);
  assert.equal(r.inWindow.length, 1);
});

test("o PR que o evento não cobriu não conta como revisado", async () => {
  const db = bancoDeTeste();
  // PR 7 falha no GET: o evento cobre só o 9 (depois do limite de tentativas), e o 7 pode voltar depois.
  const falha7 = (async (o: string, r: string, p: number) => {
    if (p === 7) throw new Error("502");
    return (semGithub.fetchPr as (o: string, r: string, p: number) => Promise<unknown>)(o, r, p);
  }) as never;
  for (let i = 0; i < 3; i++) await pollTeamsInbox(WATCH_PR, { db, token, ...semGithub, fetchPr: falha7, ...graphFalso({ chats: chatCom(`${PR} ${WEB}`) }) });
  const { carregarRevisados } = await import("../src/sources/teams-inbox.js");
  const revisados = await carregarRevisados(db);
  assert.deepEqual([...revisados].map((k) => k.split("@")[0]), ["acme/web#9"]);
});

test("PR cujo GET falha fica pendente e entra na batida seguinte, sem acordar o agent antes", async () => {
  const db = bancoDeTeste();
  let falhar = true;
  const fetchPr = (async (o: string, r: string, p: number) => {
    if (p === 9 && falhar) throw new Error("502");
    return (semGithub.fetchPr as (o: string, r: string, p: number) => Promise<unknown>)(o, r, p);
  }) as never;
  const chats = chatCom(`${PR} ${WEB}`);
  const primeira = await pollTeamsInbox(WATCH_PR, { db, token, ...semGithub, fetchPr, ...graphFalso({ chats }) });
  assert.match(primeira.errors[0]!.error, /acme\/web#9: 502/);
  assert.deepEqual(primeira.inWindow, []);
  const [pendente] = await eventos(db);
  assert.equal(pendente!.prs, undefined);
  assert.equal((pendente!.prsPendentes as unknown[]).length, 2);

  falhar = false;
  const segunda = await pollTeamsInbox(WATCH_PR, { db, token, ...semGithub, fetchPr, ...graphFalso({ chats }) });
  assert.equal(segunda.inWindow.length, 1);
  const [pronto] = await eventos(db);
  assert.deepEqual((pronto!.prs as { prNumber: number }[]).map((p) => p.prNumber), [7, 9]);
  assert.equal(pronto!.prsPendentes, undefined);
});

test("PR que falha a cada batida não segura os outros para sempre: depois de três tentativas o evento sai com o que deu", async () => {
  const db = bancoDeTeste();
  const fetchPr = (async (o: string, r: string, p: number) => {
    if (p === 9) throw new Error("404");
    return (semGithub.fetchPr as (o: string, r: string, p: number) => Promise<unknown>)(o, r, p);
  }) as never;
  const chats = chatCom(`${PR} ${WEB}`);
  for (let i = 0; i < 2; i++) assert.deepEqual((await pollTeamsInbox(WATCH_PR, { db, token, ...semGithub, fetchPr, ...graphFalso({ chats }) })).inWindow, []);
  const ultima = await pollTeamsInbox(WATCH_PR, { db, token, ...semGithub, fetchPr, ...graphFalso({ chats }) });
  assert.equal(ultima.inWindow.length, 1);
  const [evento] = await eventos(db);
  assert.deepEqual((evento!.prs as { prNumber: number }[]).map((p) => p.prNumber), [7]);
  assert.equal(evento!.prsFalharam, "acme/web#9");
  // O prompt também fica sabendo que esse PR não foi revisado.
  assert.match(String(evento!.prsTexto), /acme\/web#9 não foi revisado: não deu para buscar/);
});

test("evento em que todos os PRs falham: depois de três tentativas vira descarte com motivo e sai da espera", async () => {
  const db = bancoDeTeste();
  const fetchPr = (async () => {
    throw new Error("404");
  }) as never;
  const chats = chatCom(`${PR} ${WEB}`);
  const descartes: { pr: string; motivo: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await pollTeamsInbox(WATCH_PR, { db, token, ...semGithub, fetchPr, ...graphFalso({ chats }) });
    assert.deepEqual(r.inWindow, []);
    descartes.push(...r.descartes);
  }
  assert.deepEqual(descartes.map((d) => d.motivo), ["não deu para buscar o PR"]);
  assert.match(descartes[0]!.pr, /acme\/api#7.*acme\/web#9/);
  const [evento] = await eventos(db);
  assert.equal(evento!.prDescartado, "não deu para buscar o PR");
  assert.equal(evento!.prsPendentes, undefined);
  // Fora da espera: a quarta batida não tenta de novo nem descarta outra vez.
  let buscas = 0;
  const contando = (async () => {
    buscas++;
    throw new Error("404");
  }) as never;
  const quarta = await pollTeamsInbox(WATCH_PR, { db, token, ...semGithub, fetchPr: contando, ...graphFalso({ chats }) });
  assert.equal(buscas, 0);
  assert.deepEqual(quarta.descartes, []);
});

test("maxPrs do gatilho manda no teto, e prsTexto avisa quantos PRs não entraram", async () => {
  const db = bancoDeTeste();
  const links = [1, 2, 3, 4].map((n) => `https://github.com/acme/api/pull/${n}`).join(" ");
  await pollTeamsInbox({ ...WATCH_PR, maxPrs: 2 }, { db, token, ...semGithub, ...graphFalso({ chats: chatCom(links) }) });
  const [evento] = await eventos(db);
  assert.equal((evento!.prs as unknown[]).length, 2);
  assert.equal(evento!.prsCortados, 2);
  assert.match(String(evento!.prsTexto), /mais 2 PRs não entraram \(limite de 2 por mensagem\)/);
});

test("mais de cinco links: cinco entram e o evento diz quantos ficaram de fora", async () => {
  const db = bancoDeTeste();
  const links = [1, 2, 3, 4, 5, 6, 7].map((n) => `https://github.com/acme/api/pull/${n}`).join(" ");
  await pollTeamsInbox(WATCH_PR, { db, token, ...semGithub, ...graphFalso({ chats: chatCom(links) }) });
  const [evento] = await eventos(db);
  assert.equal((evento!.prs as unknown[]).length, 5);
  assert.equal(evento!.prsCortados, 2);
});

test("spec gravada com os campos de um PR só segue renderizando pelo primeiro PR da lista", async () => {
  const db = bancoDeTeste();
  await pollTeamsInbox(WATCH_PR, { db, token, ...semGithub, ...graphFalso({ chats: chatCom(`${PR} ${WEB}`) }) });
  const [evento] = await eventos(db);
  const { renderPrompt } = await import("../src/executor/executor.js");
  assert.equal(renderPrompt("{{event.repo}}#{{event.prNumber}}", evento as never, new Map()), "acme/api#7");
});

test("o limite de links diz quantos ficaram de fora", () => {
  const links = [1, 2, 2, 3, 4, 5, 6, 7].map((n) => `https://github.com/acme/api/pull/${n}`).join(" ");
  const { prs, cortados } = extrairLinksDePr(links);
  assert.deepEqual([prs.length, cortados], [5, 2]);
  assert.deepEqual(extrairLinksDePr(links, 3).prs.length, 3);
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
  const db = bancoComT();
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
  const db = bancoComT();
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
  const comDms = bancoComT();
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
  const db = bancoComT();
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

  const recente = bancoComT();
  recente.insert(schema.cursors).values({ source: "teams", key: "inbox", value: agoraMenos(120) }).run();
  await pollTeamsInbox(watch, { db: recente, triggerId: "T", ...OPCOES, ...graphFalso({ chats }) });
  // Herdou as 2h: só o que é posterior a elas conta, e a de 3h fica de fora.
  assert.deepEqual((await eventos(recente)).map((e) => e.messageId), ["ha1h"]);

  const velho = bancoComT();
  velho.insert(schema.cursors).values({ source: "teams", key: "inbox", value: agoraMenos(30 * 24 * 60) }).run();
  await pollTeamsInbox(watch, { db: velho, triggerId: "T", ...OPCOES, ...graphFalso({ chats }) });
  assert.deepEqual(await eventos(velho), []);

  // O gatilho com dms ainda lê a janela de um dia, e só ela, não o mês.
  const comDms = bancoComT();
  comDms.insert(schema.cursors).values({ source: "teams", key: "inbox", value: agoraMenos(30 * 24 * 60) }).run();
  const antigas = [{ id: "g", chatType: "group", mensagens: [mensagem("mes", 30 * 24 * 60, "velha"), mensagem("hoje", 60, "oi")] }];
  await pollTeamsInbox({ ...watch, dms: true }, { db: comDms, triggerId: "T", ...OPCOES, ...graphFalso({ chats: antigas }) });
  assert.deepEqual((await eventos(comDms)).map((e) => e.messageId), ["hoje"]);
});
