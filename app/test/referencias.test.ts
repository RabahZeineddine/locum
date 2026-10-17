import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { schema } from "../src/db/index.js";
import { catalogoDeReferencias, esquemaDaSaida, numerarPassos, referenciasDoEsquema, type EsquemaJson } from "../src/config/referencias.js";
import { TriggerConfig, type Step } from "../src/config/types.js";
import { ESQUEMA_DA_LOGICA } from "../src/executor/esquemas-de-logica.js";
import { runLogic } from "../src/executor/logic.js";
import { esquemaDoEvento } from "../src/sources/esquemas-de-evento.js";
import { fetchPr, type PrClient, type PrContext } from "../src/sources/github.js";
import { pollMcpServer, type McpCaller } from "../src/sources/mcp-poll.js";
import { slackShape } from "../src/sources/slack.js";
import { pollSlackInbox } from "../src/sources/slack-inbox.js";
import { pollTeamsInbox } from "../src/sources/teams-inbox.js";
import { buildGate } from "../src/executor/build.js";
import { AgentService } from "../src/services/agent-service.js";
import { EventoManual } from "../src/services/evento-manual.js";
import { ExecutionService } from "../src/services/execution-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/* ------------------------------------------------- esquema vira caminhos */

test("esquema vira caminhos: objeto desce um nível, lista entra pelo item 0, anyOf junta as variantes", () => {
  const esquema: EsquemaJson = {
    type: "object",
    properties: {
      verdict: { type: "string", description: "o veredito" },
      dono: { type: "object", properties: { nome: { type: "string" }, dados: { type: "object", properties: { fundo: { type: "string" } } } } },
      findings: { type: "array", items: { type: "object", properties: { severity: { type: "string" }, local: { type: "object", properties: { linha: { type: "number" } } } } } },
      tags: { type: "array", items: { type: "string" } },
      "nome com espaço": { type: "string" },
      opcional: { anyOf: [{ type: "null" }, { type: "object", properties: { a: { type: "string" } } }] },
    },
  };
  const caminhos = referenciasDoEsquema(esquema).map((r) => r.caminho);
  assert.deepEqual(caminhos, [
    "verdict",
    "dono",
    "dono.nome",
    "dono.dados",
    "findings",
    "findings.0",
    "findings.0.severity",
    "findings.0.local",
    "tags",
    "tags.0",
    "opcional",
    "opcional.a",
  ]);
  assert.equal(referenciasDoEsquema(esquema)[0]?.descricao, "o veredito");
  assert.equal(referenciasDoEsquema(esquema).find((r) => r.caminho === "findings")?.tipo, "array");
});

/* ------------------------------------------------------------ numeração */

const passo = (key: string, needs: string[] = [], name = key): Step => ({ type: "model", key, name, needs, optional: false, model: "m", prompt: "", requiresServers: [], maxSteps: 1 }) as Step;
const numeros = (steps: Step[]) => Object.fromEntries(numerarPassos(steps));

test("numeração: ordem do fluxo, com desempate pela ordem no spec", () => {
  assert.deepEqual(numeros([passo("a"), passo("b", ["a"]), passo("c", ["b"])]), { a: 1, b: 2, c: 3 });
  // ramos: dois passos seguem o mesmo pai e ficam na ordem em que aparecem no spec
  assert.deepEqual(numeros([passo("a"), passo("x", ["a"]), passo("y", ["a"])]), { a: 1, x: 2, y: 3 });
  // junção: o passo que espera os dois só vem depois deles, mesmo escrito antes no spec
  assert.deepEqual(numeros([passo("fim", ["x", "y"]), passo("x"), passo("y")]), { x: 1, y: 2, fim: 3 });
});

test("numeração: passo novo no meio empurra os seguintes, e fluxo com ciclo cai na ordem do spec", () => {
  const antes = numeros([passo("a"), passo("c", ["a"])]);
  const depois = numeros([passo("a"), passo("novo", ["a"]), passo("c", ["novo"])]);
  assert.deepEqual([antes.a, antes.c], [1, 2]);
  assert.deepEqual([depois.a, depois.novo, depois.c], [1, 2, 3]);
  assert.deepEqual(numeros([passo("p", ["q"]), passo("q", ["p"])]), { p: 1, q: 2 });
});

/* -------------------------------------------------------------- catálogo */

