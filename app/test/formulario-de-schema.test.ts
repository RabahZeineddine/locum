import { test } from "node:test";
import assert from "node:assert/strict";
import {
  camposDoSchema,
  definirNoCaminho,
  ehReferencia,
  referenciasDoArgs,
  valorDoTexto,
  validarArgs,
} from "../renderer/lib/formulario-de-schema.js";

/** Os schemas abaixo foram escritos à mão no formato que servidores reais publicam; nada é chamado. */

const ADD_REACTION_SLACK = {
  type: "object",
  properties: {
    channel_id: { type: "string", description: "ID do canal que tem a mensagem." },
    timestamp: { type: "string", description: "Timestamp da mensagem (ts)." },
    reaction: { type: "string", description: "Nome do emoji, sem os dois pontos.\nExemplo: eyes" },
  },
  required: ["channel_id", "timestamp", "reaction"],
};

const REACAO_MS365 = {
  type: "object",
  properties: {
    "chat-id": { type: "string", description: "key: id of chat" },
    "chatMessage-id": { type: "string", description: "key: id of chatMessage" },
    body: {
      type: "object",
      properties: { reactionType: { type: "string", enum: ["like", "heart", "laugh"], description: "Tipo da reação" } },
      required: ["reactionType"],
    },
  },
  required: ["chat-id", "chatMessage-id", "body"],
};

test("add_reaction do Slack vira três campos de texto obrigatórios com a ajuda na primeira linha", () => {
  const campos = camposDoSchema(ADD_REACTION_SLACK);
  assert.deepEqual(
    campos.map((c) => [c.nome, c.tipo, c.obrigatorio]),
    [
      ["channel_id", "string", true],
      ["timestamp", "string", true],
      ["reaction", "string", true],
    ],
  );
  assert.equal(campos[2]!.descricao, "Nome do emoji, sem os dois pontos.");
});

test("set-chat-message-reaction do ms365 traz o objeto aninhado com enum", () => {
  const [chat, msg, body] = camposDoSchema(REACAO_MS365);
  assert.equal(chat!.nome, "chat-id");
  assert.equal(msg!.obrigatorio, true);
  assert.equal(body!.tipo, "object");
  const [reacao] = body!.campos!;
  assert.deepEqual([reacao!.nome, reacao!.tipo, reacao!.obrigatorio, reacao!.opcoes], ["reactionType", "enum", true, ["like", "heart", "laugh"]]);
});

test("tipos primitivos, array de primitivos, nulável e o que não é suportado cai em json", () => {
  const campos = camposDoSchema({
    type: "object",
    properties: {
      n: { type: "number" },
      i: { type: "integer" },
      b: { type: "boolean" },
      tags: { type: "array", items: { type: "string" } },
      livre: { type: ["string", "null"] },
      ou: { oneOf: [{ type: "string" }, { type: "object", properties: { a: { type: "string" } } }] },
      lista: { type: "array", items: { type: "object", properties: { a: { type: "string" } } } },
      solto: { type: "object", additionalProperties: true },
      ref: { $ref: "#/$defs/x" },
      opcional: { anyOf: [{ type: "integer" }, { type: "null" }] },
    },
  });
  const por = Object.fromEntries(campos.map((c) => [c.nome, c]));
  assert.equal(por.n!.tipo, "number");
  assert.equal(por.i!.tipo, "integer");
  assert.equal(por.b!.tipo, "boolean");
  assert.deepEqual([por.tags!.tipo, por.tags!.itens], ["array", "string"]);
  assert.equal(por.livre!.tipo, "string");
  assert.equal(por.ou!.tipo, "json");
  assert.equal(por.lista!.tipo, "json");
  assert.equal(por.solto!.tipo, "json");
  assert.equal(por.ref!.tipo, "json");
  assert.equal(por.opcional!.tipo, "integer");
  assert.equal(por.n!.obrigatorio, false);
});

test("schema ausente ou sem propriedades não gera campo", () => {
  assert.deepEqual(camposDoSchema(undefined), []);
  assert.deepEqual(camposDoSchema({ type: "object", properties: {} }), []);
});

test("valor fixo e referência: a referência grava a expressão, o fixo grava o tipo certo", () => {
  const [n, b, tags] = camposDoSchema({
    type: "object",
    properties: { n: { type: "number" }, b: { type: "boolean" }, tags: { type: "array", items: { type: "integer" } } },
  });
  assert.equal(valorDoTexto("42", n!), 42);
  assert.equal(valorDoTexto("{{event.total}}", n!), "{{event.total}}");
  assert.equal(valorDoTexto("abc", n!), "abc", "texto que não é número fica como está, e a validação acusa");
  assert.equal(valorDoTexto("", n!), undefined, "vazio tira o campo");
  assert.equal(valorDoTexto("true", b!), true);
  assert.equal(valorDoTexto("false", b!), false);
  assert.deepEqual(valorDoTexto("1\n2, 3", tags!), [1, 2, 3]);
  assert.equal(valorDoTexto("{{steps.ler.ids}}", tags!), "{{steps.ler.ids}}");
});

test("ehReferencia só vale para o marcador sozinho, como o executor", () => {
  assert.equal(ehReferencia("{{event.text}}"), true);
  assert.equal(ehReferencia("{{ steps.abrir-tarefa.url }}"), true);
  assert.equal(ehReferencia("oi {{event.text}}"), false);
  assert.equal(ehReferencia(3), false);
});

test("definirNoCaminho grava aninhado sem mutar e poda o objeto que esvaziou", () => {
  const a = definirNoCaminho({}, ["body", "reactionType"], "like");
  assert.deepEqual(a, { body: { reactionType: "like" } });
  const b = definirNoCaminho(a, ["body", "reactionType"], undefined);
  assert.deepEqual(b, {});
  assert.deepEqual(a, { body: { reactionType: "like" } });
});

test("validarArgs: obrigatório vazio, tipo errado em valor fixo, e referência passa em qualquer tipo", () => {
  const campos = camposDoSchema(REACAO_MS365);
  assert.deepEqual(validarArgs(campos, {}), [
    { caminho: "chat-id", motivo: "obrigatorio" },
    { caminho: "chatMessage-id", motivo: "obrigatorio" },
    { caminho: "body", motivo: "obrigatorio" },
  ]);
  assert.deepEqual(
    validarArgs(campos, { "chat-id": "{{event.chatId}}", "chatMessage-id": "  ", body: { reactionType: "triste" } }),
    [
      { caminho: "chatMessage-id", motivo: "obrigatorio" },
      { caminho: "body.reactionType", motivo: "tipo" },
    ],
  );
  assert.deepEqual(validarArgs(campos, { "chat-id": "a", "chatMessage-id": "b", body: { reactionType: "{{steps.escolher.reacao}}" } }), []);
  const nums = camposDoSchema({ type: "object", properties: { n: { type: "integer" }, f: { type: "boolean" } } });
  assert.deepEqual(validarArgs(nums, { n: 1.5, f: "sim" }), [
    { caminho: "n", motivo: "tipo" },
    { caminho: "f", motivo: "tipo" },
  ]);
  assert.deepEqual(validarArgs(nums, { n: "{{event.n}}", f: false }), []);
  assert.deepEqual(validarArgs(nums, {}), [], "opcional ausente não acusa");
});

test("referenciasDoArgs acha os marcadores em qualquer profundidade", () => {
  assert.deepEqual(referenciasDoArgs({ a: "{{event.x}}", b: { c: ["oi {{steps.ler.y}}", 3] } }), ["event.x", "steps.ler.y"]);
});
