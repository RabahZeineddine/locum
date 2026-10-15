import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { schema } from "../src/db/index.js";
import { TriggerConfig } from "../src/config/types.js";
import { LIMITE_DO_FILTRO_IA, pollTeamsInbox, type TeamsInboxWatch } from "../src/sources/teams-inbox.js";
import {
  MODELO_PADRAO_API,
  MODELO_PADRAO_ASSINATURA,
  criarJulgador,
  lerVeredito,
  modeloDoFiltro,
  montarPrompt,
  type Julgador,
  type PedidoDoFiltro,
} from "../src/services/filtro-ia.js";
import { bancoDeTeste as bancoVazio } from "./helpers/db.js";

const token = async () => "token-graph";
const GRAPH = "https://graph.test/v1.0";
const agoraMenos = (minutos: number) => new Date(Date.now() - minutos * 60_000).toISOString();
const EQUIPE = "11111111-2222-3333-4444-555555555555";
const CANAL = "19:geral@thread.tacv2";
const CANAIS = [{ teamId: EQUIPE, channelId: CANAL, label: "Time / Geral" }];
const FILTRO = { pergunta: "É um pedido de review de pull request?" };

const link = (n: number) => `https://github.com/acme/api/pull/${n}`;

function mensagem(id: string, minutos: number, html: string, sobre: Record<string, unknown> = {}) {
  return {
    id,
    createdDateTime: agoraMenos(minutos),
    messageType: "message",
    deletedDateTime: null,
    from: { user: { id: "OUTRA", displayName: "Outra Pessoa" } },
    body: { contentType: "html", content: html },
    mentions: [],
    ...sobre,
  };
}

/** Graph de mentira com um canal e as reações que a varredura pediu. */
function graphFalso(threads: unknown[]) {
  const reacoes: string[] = [];
  const fetchFn = (async (entrada: string | URL, init?: RequestInit) => {
    const url = new URL(String(entrada));
    const caminho = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ""));
    const json = (valor: unknown, status = 200) => new Response(JSON.stringify(valor), { status });
    if (init?.method === "POST") {
      reacoes.push(caminho);
      return new Response(null, { status: 204 });
    }
    if (caminho === "/me") return json({ id: "EU" });
    if (caminho === "/me/chats") return json({ value: [] });
    if (caminho === `/teams/${EQUIPE}/channels/${CANAL}/messages`) return json({ value: threads });
    return json({}, 404);
  }) as typeof fetch;
  return { fetchFn, reacoes };
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

/** Banco de quem já varreu ontem: a primeira batida não descarta o que é de hoje. */
function bancoDeTeste() {
  const db = bancoVazio();
  const ontem = new Date(Date.now() - 23 * 3600_000).toISOString();
  for (const key of ["inbox", `channel:${EQUIPE}:${CANAL}`]) {
    db.insert(schema.cursors).values({ source: "teams", key, value: ontem }).run();
  }
  return { db, ontem };
}

const eventos = async (db: ReturnType<typeof bancoDeTeste>["db"]) =>
  (await db.select().from(schema.events).where(eq(schema.events.source, "teams"))).map((e) => e.payload as Record<string, unknown>);

const cursorDoCanal = async (db: ReturnType<typeof bancoDeTeste>["db"]) =>
  (await db.select().from(schema.cursors).where(eq(schema.cursors.key, `channel:${EQUIPE}:${CANAL}`)))[0]?.value;

const watch: TeamsInboxWatch = { mentions: false, dms: false, prLinks: true, channels: CANAIS, filtroIa: FILTRO };

/** Modelo de mentira: decide pelo texto e guarda o que foi perguntado. */
function modeloFalso(decide: (p: PedidoDoFiltro) => boolean | Error) {
  const pedidos: PedidoDoFiltro[] = [];
  const julgar: Julgador = async (pedido) => {
    pedidos.push(pedido);
    const r = decide(pedido);
    if (r instanceof Error) throw r;
    return { passa: r, motivo: r ? "pede review" : "só cita o PR", gasto: { usd: 0.001, tokens: 100 } };
  };
  return { julgar, pedidos };
}

