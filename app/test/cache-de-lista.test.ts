import { test } from "node:test";
import assert from "node:assert/strict";
import { chaveDaListaDoSlack, chaveDaListaDoTeams, listaComCache, lerDoCache, TTL_DA_LISTA_MS } from "../renderer/lib/cache-de-lista.js";
import type { ArmazemLocal } from "../renderer/lib/rascunho-automacao.js";

/** A lista de canais e chats do Teams é carregada uma vez e guardada por alguns minutos. */

function armazem(): ArmazemLocal {
  const itens = new Map<string, string>();
  return { getItem: (k) => itens.get(k) ?? null, setItem: (k, v) => void itens.set(k, v), removeItem: (k) => void itens.delete(k) };
}

test("dentro do prazo a lista vem do cache, sem carregar de novo", async () => {
  const a = armazem();
  let cargas = 0;
  const carregar = async () => ++cargas;
  assert.equal(await listaComCache(a, "chats", carregar, { agora: () => 1_000 }), 1);
  assert.equal(await listaComCache(a, "chats", carregar, { agora: () => 1_000 + TTL_DA_LISTA_MS - 1 }), 1);
  assert.equal(cargas, 1);
});

test("passado o prazo carrega de novo", async () => {
  const a = armazem();
  let cargas = 0;
  const carregar = async () => ++cargas;
  await listaComCache(a, "chats", carregar, { agora: () => 1_000 });
  assert.equal(await listaComCache(a, "chats", carregar, { agora: () => 1_000 + TTL_DA_LISTA_MS }), 2);
});

test("atualizar ignora o cache e guarda o resultado novo", async () => {
  const a = armazem();
  let cargas = 0;
  const carregar = async () => ++cargas;
  await listaComCache(a, "chats", carregar, { agora: () => 1_000 });
  assert.equal(await listaComCache(a, "chats", carregar, { agora: () => 2_000, forcar: true }), 2);
  assert.equal(lerDoCache(a, "chats", 3_000), 2);
});

test("chaves diferentes não se misturam", async () => {
  const a = armazem();
  await listaComCache(a, "chats:um", async () => "um", { agora: () => 1 });
  assert.equal(lerDoCache(a, "chats:dois", 2), null);
});

test("falha não vai para o cache, e quem espera junto recebe a mesma carga", async () => {
  const a = armazem();
  await assert.rejects(listaComCache(a, "x", async () => { throw new Error("sem rede"); }));
  assert.equal(lerDoCache(a, "x", Date.now()), null);

  let cargas = 0;
  const lenta = () => new Promise<number>((resolve) => setTimeout(() => resolve(++cargas), 10));
  const [p, q] = await Promise.all([listaComCache(a, "y", lenta), listaComCache(a, "y", lenta)]);
  assert.deepEqual([p, q, cargas], [1, 1, 1]);
});

test("as setas andam pela lista e dão a volta", async () => {
  const { moverDestaque } = await import("../renderer/lib/cache-de-lista.js");
  assert.equal(moverDestaque(0, 3, 1), 1);
  assert.equal(moverDestaque(2, 3, 1), 0);
  assert.equal(moverDestaque(0, 3, -1), 2);
  assert.equal(moverDestaque(0, 0, 1), 0);
});

test("a chave da lista leva a conexão e a conta, e trocar de conta não reaproveita a lista da outra", () => {
  const a = chaveDaListaDoTeams("canais", { via: "ms365", account: "ana@x.com" });
  assert.notEqual(a, chaveDaListaDoTeams("canais", { via: "ms365", account: "bia@x.com" }));
  assert.notEqual(a, chaveDaListaDoTeams("canais", { via: "native", account: "ana@x.com" }));
  assert.notEqual(chaveDaListaDoTeams("canais", { via: "ms365" }), chaveDaListaDoTeams("chats", { via: "ms365" }, { id: "g1", agentId: "a", chave: "gatilho-1" }));
});

test("chats de gatilho sem id não compartilham a chave entre automações nem entre gatilhos", () => {
  const conta = { via: "ms365", account: "ana@x.com" };
  const um = chaveDaListaDoTeams("chats", conta, { agentId: "auto-a", chave: "gatilho-1" });
  assert.notEqual(um, chaveDaListaDoTeams("chats", conta, { agentId: "auto-b", chave: "gatilho-1" }));
  assert.notEqual(um, chaveDaListaDoTeams("chats", conta, { agentId: "auto-a", chave: "gatilho-2" }));
  assert.notEqual(um, chaveDaListaDoTeams("chats", conta, { id: "g1", agentId: "auto-a", chave: "gatilho-1" }));
  assert.equal(chaveDaListaDoTeams("chats", conta, { id: "g1", agentId: "auto-a", chave: "gatilho-1" }), chaveDaListaDoTeams("chats", conta, { id: "g1", agentId: "auto-b", chave: "gatilho-9" }));
});

test("a chave da lista do Slack muda com o app (workspace) e com a conexão", () => {
  const a = chaveDaListaDoSlack({ clientId: "1.2", connected: true });
  assert.notEqual(a, chaveDaListaDoSlack({ clientId: "3.4", connected: true }));
  assert.notEqual(a, chaveDaListaDoSlack({ clientId: "1.2", connected: false }));
  assert.equal(a, chaveDaListaDoSlack({ clientId: "1.2", connected: true }));
});
