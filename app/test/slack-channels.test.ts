import { test } from "node:test";
import assert from "node:assert/strict";
import { codigoDoErroDeCanais, listSlackChannels, SlackChannelsError, type ListSlackChannelsOptions } from "../src/slack/channels.js";

const oficial: ListSlackChannelsOptions = {
  token: async () => "token-slack",
  origem: async () => "slack",
  temGrant: () => true,
};

type Resposta = Record<string, unknown>;

/** Slack de mentira: cada método tem a sua fila de respostas. */
function slackFalso(respostas: Record<string, Resposta[]>) {
  const pedidos: { metodo: string; corpo: URLSearchParams; auth: string | null }[] = [];
  const fetchFn = (async (entrada: string | URL, init?: RequestInit) => {
    const metodo = new URL(String(entrada)).pathname.replace("/api/", "");
    pedidos.push({ metodo, corpo: new URLSearchParams(String(init?.body ?? "")), auth: new Headers(init?.headers).get("authorization") });
    const fila = respostas[metodo] ?? [];
    const vez = pedidos.filter((p) => p.metodo === metodo).length - 1;
    return new Response(JSON.stringify(fila[Math.min(vez, fila.length - 1)] ?? { ok: false, error: "sem_resposta" }));
  }) as typeof fetch;
  return { fetchFn, pedidos };
}

test("segue as páginas e devolve nome, id e se é privado, em ordem alfabética", async () => {
  const { fetchFn, pedidos } = slackFalso({
    "users.conversations": [
      { ok: true, channels: [{ id: "C2", name: "zeta" }, { id: "G1", name: "segredo", is_private: true }], response_metadata: { next_cursor: "p2" } },
      { ok: true, channels: [{ id: "C1", name: "alfa", is_private: false }], response_metadata: { next_cursor: "" } },
    ],
  });
  const lista = await listSlackChannels({ ...oficial, fetchFn });
  assert.deepEqual(lista.canais, [
    { id: "C1", name: "alfa", isPrivate: false },
    { id: "G1", name: "segredo", isPrivate: true },
    { id: "C2", name: "zeta", isPrivate: false },
  ]);
  assert.equal(lista.truncado, false);
  assert.equal(pedidos.length, 2);
  assert.equal(pedidos[0]!.corpo.get("types"), "public_channel,private_channel");
  assert.equal(pedidos[0]!.corpo.get("exclude_archived"), "true");
  assert.equal(pedidos[0]!.corpo.get("cursor"), null);
  assert.equal(pedidos[1]!.corpo.get("cursor"), "p2");
  assert.equal(pedidos[0]!.auth, "Bearer token-slack");
});

test("parar no teto de páginas marca a lista como truncada", async () => {
  const { fetchFn, pedidos } = slackFalso({
    "users.conversations": [{ ok: true, channels: [{ id: "C1", name: "a" }], response_metadata: { next_cursor: "mais" } }],
  });
  const lista = await listSlackChannels({ ...oficial, fetchFn, tetoDePaginas: 3 });
  assert.equal(lista.truncado, true);
  assert.equal(lista.total, 3);
  assert.equal(pedidos.length, 3);
});

test("ignora item sem id ou nome", async () => {
  const { fetchFn } = slackFalso({ "users.conversations": [{ ok: true, channels: [{ id: "C1" }, { name: "x" }, { id: "C2", name: "ok" }] }] });
  assert.deepEqual((await listSlackChannels({ ...oficial, fetchFn })).canais, [{ id: "C2", name: "ok", isPrivate: false }]);
});

test("canal escolhido que a lista não trouxe é consultado: arquivado, existente fora da lista e inexistente", async () => {
  const { fetchFn, pedidos } = slackFalso({
    "users.conversations": [{ ok: true, channels: [{ id: "C1", name: "alfa" }] }],
    "conversations.info": [
      { ok: true, channel: { id: "C2", name: "velho", is_archived: true } },
      { ok: true, channel: { id: "C3", name: "aberto", is_archived: false } },
      { ok: false, error: "channel_not_found" },
    ],
  });
  const lista = await listSlackChannels({ ...oficial, fetchFn, ids: ["C1", "C2", "C3", "C4"] });
  assert.deepEqual(lista.arquivados, [{ id: "C2", name: "velho", isPrivate: false }]);
  assert.deepEqual(lista.canais.map((c) => c.id), ["C3", "C1"]);
  assert.deepEqual(lista.naoEncontrados, ["C4"]);
  assert.deepEqual(pedidos.filter((p) => p.metodo === "conversations.info").map((p) => p.corpo.get("channel")), ["C2", "C3", "C4"]);
});

test("sem token a conexão não existe, e o código vai na mensagem", async () => {
  const { fetchFn } = slackFalso({});
  await assert.rejects(
    listSlackChannels({ ...oficial, token: async () => null, fetchFn }),
    (e: unknown) => e instanceof SlackChannelsError && e.code === "sem-conexao" && codigoDoErroDeCanais((e as Error).message) === "sem-conexao",
  );
});

test("escopo faltando é sem-escopo", async () => {
  const { fetchFn } = slackFalso({ "users.conversations": [{ ok: false, error: "missing_scope" }] });
  await assert.rejects(listSlackChannels({ ...oficial, fetchFn }), (e: unknown) => (e as SlackChannelsError).code === "sem-escopo");
});

test("origem que não é o servidor oficial nunca usa token nenhum", async () => {
  const { fetchFn, pedidos } = slackFalso({});
  let leuToken = false;
  await assert.rejects(
    listSlackChannels({ ...oficial, origem: async () => "slack-importado", token: async () => ((leuToken = true), "xoxb-de-bot"), fetchFn }),
    (e: unknown) => (e as SlackChannelsError).code === "outro-servidor",
  );
  assert.equal(leuToken, false);
  assert.equal(pedidos.length, 0);
});

test("token sem grant de OAuth também é outro-servidor", async () => {
  const { fetchFn, pedidos } = slackFalso({});
  await assert.rejects(listSlackChannels({ ...oficial, temGrant: () => false, fetchFn }), (e: unknown) => (e as SlackChannelsError).code === "outro-servidor");
  assert.equal(pedidos.length, 0);
});

test("outra recusa do Slack traz o motivo", async () => {
  const { fetchFn } = slackFalso({ "users.conversations": [{ ok: false, error: "ratelimited" }] });
  await assert.rejects(listSlackChannels({ ...oficial, fetchFn }), /ratelimited/);
});
