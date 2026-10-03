import { test } from "node:test";
import assert from "node:assert/strict";
import { schema } from "../src/db/index.js";
import { chatOf, teamsPostHandler } from "../src/teams/action.js";
import { bancoDeTeste } from "./helpers/db.js";

/** Um evento como a caixa do Teams grava, só com o que a resposta lê. */
async function lido(db: ReturnType<typeof bancoDeTeste>, chatId: string) {
  await db.insert(schema.events).values({
    id: `ev-${chatId}`,
    source: "teams",
    externalId: `teams:${chatId}:1`,
    payload: {
      repo: `teams/${chatId}`,
      chatId,
      text: "pode olhar o PR?",
      author: "Outra Pessoa",
      webUrl: "https://teams.microsoft.com/l/message/1",
    },
  });
}

test("resposta a conversa lida vira pendência com a mensagem a que responde", async () => {
  const db = bancoDeTeste();
  await lido(db, "19:dm");
  const handler = teamsPostHandler({ db, token: async () => "t" });

  const proposta = await handler.propose!({ repo: "teams/19:dm", text: "  olho já  " }, null);

  assert.deepEqual(handler.modes, ["approve", "auto"]);
  assert.deepEqual(proposta, {
    chatId: "19:dm",
    text: "olho já",
    subject: "pode olhar o PR?",
    author: "Outra Pessoa",
    webUrl: "https://teams.microsoft.com/l/message/1",
  });
});

test("conversa que o Locum nunca leu é recusada antes de virar pendência", async () => {
  const handler = teamsPostHandler({ db: bancoDeTeste(), token: async () => "t" });
  await assert.rejects(handler.propose!({ repo: "teams/19:outra", text: "oi" }, null), /nao aparece/);
});

test("saída sem texto ou sem conversa é recusada", async () => {
  const db = bancoDeTeste();
  await lido(db, "19:dm");
  const handler = teamsPostHandler({ db, token: async () => "t" });
  await assert.rejects(handler.propose!({ repo: "teams/19:dm", text: "  " }, null), /nao escreveu/);
  assert.throws(() => chatOf({ repo: "slack/C1" }), /evento de conversa/);
});

test("publicar manda texto puro para a conversa, com o token da pessoa", async () => {
  const pedidos: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    pedidos.push({ url, init });
    return new Response("{}", { status: 201 });
  }) as unknown as typeof fetch;
  const handler = teamsPostHandler({ db: bancoDeTeste(), token: async () => "t", fetchFn, graphUrl: "https://graph.test" });

  await handler.publish({ chatId: "19:dm", text: "olho já", subject: "x", author: null, webUrl: null }, "id");

  assert.equal(pedidos[0]!.url, "https://graph.test/chats/19%3Adm/messages");
  assert.equal(pedidos[0]!.init.method, "POST");
  assert.equal(new Headers(pedidos[0]!.init.headers).get("authorization"), "Bearer t");
  assert.deepEqual(JSON.parse(String(pedidos[0]!.init.body)), { body: { contentType: "text", content: "olho já" } });
});

test("recusa do Graph estoura, para a pendência não fechar", async () => {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ error: { code: "Forbidden" } }), { status: 403 })) as unknown as typeof fetch;
  const handler = teamsPostHandler({ db: bancoDeTeste(), token: async () => "t", fetchFn });
  const proposta = { chatId: "19:dm", text: "oi", subject: "x", author: null, webUrl: null };

  await assert.rejects(handler.publish(proposta, "id"), /Graph recusou a mensagem com 403: Forbidden/);
  await assert.rejects(teamsPostHandler({ token: async () => null }).publish(proposta, "id"), /não está conectado/);
});
