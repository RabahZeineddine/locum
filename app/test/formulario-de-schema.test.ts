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
  assert.deepEqual(valorDoTexto("1\n2\n3", tags!), [1, 2, 3]);
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

test("alternar para o JSON e voltar não perde valor", async () => {
  const { textoDosArgs, argsDoTexto } = await import("../renderer/lib/formulario-de-schema.js");
  const args = { channel_id: "{{event.channel}}", reaction: "eyes", n: 2, body: { a: ["x"] } };
  assert.deepEqual(argsDoTexto(textoDosArgs(args)), args);
  assert.equal(argsDoTexto("{ incompleto"), null, "texto que ainda não é JSON não apaga os args");
  assert.equal(argsDoTexto("[1]"), null);
  assert.deepEqual(argsDoTexto("  "), {});
});

test("referências disponíveis: campos do evento do gatilho, passos anteriores e as propriedades do formato de saída", async () => {
  const { catalogoDoPasso } = await import("../renderer/lib/automacao.js");
  const referenciasDisponiveis = (...a: Parameters<typeof catalogoDoPasso>) => catalogoDoPasso(...a).flatMap((g) => g.itens.slice(g.tipo === "event" ? 1 : 0));
  const modelo = { type: "model", key: "revisar", name: "Revisar", needs: [], prompt: "x", outputSchema: { type: "object", properties: { verdict: { type: "string" } } } };
  const acao = { type: "action", key: "reagir", name: "R", needs: ["revisar"], optional: false, action: "mcp.call", mode: "approve", params: {} };
  const r = {
    spec: { id: "a", name: "A", model: "m", steps: [modelo, acao] },
    gatilhos: [{ chave: "gatilho-1", enabled: true, config: { kind: "slack-channel", channels: [], everyMinutes: 5 } }],
  } as never;
  const caminhos = referenciasDisponiveis(r, "reagir").map((x) => x.caminho);
  assert.ok(caminhos.includes("event.channel") && caminhos.includes("event.threadTs"));
  assert.ok(caminhos.includes("steps.revisar") && caminhos.includes("steps.revisar.verdict"));
  assert.ok(!caminhos.includes("steps.reagir"), "o próprio passo e os que vêm depois não entram");
});

test("caminhos de uma saída: campos, o primeiro item de cada lista e objetos aninhados, sem passar da profundidade", async () => {
  const { caminhosDaSaida } = await import("../renderer/lib/automacao.js");
  assert.deepEqual(caminhosDaSaida({ total: 7, itens: ["a", "b"], dono: { nome: "x", dados: { fundo: { raso: 1 } } } }), [
    "total",
    "itens",
    "itens.0",
    "dono",
    "dono.nome",
    "dono.dados",
    "dono.dados.fundo",
  ]);
  assert.deepEqual(caminhosDaSaida("texto"), []);
  assert.deepEqual(caminhosDaSaida(null), []);
  assert.deepEqual(caminhosDaSaida([{ id: 1 }]), ["0", "0.id"]);
});

test("o seletor oferece os caminhos da saída do último run e o outputSchema da ferramenta", async () => {
  const { catalogoDoPasso } = await import("../renderer/lib/automacao.js");
  const referenciasDisponiveis = (...a: Parameters<typeof catalogoDoPasso>) => catalogoDoPasso(...a).flatMap((g) => g.itens.slice(g.tipo === "event" ? 1 : 0));
  const ler = { type: "action", key: "ler", name: "Ler", needs: [], optional: false, action: "mcp.call", mode: "auto", params: { server: "fx", tool: "totais", args: {} } };
  const outro = { type: "action", key: "outro", name: "Outro", needs: [], optional: false, action: "mcp.call", mode: "auto", params: { server: "fx", tool: "sem_schema", args: {} } };
  const usar = { type: "action", key: "usar", name: "Usar", needs: ["ler", "outro"], optional: false, action: "mcp.call", mode: "approve", params: {} };
  const r = { spec: { id: "a", name: "A", model: "m", steps: [ler, outro, usar] }, gatilhos: [] } as never;
  const sem = referenciasDisponiveis(r, "usar").map((x) => x.caminho);
  assert.deepEqual(sem, ["steps.ler", "steps.outro"], "sem run anterior nem schema, só o passo inteiro");
  const com = referenciasDisponiveis(r, "usar", {
    saidas: { ler: { total: 7, itens: ["a"] }, outro: { text: "oi" } },
    esquemasDeSaida: { "fx/totais": { type: "object", properties: { total: { type: "number" }, extra: { type: "string" } } } },
  }).map((x) => x.caminho);
  assert.deepEqual(com, ["steps.ler", "steps.ler.total", "steps.ler.extra", "steps.ler.itens", "steps.ler.itens.0", "steps.outro", "steps.outro.text"]);
});