test("catálogo: evento primeiro, depois só os passos anteriores, cada um com número e nome", () => {
  const revisar = { ...passo("revisar", [], "Revisar o PR"), outputSchema: { type: "object", properties: { findings: { type: "array", items: { type: "object", properties: { severity: { type: "string" } } } } } } } as Step;
  const publicar = { type: "action", key: "publicar", name: "Publicar", needs: ["revisar"], optional: false, action: "teams.post", mode: "approve" } as Step;
  const depois = passo("depois", ["publicar"]);
  const grupos = catalogoDeReferencias({
    passos: [revisar, publicar, depois],
    chave: "depois",
    eventos: [{ type: "object", properties: { text: { type: "string" } } }, null],
    fontes: { acao: () => ({ type: "object", properties: { state: { type: "string" } } }) },
    saidas: { publicar: { state: "published", messageId: "m1" } },
  });
  assert.deepEqual(grupos.map((g) => [g.id, g.numero, g.nome]), [["event", undefined, undefined], ["revisar", 1, "Revisar o PR"], ["publicar", 2, "Publicar"]]);
  assert.deepEqual(grupos[0]!.itens.map((i) => i.caminho), ["event", "event.text"]);
  assert.deepEqual(grupos[1]!.itens.map((i) => i.caminho), ["steps.revisar", "steps.revisar.findings", "steps.revisar.findings.0", "steps.revisar.findings.0.severity"]);
  const doRun = grupos[2]!.itens.filter((i) => i.origem === "ultimo-run").map((i) => i.caminho);
  assert.deepEqual(doRun, ["steps.publicar.messageId"], "o que o esquema já traz não repete; o que só o run mostra entra");
  assert.equal(catalogoDeReferencias({ passos: [revisar], chave: "revisar", eventos: [] }).length, 0, "sem evento e sem passo anterior, nada");
});

/* ------------------------------- esquemas de saída contra o que acontece */

test("lógica: a saída de cada operação valida contra o esquema declarado", () => {
  const base = { type: "logic", name: "l", needs: [], optional: false, value: "{{event.x}}", compare: "equals", against: "a", cases: ["a"], title: "T" };
  const evento = { repo: "r", changedFiles: [], x: "a" };
  for (const op of Object.keys(ESQUEMA_DA_LOGICA) as (keyof typeof ESQUEMA_DA_LOGICA)[]) {
    const valor = op === "json.parse" ? '{"a":1}' : "a";
    const saida = runLogic({ ...base, key: "l", op, value: op === "json.parse" ? valor : base.value } as never, evento, new Map());
    const r = z.fromJSONSchema(ESQUEMA_DA_LOGICA[op] as never).safeParse(saida);
    assert.ok(r.success, `${op}: ${JSON.stringify(saida)}`);
  }
});

test("toda ação do registro declara a saída, e a que só guarda o estado traz { state }", () => {
  const acoes = buildGate().describe();
  assert.ok(acoes.length >= 10);
  for (const a of acoes) assert.equal(typeof a.outputSchema, "object", a.kind);
  const porKind = new Map(acoes.map((a) => [a.kind, a.outputSchema]));
  assert.ok(Object.keys(porKind.get("teams.post")?.properties ?? {}).includes("state"));
  const step = { type: "action", key: "k", name: "k", needs: [], optional: false, action: "mcp.call", mode: "approve", params: { server: "fx", tool: "t" } } as Step;
  const daFerramenta = { type: "object", properties: { id: { type: "string" } } };
  assert.equal(esquemaDaSaida(step, { acao: (k) => porKind.get(k), ferramenta: () => daFerramenta }), daFerramenta, "o outputSchema da ferramenta vale sobre o da ação");
  assert.equal(esquemaDaSaida(step, { acao: (k) => porKind.get(k) }), porKind.get("mcp.call"));
});

/* ----------------------------- o evento que cada gatilho emite × esquema */

/** Campos que o executor lê de todo evento ou que a fonte guarda crus, e que ninguém cita. */
const INTERNOS = ["changedFiles", "item"];

function confere(nome: string, config: TriggerConfig, payload: Record<string, unknown>, internos: string[] = []): void {
  const esquema = esquemaDoEvento(config);
  assert.ok(esquema !== null, `${nome}: gatilho sem esquema`);
  const lido = z.fromJSONSchema(esquema as never).safeParse(payload);
  assert.ok(lido.success, `${nome}: o evento emitido não valida contra o esquema: ${lido.success ? "" : JSON.stringify(lido.error.issues)}`);
  const declarados = new Set(Object.keys(esquema.properties ?? {}));
  const sobrando = Object.keys(payload).filter((k) => !declarados.has(k) && ![...INTERNOS, ...internos].includes(k));
  assert.deepEqual(sobrando, [], `${nome}: a fonte emite campo que o esquema não declara`);
  for (const k of esquema.required as string[] | undefined ?? []) assert.ok(k in payload, `${nome}: o esquema exige ${k} e o evento não traz`);
}

