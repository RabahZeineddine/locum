import { test } from "node:test";
import assert from "node:assert/strict";
import { schema } from "../src/db/index.js";
import { buildDigestEvent, collectSlackDigest, markDelivered } from "../src/digest/ingest.js";
import { slackSource } from "../src/sources/slack.js";
import { bancoDeTeste } from "./helpers/db.js";

type Mensagem = { channel: string; ts: string; text?: string; threadTs?: string; author?: string; subtype?: string };

/** Grava mensagens como a fonte do Slack grava, na ordem dada. */
async function gravar(db: ReturnType<typeof bancoDeTeste>, mensagens: Mensagem[]) {
  for (const [i, m] of mensagens.entries()) {
    await db.insert(schema.events).values({
      id: `ev-${m.channel}-${m.ts}`,
      source: slackSource("slack"),
      externalId: `slack:${m.channel}:${m.ts}`,
      payload: {
        channel: m.channel,
        ts: m.ts,
        text: m.text ?? `mensagem ${m.ts}`,
        threadTs: m.threadTs ?? m.ts,
        reply: m.threadTs !== undefined && m.threadTs !== m.ts,
        author: m.author ?? "pessoa",
        permalink: `https://slack.invalid/${m.channel}/${m.ts}`,
        item: m.subtype ? { subtype: m.subtype } : {},
      },
      receivedAt: 1_000 + i,
    });
  }
}

test("agrupa por canal e por thread, descarta ruído e entrega cada mensagem uma vez só", async () => {
  const db = bancoDeTeste();
  await gravar(db, [
    { channel: "C2", ts: "100.1", text: "deploy quebrou   na\nprodução" },
    { channel: "C2", ts: "101.1", threadTs: "100.1", text: "olhando" },
    { channel: "C1", ts: "102.1", subtype: "channel_join", text: "entrou no canal" },
    { channel: "C1", ts: "103.1", text: "  " },
    { channel: "C1", ts: "104.1", text: "alguém revisa?" },
  ]);

  const primeiro = await collectSlackDigest("slack", { db });
  assert.equal(primeiro.since, "0");
  assert.equal(primeiro.until, "104.1");
  assert.equal(primeiro.messages, 3);
  assert.equal(primeiro.dropped, 2);
  assert.deepEqual(primeiro.channels.map((c) => c.channel), ["C1", "C2"]);
  const thread = primeiro.channels[1]?.threads[0];
  assert.equal(thread?.subject, "deploy quebrou na produção");
  assert.deepEqual(thread?.messages.map((m) => [m.ts, m.reply]), [["100.1", false], ["101.1", true]]);

  const id = await buildDigestEvent(primeiro, { db });
  assert.ok(id);

  // A entrega seguinte só vê o que chegou depois, mesmo com a abertura da thread já entregue.
  await gravar(db, [{ channel: "C2", ts: "105.1", threadTs: "100.1", text: "resolvido" }]);
  const segundo = await collectSlackDigest("slack", { db });
  assert.equal(segundo.since, "104.1");
  assert.equal(segundo.messages, 1);
  assert.equal(segundo.channels[0]?.threads[0]?.subject, "resolvido");
});

test("sem nada novo não há evento, e o cursor da entrega nunca anda para trás", async () => {
  const db = bancoDeTeste();
  const vazio = await collectSlackDigest("slack", { db });
  assert.equal(await buildDigestEvent(vazio, { db }), null);

  assert.equal(await markDelivered("slack", "200.5", { db }), "200.5");
  assert.equal(await markDelivered("slack", "150.0", { db }), "200.5");
  // Carimbo do Slack compara como número: "1000.0" é mais novo que "999.9".
  assert.equal(await markDelivered("slack", "1000.0", { db }), "1000.0");
});

test("canal com thread demais e thread com mensagem demais cortam e contam o que sobrou", async () => {
  const db = bancoDeTeste();
  const mensagens: Mensagem[] = [];
  for (let t = 0; t < 12; t++) mensagens.push({ channel: "C1", ts: `${300 + t}.0` });
  for (let r = 1; r <= 8; r++) mensagens.push({ channel: "C1", ts: `311.${r}`, threadTs: "311.0" });
  await gravar(db, mensagens);

  const digest = await collectSlackDigest("slack", { db });
  const canal = digest.channels[0];
  assert.equal(canal?.threads.length, 10);
  assert.equal(canal?.more, 2);
  // A mais nova primeiro.
  assert.equal(canal?.threads[0]?.threadTs, "311.0");
  assert.equal(canal?.threads[0]?.messages.length, 6);
  assert.equal(canal?.threads[0]?.more, 3);
});
