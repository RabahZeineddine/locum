import { test } from "node:test";
import assert from "node:assert/strict";
import { destinoDoPasso, destinosDaAcao } from "../src/acao/destino.js";
import { resolverDestino, type AdaptadorDeConversa } from "../src/acao/conversa.js";

/** O destino de resposta e de reação: do evento ou de um valor fixo, nunca do modelo nem de passo anterior. */

const fixo = (app: string, ref: string, rotulo?: string) => ({
  destino: { tipo: "fixo", conversa: { app, ref, ...(rotulo === undefined ? {} : { rotulo }) } },
});

test("sem o parâmetro, o destino é a mensagem do evento (automação gravada antes continua igual)", () => {
  for (const acao of ["teams.post", "slack.post", "teams.react", "slack.react"]) {
    assert.deepEqual(destinoDoPasso(acao, undefined), { tipo: "evento" });
    assert.deepEqual(destinoDoPasso(acao, { emoji: "👀" }), { tipo: "evento" });
  }
});

test("o registro declara o que cada ação aceita; reação só aceita o evento", () => {
  assert.deepEqual(destinosDaAcao("teams.post"), ["evento", "fixo", "novo"]);
  assert.deepEqual(destinosDaAcao("slack.react"), ["evento"]);
  assert.deepEqual(destinosDaAcao("github.review"), []);
  assert.throws(() => destinoDoPasso("teams.react", { destino: { tipo: "novo" } }), /reação/);
  assert.throws(() => destinoDoPasso("slack.react", fixo("slack", "C1")), /reação/);
});

test("aceita nova mensagem e conversa fixa, no mesmo formato para qualquer app", () => {
  assert.deepEqual(destinoDoPasso("teams.post", { destino: { tipo: "novo" } }), { tipo: "novo" });
  assert.deepEqual(destinoDoPasso("slack.post", fixo("slack", "C123", "geral")).tipo, "fixo");
  assert.throws(() => destinoDoPasso("slack.post", fixo("teams", "chat/1")), /fala com slack/);
});

test("marcador de passo ou de evento no destino é recusado: só o evento ou um valor fixo decide", () => {
  assert.throws(() => destinoDoPasso("teams.post", fixo("teams", "{{steps.revisar.chat}}")), /marcador/);
  assert.throws(() => destinoDoPasso("slack.post", fixo("slack", "{{event.channel}}")), /marcador/);
  assert.throws(() => destinoDoPasso("slack.post", { destino: "{{steps.x}}" }), /marcador/);
});

test("o rótulo não decide o destino: marcador nele não é recusado, no ref é", () => {
  assert.equal(destinoDoPasso("slack.post", fixo("slack", "C1", "{{steps.x}}")).tipo, "fixo");
  assert.throws(() => destinoDoPasso("slack.post", { destino: { tipo: "fixo", conversa: { app: "slack", ref: "C1", conta: "{{steps.x}}" } } }), /marcador/);
});

test("tipo desconhecido ou fixo sem conversa é recusado", () => {
  assert.throws(() => destinoDoPasso("teams.post", { destino: { tipo: "qualquer" } }), /inválido/);
  assert.throws(() => destinoDoPasso("teams.post", { destino: { tipo: "fixo" } }), /inválido/);
});

const adaptador: AdaptadorDeConversa = {
  app: "falso",
  enderecoDoEvento: (p) => {
    const e = p as { conversa?: string; fio?: string };
    if (e.conversa === undefined) throw new Error("evento sem conversa");
    return { conversa: e.conversa, mensagem: e.fio ?? null };
  },
  validarRef: (ref) => {
    if (!ref.startsWith("f/")) throw new Error("ref inválido");
  },
  descreverRef: (ref) => `Conversa ${ref}`,
};

test("resolverDestino é igual para qualquer app: evento no fio, novo fora do fio, fixo sem evento", () => {
  // `falso` não está no registro: usa-se uma ação registrada só para o tipo de destino.
  const ev = { conversa: "f/1", fio: "m9" };
  const comoApp = (cru: unknown) => resolverDestino({ ...adaptador, app: "teams" }, "teams.post", cru, ev);
  assert.deepEqual(comoApp(undefined), { tipo: "evento", conversa: "f/1", mensagem: "m9", rotulo: null, conta: null });
  assert.deepEqual(comoApp({ tipo: "novo" }), { tipo: "novo", conversa: "f/1", mensagem: null, rotulo: null, conta: null });
  // O rótulo gravado é só o nome que a tela mostrou: a Fila recebe o que o ref descreve.
  assert.deepEqual(comoApp(fixo("teams", "f/2", "Nome que diverge").destino), {
    tipo: "fixo",
    conversa: "f/2",
    mensagem: null,
    rotulo: "Conversa f/2",
    conta: null,
  });
  assert.equal(comoApp({ tipo: "fixo", conversa: { app: "teams", ref: "f/2", conta: "a@x.test" } }).conta, "a@x.test");
  // O fixo não depende do evento: serve no gatilho manual e no ensaio.
  assert.equal(resolverDestino({ ...adaptador, app: "teams" }, "teams.post", fixo("teams", "f/2").destino, {}).conversa, "f/2");
  assert.throws(() => comoApp(fixo("teams", "g/2").destino), /ref inválido/);
  assert.throws(() => resolverDestino(adaptador, "teams.post", undefined, {}), /evento sem conversa/);
});