const pedeReview = (p: PedidoDoFiltro) => /review/i.test(p.mensagem.texto);

test("passa: vira evento, ganha 👀 e o custo é contado", async () => {
  const { db } = bancoDeTeste();
  const graph = graphFalso([mensagem("300", 3, `<p>Pessoal, preciso de review: <a href="${link(7)}">PR</a></p>`)]);
  const modelo = modeloFalso(() => true);
  const gastos: unknown[] = [];
  const r = await pollTeamsInbox(watch, {
    db, token, graphUrl: GRAPH, ...semGithub, fetchFn: graph.fetchFn,
    julgar: modelo.julgar,
    gastar: async (g) => void gastos.push(g),
  });
  assert.deepEqual(r.errors, []);
  assert.equal((await eventos(db)).length, 1);
  assert.deepEqual(graph.reacoes, [`/teams/${EQUIPE}/channels/${CANAL}/messages/300/setReaction`]);
  assert.deepEqual(gastos, [{ usd: 0.001, tokens: 100 }]);
  assert.equal(modelo.pedidos[0]?.filtro.pergunta, FILTRO.pergunta);
  assert.equal(modelo.pedidos[0]?.mensagem.autor, "Outra Pessoa");
  assert.match(modelo.pedidos[0]!.mensagem.texto, /preciso de review/);
});

