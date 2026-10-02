import { test } from "node:test";
import assert from "node:assert/strict";
import { schema } from "../src/db/index.js";
import { pollMcpServer, type McpCaller } from "../src/sources/mcp-poll.js";
import { slackCursorKey, slackShape, slackSource } from "../src/sources/slack.js";
import { bancoDeTeste } from "./helpers/db.js";

/** Um servidor que responde, em ordem, as páginas dadas, e anota o que recebeu. */
function servidor(respostas: unknown[]) {
  const pedidos: Record<string, unknown>[] = [];
  const call: McpCaller = async (_server, _tool, args) => {
    pedidos.push(args);
    return respostas.shift() ?? [];
  };
  return { call, pedidos };
}

test("canal quieto deixa o cursor em segundos, e a mensagem seguinte ainda move o cursor", async () => {
  const db = bancoDeTeste();
  const agora = Date.UTC(2026, 9, 2, 3, 0, 0);
  const { call, pedidos } = servidor([[], [{ ts: "1790917300.000100", text: "oi", user: "U1" }], []]);
  const input = { server: "slack", tool: "history", args: { channel: "C1", oldest: "{{cursor}}" } };
  const opcoes = { db, call, shape: slackShape("slack", "C1"), now: () => agora };

  const quieto = await pollMcpServer(input, opcoes);
  assert.equal(quieto.cursor, String(agora / 1000));

  const comMensagem = await pollMcpServer(input, opcoes);
  assert.equal(pedidos[1]?.oldest, String(agora / 1000));
  assert.equal(comMensagem.eventIds.length, 1);
  assert.equal(comMensagem.cursor, "1790917300.000100");

  await pollMcpServer(input, opcoes);
  assert.equal(pedidos[2]?.oldest, "1790917300.000100");
});

test("feed opaco sem carimbo usa o instante da chamada em ISO, e item repetido não vira evento", async () => {
  const db = bancoDeTeste();
  const agora = Date.UTC(2026, 9, 2, 3, 0, 0);
  const { call, pedidos } = servidor([[{ id: 1 }, { id: 2 }], { items: [{ id: 2 }, { id: 3 }] }]);
  const input = { server: "feed", tool: "list", args: { since: "desde {{cursor}}" } };

  const primeira = await pollMcpServer(input, { db, call, now: () => agora });
  assert.equal(pedidos[0]?.since, "desde 1970-01-01T00:00:00.000Z");
  assert.equal(primeira.eventIds.length, 2);
  assert.equal(primeira.cursor, new Date(agora).toISOString());

  const segunda = await pollMcpServer(input, { db, call, now: () => agora });
  assert.equal(pedidos[1]?.since, `desde ${new Date(agora).toISOString()}`);
  assert.equal(segunda.seen, 2);
  assert.equal(segunda.eventIds.length, 1);
  // O item repetido não vira evento, mas continua na janela: o gatilho que
  // ainda não o rodou precisa recebê-lo.
  assert.equal(segunda.inWindow.length, 2);
  assert.equal(segunda.inWindow[0], primeira.eventIds[1]);
  assert.equal(segunda.inWindow[1], segunda.eventIds[0]);
});

test("resposta com isError vira falha e não move o cursor", async () => {
  const db = bancoDeTeste();
  const input = { server: "feed", tool: "list", args: { since: "{{cursor}}" } };
  const call: McpCaller = async () => ({ isError: true, content: [{ type: "text", text: "token expirado" }] });
  await assert.rejects(pollMcpServer(input, { db, call }), /token expirado/);

  const { call: ok, pedidos } = servidor([[]]);
  await pollMcpServer(input, { db, call: ok });
  assert.equal(pedidos[0]?.since, "1970-01-01T00:00:00.000Z");
});

test("cursor de Slack preso em ISO por versão antiga volta a segundos na leitura", async () => {
  const db = bancoDeTeste();
  await db.insert(schema.cursors).values({
    source: slackSource("slack"),
    key: slackCursorKey("C1"),
    value: "2026-10-01T12:00:00.000Z",
  });
  const { call, pedidos } = servidor([[]]);
  await pollMcpServer(
    { server: "slack", tool: "history", args: { oldest: "{{cursor}}" } },
    { db, call, shape: slackShape("slack", "C1") },
  );
  assert.equal(pedidos[0]?.oldest, String(Date.UTC(2026, 9, 1, 12) / 1000));
});
