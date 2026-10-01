import { test } from "node:test";
import assert from "node:assert/strict";
import { schema } from "../src/db/index.js";
import { normalizeInbox, pollSlackInbox } from "../src/sources/slack-inbox.js";
import { bancoDeTeste } from "./helpers/db.js";

type Mensagem = {
  message_ts: string;
  channel_id: string;
  author_user_id?: string;
  author_name?: string;
  is_author_bot?: boolean;
  permalink?: string;
  content?: string;
};

/**
 * Uma API do Slack de mentira.
 *
 * Responde `auth.test` com a pessoa `UEU` e a busca com o que estiver na lista
 * da pergunta, em páginas de `porPagina`. Cada chamada fica anotada com o corpo
 * que chegou, para o teste conferir token, consulta e cursor.
 */
function slackFalso(porConsulta: Record<string, Mensagem[]>, opcoes: { porPagina?: number; recusa?: string } = {}) {
  const chamadas: { method: string; corpo: URLSearchParams; auth: string | null }[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const corpo = new URLSearchParams(init?.body as URLSearchParams);
    chamadas.push({ method, corpo, auth: new Headers(init?.headers).get("authorization") });
    const json = (valor: unknown) => new Response(JSON.stringify(valor), { status: 200 });

    if (method === "auth.test") return json({ ok: true, user_id: "UEU" });
    if (opcoes.recusa !== undefined) return json({ ok: false, error: opcoes.recusa });

    const lista = porConsulta[corpo.get("query") ?? ""] ?? [];
    const porPagina = opcoes.porPagina ?? 20;
    const inicio = Number(corpo.get("cursor") ?? "0");
    const pagina = lista.slice(inicio, inicio + porPagina);
    const proximo = inicio + porPagina < lista.length ? String(inicio + porPagina) : "";
    return json({ ok: true, results: { messages: pagina }, response_metadata: { next_cursor: proximo } });
  }) as typeof fetch;
  return { fetchFn, chamadas };
}

const token = async () => "xoxp-teste";

test("menção vira evento normalizado, com a thread tirada do permalink", async () => {
  const db = bancoDeTeste();
  const { fetchFn, chamadas } = slackFalso({
    "<@UEU>": [
      {
        message_ts: "1790000000.000100",
        channel_id: "C1",
        author_user_id: "UOUTRA",
        author_name: "Outra",
        content: "<@UEU> pode olhar?",
        permalink: "https://x.slack.com/archives/C1/p1790000000000100?thread_ts=1789999999.000001&cid=C1",
      },
    ],
  });

  const resultado = await pollSlackInbox({ mentions: true, dms: false }, { db, token, fetchFn });

  assert.equal(resultado.eventIds.length, 1);
  assert.deepEqual(resultado.errors, []);
  assert.equal(chamadas[0]!.auth, "Bearer xoxp-teste");
  const busca = chamadas.find((c) => c.method === "assistant.search.context")!;
  assert.equal(busca.corpo.get("channel_types"), "public_channel,private_channel,mpim,im");
  assert.equal(busca.corpo.get("sort"), "timestamp");

  const [evento] = await db.select().from(schema.events);
  const corpo = evento!.payload as Record<string, unknown>;
  assert.equal(evento!.source, "slack:slack");
  assert.equal(evento!.externalId, "slack:C1:1790000000.000100");
  assert.equal(corpo.server, "slack");
  assert.equal(corpo.kind, "mention");
  assert.equal(corpo.channel, "C1");
  assert.equal(corpo.author, "Outra");
  assert.equal(corpo.threadTs, "1789999999.000001");
  assert.equal(corpo.reply, true);
});

test("a batida seguinte manda o cursor em segundos e não repete o que já viu", async () => {
  const db = bancoDeTeste();
  const agora = Math.floor(Date.now() / 1000);
  const mensagem = { message_ts: `${agora}.000100`, channel_id: "D1", author_user_id: "UOUTRA", content: "oi" };
  const { fetchFn, chamadas } = slackFalso({ "to:<@UEU>": [mensagem] });

  await pollSlackInbox({ mentions: false, dms: true }, { db, token, fetchFn });
  const segunda = await pollSlackInbox({ mentions: false, dms: true }, { db, token, fetchFn });

  assert.equal(segunda.eventIds.length, 0);
  assert.equal(segunda.seen, 1);
  const buscas = chamadas.filter((c) => c.method === "assistant.search.context");
  assert.equal(buscas.at(-1)!.corpo.get("after"), String(agora));
  assert.equal(buscas.at(-1)!.corpo.get("channel_types"), "im,mpim");
});

test("mensagem da própria pessoa e de bot ficam de fora", async () => {
  const db = bancoDeTeste();
  const { fetchFn } = slackFalso({
    "to:<@UEU>": [
      { message_ts: "1790000000.000001", channel_id: "D1", author_user_id: "UEU", content: "minha" },
      { message_ts: "1790000000.000002", channel_id: "D1", author_user_id: "B1", is_author_bot: true },
      { message_ts: "1790000000.000003", channel_id: "D1", author_user_id: "UOUTRA", content: "dela" },
    ],
  });

  const resultado = await pollSlackInbox({ mentions: false, dms: true }, { db, token, fetchFn });

  assert.equal(resultado.eventIds.length, 1);
  const [evento] = await db.select().from(schema.events);
  assert.equal((evento!.payload as { text: string }).text, "dela");
});

test("a busca segue as páginas, e menção em DM não vira dois eventos", async () => {
  const db = bancoDeTeste();
  const muitas = Array.from({ length: 5 }, (_, i) => ({
    message_ts: `179000000${i}.000000`,
    channel_id: "D1",
    author_user_id: "UOUTRA",
  }));
  const { fetchFn } = slackFalso({ "<@UEU>": muitas, "to:<@UEU>": muitas }, { porPagina: 2 });

  const resultado = await pollSlackInbox({ mentions: true, dms: true }, { db, token, fetchFn });

  assert.equal(resultado.eventIds.length, 5);
  assert.equal(resultado.seen, 10);
});

test("recusa do Slack vira erro da pergunta, sem mover o cursor", async () => {
  const db = bancoDeTeste();
  const { fetchFn } = slackFalso({}, { recusa: "missing_scope" });

  const resultado = await pollSlackInbox({ mentions: true, dms: false }, { db, token, fetchFn });

  assert.deepEqual(resultado.errors, [{ kind: "mention", error: "Slack recusou assistant.search.context: missing_scope" }]);
  assert.equal((await db.select().from(schema.cursors)).length, 0);
});

test("sem conexão, a varredura recusa antes de chamar o Slack", async () => {
  const { fetchFn, chamadas } = slackFalso({});
  await assert.rejects(
    pollSlackInbox({ mentions: true, dms: true }, { db: bancoDeTeste(), token: async () => null, fetchFn }),
    /não está conectado/,
  );
  assert.equal(chamadas.length, 0);
});

test("mensagem sem thread no permalink abre a própria thread", () => {
  const mensagem = normalizeInbox({ message_ts: "1.2", channel_id: "C1", permalink: "https://x/p12" }, "mention");
  assert.equal(mensagem.threadTs, "1.2");
  assert.equal(mensagem.reply, false);
});
