import { test } from "node:test";
import assert from "node:assert/strict";
import { schema } from "../src/db/index.js";
import type { SlackWatch } from "../src/services/slack-service.js";
import { postSlackReply } from "../src/slack/post.js";
import { findThread } from "../src/slack/thread.js";
import { slackSource } from "../src/sources/slack.js";
import type { McpCaller } from "../src/sources/mcp-poll.js";
import { bancoDeTeste } from "./helpers/db.js";

const watch: SlackWatch = {
  server: "slack",
  tool: "conversations_history",
  channelArg: "channel_id",
  sinceArg: "oldest",
  limit: 50,
  postTool: "conversations_add_message",
  postChannelArg: "channel_id",
  textArg: "payload",
  threadArg: "thread_ts",
  channels: ["C1"],
};
const proposta = { server: "slack", channel: "C1", threadTs: "100.1", text: "resposta", subject: "", permalink: null };

test("resposta publicada usa os nomes de argumento do cadastro", async () => {
  const chamadas: unknown[] = [];
  const call: McpCaller = async (server, tool, args) => {
    chamadas.push([server, tool, args]);
    return { content: [{ type: "text", text: '{"ok": true, "ts": "101.1"}' }] };
  };
  await postSlackReply(proposta, watch, { call });
  assert.deepEqual(chamadas, [
    ["slack", "conversations_add_message", { channel_id: "C1", thread_ts: "100.1", payload: "resposta" }],
  ]);
});

test("recusa do Slack sem isError não passa por publicada", async () => {
  const call: McpCaller = async () => ({ content: [{ type: "text", text: '{"ok": false, "error": "not_in_channel"}' }] });
  await assert.rejects(postSlackReply(proposta, watch, { call }), /not_in_channel/);

  const comErro: McpCaller = async () => ({ isError: true, content: [{ type: "text", text: "sem permissão" }] });
  await assert.rejects(postSlackReply(proposta, watch, { call: comErro }), /sem permissão/);
});

test("thread é achada pela abertura, ou pela resposta quando a abertura não foi lida", async () => {
  const db = bancoDeTeste();
  const gravar = (id: string, payload: object, receivedAt: number) =>
    db.insert(schema.events).values({ id, source: slackSource("slack"), externalId: id, payload, receivedAt });
  await gravar("abre", { channel: "C1", ts: "100.1", text: "assunto", permalink: "https://x/100" }, 1);
  await gravar("responde", { channel: "C1", ts: "101.1", threadTs: "100.1", text: "resposta" }, 2);
  await gravar("orfa", { channel: "C1", ts: "201.1", threadTs: "200.1", text: "sem abertura" }, 3);
  await gravar("outro-canal", { channel: "C2", ts: "100.1", text: "outro" }, 4);

  assert.deepEqual(await findThread("slack", "C1", "100.1", { db }), {
    channel: "C1",
    threadTs: "100.1",
    subject: "assunto",
    permalink: "https://x/100",
  });
  assert.equal((await findThread("slack", "C1", "200.1", { db }))?.subject, "sem abertura");
  assert.equal(await findThread("slack", "C1", "999.9", { db }), null);
});