test("as saídas do último run: a mais recente de cada passo, sem o estado de ensaio nem saída vazia", async () => {
  const { saidasDosRuns } = await import("../renderer/lib/automacao.js");
  const runs = [
    { steps: [{ stepKey: "ler", output: { state: "ensaio", text: "x" } }, { stepKey: "outro", output: null }] },
    { steps: [{ stepKey: "ler", output: { total: 1 } }, { stepKey: "outro", output: { ok: true } }] },
    { steps: [{ stepKey: "ler", output: { total: 0 } }] },
  ];
  assert.deepEqual(saidasDosRuns(runs), { ler: { total: 1 }, outro: { ok: true } });
  assert.deepEqual(saidasDosRuns([]), {});
});

test("trocar de fixo para referência (e o contrário) limpa o valor que sobrou", async () => {
  const { valorAoTrocarDeModo } = await import("../renderer/lib/formulario-de-schema.js");
  assert.equal(valorAoTrocarDeModo("eyes", "ref"), undefined, "o valor fixo não vira referência");
  assert.equal(valorAoTrocarDeModo("{{event.text}}", "fixo"), undefined, "a referência não vira valor fixo");
  assert.equal(valorAoTrocarDeModo("{{event.text}}", "ref"), "{{event.text}}");
  assert.equal(valorAoTrocarDeModo("eyes", "fixo"), "eyes");
});

test("array de strings: um item por linha, a vírgula não separa", () => {
  const [tags] = camposDoSchema({ type: "object", properties: { tags: { type: "array", items: { type: "string" } } } });
  assert.deepEqual(valorDoTexto("a, b\nc d", tags!), ["a, b", "c d"]);
});

test("campo json com texto que não é JSON bloqueia; marcador e JSON válido passam", () => {
  const campos = camposDoSchema({ type: "object", properties: { livre: { type: "object", additionalProperties: true }, ou: { oneOf: [{ type: "string" }, { type: "object" }] } } });
  assert.deepEqual(validarArgs(campos, { livre: "{ quebrado" }), [{ caminho: "livre", motivo: "tipo" }]);
  assert.deepEqual(validarArgs(campos, { livre: { a: 1 } }), []);
  assert.deepEqual(validarArgs(campos, { livre: "{{steps.ler.obj}}" }), []);
  assert.deepEqual(validarArgs(campos, { ou: "texto simples" }), [], "o schema aceita texto");
});

test("trocar a ferramenta recalcula o modo: escrita sem autoEscrita volta para approve", async () => {
  const { modoParaFerramenta } = await import("../renderer/lib/paleta-conexoes.js");
  const leitura = { name: "get_total", readOnlyHint: true };
  const escrita = { name: "send_message" };
  assert.equal(modoParaFerramenta("auto", false, escrita), "approve", "de get para send rebaixa");
  assert.equal(modoParaFerramenta("auto", true, escrita), "auto", "com autoEscrita a pessoa já escolheu");
  assert.equal(modoParaFerramenta("auto", false, leitura), "auto");
  assert.equal(modoParaFerramenta("approve", false, leitura), "approve");
  assert.equal(modoParaFerramenta("auto", false, undefined), "approve", "sem saber o que é, não fica em auto");
});