const eventosDe = async (db: ReturnType<typeof bancoDeTeste>, source?: string) =>
  (await (source === undefined ? db.select().from(schema.events) : db.select().from(schema.events).where(eq(schema.events.source, source)))).map((e) => e.payload as Record<string, unknown>);

const PR = "https://github.com/acme/api/pull/7";
const EQUIPE = "11111111-2222-3333-4444-555555555555";
const CANAL = "19:geral@thread.tacv2";
const agoraMenos = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const prDeMentira = (owner: string, repo: string, pull: number): PrContext => ({
  repo: `${owner}/${repo}`, owner, repoName: repo, pull, title: "Corrige o saldo", description: "d", headSha: "abc", changedFiles: ["a.ts"], diff: "+x", author: "maria",
  baseBranch: "main", headBranch: "fix/saldo", url: PR, additions: 1, deletions: 0, fileCount: 1, draft: false, state: "open", merged: false,
});

function graphFalso(chats: { id: string; chatType: string; mensagens: unknown[] }[], threads: unknown[] = []) {
  return (async (entrada: string | URL) => {
    const url = new URL(String(entrada));
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    const caminho = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ""));
    if (caminho === "/me") return json({ id: "EU" });
    if (caminho === "/me/chats") return json({ value: chats.map((c) => ({ id: c.id, chatType: c.chatType, lastMessagePreview: { createdDateTime: agoraMenos(-1) } })) });
    const chat = chats.find((c) => caminho === `/chats/${c.id}/messages`);
    if (chat) return json({ value: chat.mensagens.map((m) => ({ ...(m as object), chatId: chat.id })) });
    if (caminho === `/teams/${EQUIPE}/channels/${CANAL}/messages`) return json({ value: threads });
    return json({}, 404);
  }) as typeof fetch;
}

const mensagem = (id: string, html: string, sobre: Record<string, unknown> = {}) => ({
  id, createdDateTime: agoraMenos(3), messageType: "message", deletedDateTime: null,
  from: { user: { id: "OUTRA", displayName: "Outra Pessoa" } }, body: { contentType: "html", content: html }, mentions: [],
  webUrl: `https://teams.microsoft.com/l/message/${id}`, ...sobre,
});

function bancoDoTeams() {
  const db = bancoDeTeste();
  const ontem = new Date(Date.now() - 23 * 3600_000).toISOString();
  for (const key of ["inbox", `channel:${EQUIPE}:${CANAL}`]) db.insert(schema.cursors).values({ source: "teams", key, value: ontem }).run();
  return db;
}

const token = async () => "token-de-teste";
const semGithub = { fetchPr: (async (o: string, r: string, p: number) => prDeMentira(o, r, p)) as never, viewerLogin: async () => null };

test("teams-inbox sem prLinks: o evento da mensagem direta e o da mensagem de canal batem com o esquema", async () => {
  const dm = bancoDoTeams();
  await pollTeamsInbox({ mentions: true, dms: true }, { db: dm, token, fetchFn: graphFalso([{ id: "19:um@unq.gbl.spaces", chatType: "oneOnOne", mensagens: [mensagem("1", "<p>oi</p>")] }]) });
  const config = TriggerConfig.parse({ kind: "teams-inbox", mentions: true, dms: true, channels: [], prLinks: false });
  const [direta] = await eventosDe(dm, "teams");
  confere("teams dm", config, direta!);

  const canal = bancoDoTeams();
  const mencao = mensagem("2", "<p>oi</p>", { mentions: [{ mentioned: { user: { id: "EU" } } }] });
  await pollTeamsInbox({ mentions: true, dms: false, channels: [{ teamId: EQUIPE, channelId: CANAL, label: "Time / Geral" }] }, { db: canal, token, fetchFn: graphFalso([], [mencao]) });
  const [doCanal] = await eventosDe(canal, "teams");
  assert.equal(doCanal?.chatType, "channel");
  confere("teams canal", config, doCanal!);
});