test("não passa: sem evento, sem reação, descarte com o motivo, e o cursor anda", async () => {
  const { db, ontem } = bancoDeTeste();
  const graph = graphFalso([mensagem("300", 3, `<p>já mergeei ${link(1607)}</p>`)]);
  const modelo = modeloFalso(() => false);
  const r = await pollTeamsInbox(watch, { db, token, graphUrl: GRAPH, ...semGithub, fetchFn: graph.fetchFn, julgar: modelo.julgar });
  assert.equal((await eventos(db)).length, 0);
  assert.deepEqual(graph.reacoes, []);
  assert.equal(r.descartes.length, 1);
  assert.match(r.descartes[0]!.motivo, /só cita o PR/);
  assert.match(r.descartes[0]!.pr, /acme\/api#1607/);
  assert.ok((await cursorDoCanal(db))! > ontem);

  // Batida seguinte: a mensagem já foi lida, o modelo não é perguntado de novo.
  await pollTeamsInbox(watch, { db, token, graphUrl: GRAPH, ...semGithub, fetchFn: graph.fetchFn, julgar: modelo.julgar });
  assert.equal(modelo.pedidos.length, 1);
});

test("erro do modelo: falha fechada, o cursor não anda e a próxima batida reavalia", async () => {
  const { db, ontem } = bancoDeTeste();
  const graph = graphFalso([mensagem("300", 3, `<p>review: ${link(7)}</p>`)]);
  const fora = modeloFalso(() => new Error("sem provedor"));
  const r = await pollTeamsInbox(watch, { db, token, graphUrl: GRAPH, ...semGithub, fetchFn: graph.fetchFn, julgar: fora.julgar });
  assert.equal((await eventos(db)).length, 0);
  assert.deepEqual(graph.reacoes, []);
  assert.match(r.errors.map((e) => e.error).join(" "), /sem provedor/);
  assert.equal(await cursorDoCanal(db), ontem);

  const volta = modeloFalso(() => true);
  await pollTeamsInbox(watch, { db, token, graphUrl: GRAPH, ...semGithub, fetchFn: graph.fetchFn, julgar: volta.julgar });
  assert.equal(volta.pedidos.length, 1);
  assert.equal((await eventos(db)).length, 1);
  assert.equal(graph.reacoes.length, 1);
});

test("o cursor para antes da mensagem que não foi avaliada, mas passa pelas anteriores", async () => {
  const { db } = bancoDeTeste();
  const antiga = mensagem("1", 10, `<p>conversa ${link(1)}</p>`);
  const nova = mensagem("2", 5, `<p>review: ${link(2)}</p>`);
  const graph = graphFalso([nova, antiga]);
  // Só a segunda falha.
  const modelo = modeloFalso((p) => (p.mensagem.texto.includes("review") ? new Error("timeout") : false));
  await pollTeamsInbox(watch, { db, token, graphUrl: GRAPH, ...semGithub, fetchFn: graph.fetchFn, julgar: modelo.julgar });
  assert.equal(await cursorDoCanal(db), antiga.createdDateTime);
});

test("sem filtroIa o comportamento é o de hoje e o modelo não é chamado", async () => {
  const { db } = bancoDeTeste();
  const graph = graphFalso([mensagem("300", 3, `<p>já mergeei ${link(1607)}</p>`)]);
  const modelo = modeloFalso(() => false);
  const { filtroIa: _fora, ...semFiltro } = watch;
  await pollTeamsInbox(semFiltro, { db, token, graphUrl: GRAPH, ...semGithub, fetchFn: graph.fetchFn, julgar: modelo.julgar });
  assert.equal(modelo.pedidos.length, 0);
  assert.equal((await eventos(db)).length, 1);
});

test("resposta de thread leva a mensagem raiz no contexto", async () => {
  const { db } = bancoDeTeste();
  const raiz = {
    ...mensagem("300", 6, "<p>Review de PR: alertas</p>"),
    replies: [mensagem("301", 4, `<p>os links: ${link(7)}</p>`)],
  };
  const graph = graphFalso([raiz]);
  const modelo = modeloFalso(() => true);
  await pollTeamsInbox(
    { ...watch, filtroIa: FILTRO },
    { db, token, graphUrl: GRAPH, ...semGithub, fetchFn: graph.fetchFn, julgar: modelo.julgar },
  );
  const daResposta = modelo.pedidos.find((p) => p.mensagem.texto.includes("os links"));
  assert.ok(daResposta);
  assert.equal(daResposta.raiz?.texto, "Review de PR: alertas");
  assert.equal(daResposta.raiz?.autor, "Outra Pessoa");
  // A raiz não tem link: só a resposta é candidata, e a raiz não é perguntada.
  assert.equal(modelo.pedidos.length, 1);
});

test("mensagem com dois links é perguntada uma vez", async () => {
  const { db } = bancoDeTeste();
  const graph = graphFalso([mensagem("300", 3, `<p>review: ${link(7)} e ${link(8)}</p>`)]);
  const modelo = modeloFalso(() => true);
  await pollTeamsInbox(watch, { db, token, graphUrl: GRAPH, ...semGithub, fetchFn: graph.fetchFn, julgar: modelo.julgar });
  assert.equal(modelo.pedidos.length, 1);
  assert.equal((await eventos(db)).length, 2);
});

test("limite por batida: o excedente fica para a próxima, na ordem em que chegou", async () => {
  const { db } = bancoDeTeste();
  const total = LIMITE_DO_FILTRO_IA + 2;
  const threads = Array.from({ length: total }, (_, i) => mensagem(String(100 + i), total - i + 1, `<p>review: ${link(i + 1)}</p>`));
  const graph = graphFalso(threads);
  const modelo = modeloFalso(pedeReview);
  const r = await pollTeamsInbox(watch, { db, token, graphUrl: GRAPH, ...semGithub, fetchFn: graph.fetchFn, julgar: modelo.julgar });
  assert.equal(modelo.pedidos.length, LIMITE_DO_FILTRO_IA);
  assert.equal((await eventos(db)).length, LIMITE_DO_FILTRO_IA);
  assert.match(r.errors.map((e) => e.error).join(" "), /limite/i);

  const segunda = await pollTeamsInbox(watch, { db, token, graphUrl: GRAPH, ...semGithub, fetchFn: graph.fetchFn, julgar: modelo.julgar });
  assert.deepEqual(segunda.errors, []);
  assert.equal(modelo.pedidos.length, total);
  assert.equal((await eventos(db)).length, total);
});

test("o gasto do modelo também conta quando a mensagem não passa", async () => {
  const { db } = bancoDeTeste();
  const graph = graphFalso([mensagem("300", 3, `<p>já mergeei ${link(1607)}</p>`)]);
  const gastos: unknown[] = [];
  await pollTeamsInbox(watch, {
    db, token, graphUrl: GRAPH, ...semGithub, fetchFn: graph.fetchFn,
    julgar: modeloFalso(() => false).julgar,
    gastar: async (g) => void gastos.push(g),
  });
  assert.equal(gastos.length, 1);
});

test("o gatilho aceita filtroIa, e o antigo segue igual", () => {
  const antigo = TriggerConfig.parse({ kind: "teams-inbox" });
  assert.equal(antigo.kind === "teams-inbox" && antigo.filtroIa, undefined);
  const novo = TriggerConfig.parse({ kind: "teams-inbox", filtroIa: { pergunta: "é review?", modelo: "claude-code/haiku" } });
  assert.deepEqual(novo.kind === "teams-inbox" && novo.filtroIa, { pergunta: "é review?", modelo: "claude-code/haiku" });
  assert.throws(() => TriggerConfig.parse({ kind: "teams-inbox", filtroIa: { pergunta: "  " } }));
});

/* ---------------------------------------------------------------- o julgador */

test("o modelo padrão é o alias do Haiku do provedor que existe", () => {
  assert.equal(modeloDoFiltro(FILTRO, () => true), MODELO_PADRAO_ASSINATURA);
  assert.equal(modeloDoFiltro(FILTRO, (p) => p === "anthropic"), MODELO_PADRAO_API);
  assert.throws(() => modeloDoFiltro(FILTRO, () => false), /sem provedor/);
  assert.equal(modeloDoFiltro({ ...FILTRO, modelo: "codex/default" }, () => true), "codex/default");
  assert.throws(() => modeloDoFiltro({ ...FILTRO, modelo: "openai/x" }, (p) => p === "anthropic"), /indisponível/);
});

test("o prompt traz pergunta, mensagem e a raiz da thread, e a resposta ilegível é erro", () => {
  const prompt = montarPrompt({ filtro: FILTRO, mensagem: { autor: "Ana", texto: "os links" }, raiz: { autor: "Rui", texto: "Review de PR" } });
  assert.match(prompt, /pedido de review/);
  assert.match(prompt, /Rui[\s\S]*Review de PR/);
  assert.match(prompt, /Ana[\s\S]*os links/);
  assert.deepEqual(lerVeredito({ passa: true, motivo: "ok" }, ""), { passa: true, motivo: "ok" });
  assert.deepEqual(lerVeredito(undefined, 'Claro: {"passa": false, "motivo": "cita"}'), { passa: false, motivo: "cita" });
  assert.throws(() => lerVeredito(undefined, "talvez"), /passa\/motivo/);
});

test("o julgador usa o runtime do provedor e soma os tokens do gasto", async () => {
  const chamadas: { provider: string; model: string; temOutputSchema: boolean }[] = [];
  const julgar = criarJulgador({
    disponivel: () => true,
    runtime: () => ({
      id: "falso",
      run: async (req) => {
        chamadas.push({ provider: req.provider, model: req.model, temOutputSchema: req.outputSchema !== undefined });
        return { text: "", structured: { passa: true, motivo: "ok" }, promptTokens: 30, completionTokens: 5, costUsd: 0.0002, billable: false, toolsUsed: [] };
      },
    }),
  });
  const v = await julgar({ filtro: FILTRO, mensagem: { autor: null, texto: "x" } });
  assert.deepEqual(chamadas, [{ provider: "claude-code", model: "haiku", temOutputSchema: true }]);
  assert.deepEqual(v, { passa: true, motivo: "ok", gasto: { usd: 0.0002, tokens: 35 } });
});

test("o julgador estoura no prazo", async () => {
  const julgar = criarJulgador({
    disponivel: () => true,
    prazoMs: 10,
    runtime: () => ({ id: "lento", run: () => new Promise(() => undefined) }),
  });
  await assert.rejects(julgar({ filtro: FILTRO, mensagem: { autor: null, texto: "x" } }), /não respondeu/);
});
