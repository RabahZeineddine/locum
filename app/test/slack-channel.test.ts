import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, slackMessages } from "../src/sources/slack.js";

// Mesmo formato do `slack_read_channel` do servidor oficial, com gente e texto
// inventados.
const RESPOSTA = {
  messages: [
    "Channel: #time (C0TESTE01)",
    "",
    "=== Message from Ana Lima <ana@exemplo.com> (U0ANA0001) at 2026-09-16 14:57:11 -03 === ",
    "Message TS: 1789581431.286749",
    "Vou colocar para ativar",
    "",
    "=== Message from Bruno Reis <bruno@fora.com> (U0BRUNO02, external: Outra Empresa) at 2026-09-16 11:15:02 -03 === ",
    "Message TS: 1789568102.518769",
    "Fala <@U0ANA0001|Ana Lima>, tudo bem?",
    "",
    "Segunda linha da mesma mensagem.",
    "Thread: 1 replies (latest: 2026-09-16 11:34:52 -03)",
    "",
    "=== Message from Ana Lima <ana@exemplo.com> (U0ANA0001) at 2026-09-11 09:48:04 -03 === ",
    "Message TS: 1789130884.970639",
    "",
    "Reactions: white_check_mark (1)",
    "Files: File.png (ID: F0TESTE, image/png, 305.7 KB)",
  ].join("\n"),
  pagination_info: "There are more messages available.",
};

test("mensagens em texto do servidor oficial viram itens com carimbo, autor e canal", () => {
  const itens = slackMessages(RESPOSTA);
  assert.equal(itens.length, 3);

  const [primeira, segunda, terceira] = itens.map((item) => normalize(item, "C-outro"));
  assert.deepEqual(primeira, {
    channel: "C0TESTE01",
    author: "Ana Lima",
    text: "Vou colocar para ativar",
    ts: "1789581431.286749",
    threadTs: "1789581431.286749",
    reply: false,
    permalink: null,
  });
  // Pessoa de fora da organização, texto de várias linhas e metadado no fim.
  assert.equal(segunda?.author, "Bruno Reis");
  assert.equal(segunda?.text, "Fala <@U0ANA0001|Ana Lima>, tudo bem?\n\nSegunda linha da mesma mensagem.");
  // Mensagem só com arquivo fica sem texto, mas continua sendo mensagem.
  assert.equal(terceira?.text, "");
  assert.equal(terceira?.ts, "1789130884.970639");
});

test("canal sem mensagem nenhuma em texto não vira item", () => {
  assert.deepEqual(slackMessages({ messages: "Channel: #time (C0TESTE01)\n" }), []);
  assert.deepEqual(slackMessages({ messages: "" }), []);
});