test("teams-inbox com prLinks: prOwner, prRepo, prNumber, repo, title, description, diff, url, author e prsTexto", async () => {
  const db = bancoDoTeams();
  await pollTeamsInbox({ mentions: false, dms: false, prLinks: true }, { db, token, ...semGithub, fetchFn: graphFalso([{ id: "g", chatType: "group", mensagens: [mensagem("m1", `<p>${PR}</p>`)] }]) });
  const [evento] = await eventosDe(db, "teams");
  for (const k of ["prOwner", "prRepo", "prNumber", "repo", "title", "description", "diff", "url", "author", "prsTexto"]) assert.ok(k in evento!, k);
  confere("teams com prLinks", TriggerConfig.parse({ kind: "teams-inbox", mentions: false, dms: false, channels: [], prLinks: true }), evento!);
});

test("slack-inbox e slack-channel: o evento emitido bate com o esquema", async () => {
  const db = bancoDeTeste();
  const fetchFn = (async (url: string | URL) => {
    const metodo = String(url).split("/").pop();
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (metodo === "auth.test") return json({ ok: true, user_id: "UEU" });
    return json({ ok: true, results: { messages: [{ message_ts: "1790000000.000100", channel_id: "C1", author_user_id: "UOUTRA", author_name: "Outra", content: "<@UEU> pode olhar?", permalink: "https://x.slack.com/archives/C1/p1790000000000100" }] }, response_metadata: { next_cursor: "" } });
  }) as typeof fetch;
  await pollSlackInbox({ mentions: true, dms: false }, { db, token, fetchFn });
  const [caixa] = await eventosDe(db);
  confere("slack-inbox", TriggerConfig.parse({ kind: "slack-inbox", mentions: true, dms: false }), caixa!);

  const canal = bancoDeTeste();
  const call: McpCaller = async () => [{ ts: "1790917300.000100", text: `veja ${PR}`, user: "U1" }];
  await pollMcpServer({ server: "slack", tool: "history", args: { channel: "C1", oldest: "{{cursor}}" } }, { db: canal, call, shape: slackShape("slack", "C1"), now: () => Date.UTC(2026, 9, 2, 3, 0, 0) });
  const [doCanal] = await eventosDe(canal);
  assert.equal(doCanal?.prOwner, "acme");
  confere("slack-channel", TriggerConfig.parse({ kind: "slack-channel", channels: ["C1"], everyMinutes: 5 }), doCanal!);
});

test("mcp-poll: o evento opaco bate com o esquema", async () => {
  const db = bancoDeTeste();
  const call: McpCaller = async () => [{ id: 1, qualquer: "coisa" }];
  await pollMcpServer({ server: "feed", tool: "lista", args: {} }, { db, call, now: () => Date.UTC(2026, 9, 2, 3, 0, 0) });
  const [evento] = await eventosDe(db);
  confere("mcp-poll", TriggerConfig.parse({ kind: "mcp-poll", server: "feed", tool: "lista", args: {}, everyMinutes: 5 }), evento!);
});

test("poll do GitHub: o contexto do PR bate com o esquema", async () => {
  const cliente = {
    rest: {
      pulls: { get: async () => ({ data: { number: 7, title: "t", body: "d", head: { sha: "cabeca", ref: "fix/x" }, base: { ref: "main" }, user: { login: "autora" }, html_url: "https://example.invalid/pr/7", additions: 1, deletions: 1, draft: false, state: "open", merged: false } }), listFiles: async () => ({}) },
      checks: { listForRef: async () => ({}) },
    },
    paginate: async (rota: unknown) => (rota === cliente.rest.checks.listForRef ? [] : [{ filename: "src/a.cs", status: "modified", additions: 1, deletions: 1, patch: "+x" }]),
  };
  const evento = await fetchPr("o", "r", 7, { client: cliente as unknown as PrClient, diffMaxChars: 100_000 });
  confere("poll", TriggerConfig.parse({ kind: "poll", source: "github", repoMatch: ".*", includeDrafts: false }), evento as never);
});

test("manual: o evento do link colado bate com o esquema", async () => {
  const db = bancoDeTeste();
  const agents = new AgentService(db);
  const eventos = new EventoManual(db, async (o, r, p) => prDeMentira(o, r, p), new ExecutionService(db, agents));
  const { eventId } = await eventos.doLink(PR, "minha-automacao");
  const [linha] = await db.select().from(schema.events).where(eq(schema.events.id, eventId));
  confere("manual", TriggerConfig.parse({ kind: "manual" }), linha!.payload as Record<string, unknown>, ["semConversa", "automacao"]);
});

test("gatilho sem evento com formato diz isso: cron, schedule e webhook não têm esquema", () => {
  for (const config of [{ kind: "cron", expression: "0 9 * * *" }, { kind: "schedule", everyMinutes: 5 }, { kind: "webhook" }]) {
    assert.equal(esquemaDoEvento(config as never), null, config.kind);
  }
});
