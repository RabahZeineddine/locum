import { test } from "node:test";
import assert from "node:assert/strict";
import { listSlackChannels } from "../src/slack/channels.js";

const token = async () => "token-slack";

function slackFalso(paginas: unknown[], recusa?: string) {
  const pedidos: { metodo: string; corpo: URLSearchParams; auth: string | null }[] = [];
  const fetchFn = (async (entrada: string | URL, init?: RequestInit) => {
    const url = new URL(String(entrada));
    const corpo = new URLSearchParams(String(init?.body ?? ""));
    pedidos.push({ metodo: url.pathname.replace("/api/", ""), corpo, auth: new Headers(init?.headers).get("authorization") });
    if (recusa !== undefined) return new Response(JSON.stringify({ ok: false, error: recusa }));
    const pagina = paginas[pedidos.length - 1] as Record<string, unknown>;
    return new Response(JSON.stringify({ ok: true, ...pagina }));
  }) as typeof fetch;
  return { fetchFn, pedidos };
}

test("segue as páginas e devolve nome, id e se é privado, em ordem alfabética", async () => {
  const { fetchFn, pedidos } = slackFalso([
    { channels: [{ id: "C2", name: "zeta" }, { id: "G1", name: "segredo", is_private: true }], response_metadata: { next_cursor: "p2" } },
    { channels: [{ id: "C1", name: "alfa", is_private: false }], response_metadata: { next_cursor: "" } },
  ]);
  const canais = await listSlackChannels({ token, fetchFn });
  assert.deepEqual(canais, [
    { id: "C1", name: "alfa", isPrivate: false },
    { id: "G1", name: "segredo", isPrivate: true },
    { id: "C2", name: "zeta", isPrivate: false },
  ]);
  assert.equal(pedidos.length, 2);
  assert.equal(pedidos[0]!.metodo, "users.conversations");
  assert.equal(pedidos[0]!.corpo.get("types"), "public_channel,private_channel");
  assert.equal(pedidos[0]!.corpo.get("exclude_archived"), "true");
  assert.equal(pedidos[0]!.corpo.get("cursor"), null);
  assert.equal(pedidos[1]!.corpo.get("cursor"), "p2");
  assert.equal(pedidos[0]!.auth, "Bearer token-slack");
});

test("ignora item sem id ou nome", async () => {
  const { fetchFn } = slackFalso([{ channels: [{ id: "C1" }, { name: "x" }, { id: "C2", name: "ok" }] }]);
  assert.deepEqual(await listSlackChannels({ token, fetchFn }), [{ id: "C2", name: "ok", isPrivate: false }]);
});

test("sem conexão diz para conectar em Conexões", async () => {
  const { fetchFn } = slackFalso([]);
  await assert.rejects(listSlackChannels({ token: async () => null, fetchFn }), /Slack não está conectado/);
});

test("escopo faltando vira instrução para conectar de novo", async () => {
  const { fetchFn } = slackFalso([], "missing_scope");
  await assert.rejects(listSlackChannels({ token, fetchFn }), /escopos de canal.*conecte de novo/);
});

test("outra recusa do Slack traz o motivo", async () => {
  const { fetchFn } = slackFalso([], "ratelimited");
  await assert.rejects(listSlackChannels({ token, fetchFn }), /ratelimited/);
});
