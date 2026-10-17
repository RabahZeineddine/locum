import { test } from "node:test";
import assert from "node:assert/strict";
import type { GrupoDeReferencias } from "../src/config/referencias.js";
import { filtrarSugestoes, inserirSugestao, marcadorAberto } from "../renderer/lib/sugestao-de-variavel.js";

const sem = (texto: string) => texto.replace("|", "");
const cursor = (texto: string) => (texto.indexOf("|") < 0 ? texto.length : texto.indexOf("|"));
const aberto = (texto: string) => marcadorAberto(sem(texto), cursor(texto));

test("marcador aberto: só vale com {{ antes do cursor e sem fechar", () => {
  assert.deepEqual(aberto("Revise {{|"), { inicio: 7, consulta: "" });
  assert.deepEqual(aberto("Revise {{ev|"), { inicio: 7, consulta: "ev" });
  assert.deepEqual(aberto("{{ steps.rev|isar}} depois"), { inicio: 0, consulta: "steps.rev" });
  assert.equal(aberto("sem marcador|"), null);
  assert.equal(aberto("{{event.text}} e mais|"), null, "marcador já fechado antes do cursor");
  assert.deepEqual(aberto("{{event.text}} {{|"), { inicio: 15, consulta: "" });
  assert.equal(aberto("{ {|"), null);
  assert.equal(aberto("{{ouro\nprata|"), null, "linha nova encerra a consulta");
  assert.equal(aberto('{{"ab|'), null, "caractere que o executor não aceita num caminho");
  assert.deepEqual(aberto("{{{ev|"), { inicio: 1, consulta: "ev" });
});

const grupos: GrupoDeReferencias[] = [
  { id: "event", tipo: "event", itens: [{ caminho: "event", tipo: "object", origem: "esquema" }, { caminho: "event.title", tipo: "string", origem: "esquema" }, { caminho: "event.text", tipo: "string", descricao: "The message text.", origem: "esquema" }] },
  { id: "revisar", tipo: "step", numero: 1, nome: "Revisar o PR", itens: [{ caminho: "steps.revisar", tipo: "string", origem: "esquema" }, { caminho: "steps.revisar.text", tipo: "string", origem: "esquema" }] },
  { id: "publicar", tipo: "step", numero: 2, nome: "Publicar", itens: [{ caminho: "steps.publicar", tipo: "object", origem: "esquema" }, { caminho: "steps.publicar.state", tipo: "string", origem: "esquema" }] },
];
const caminhos = (g: GrupoDeReferencias[]) => g.map((x) => [x.id, x.itens.map((i) => i.caminho)]);

test("filtrar: sem consulta traz tudo na ordem; evento primeiro, passos na ordem do fluxo", () => {
  assert.deepEqual(filtrarSugestoes(grupos, "").map((g) => g.id), ["event", "revisar", "publicar"]);
});

test("filtrar: começo do caminho ou de um trecho vence quem só contém, e grupo sem acerto some", () => {
  assert.deepEqual(caminhos(filtrarSugestoes(grupos, "text")), [
    ["event", ["event.text"]],
    ["revisar", ["steps.revisar.text"]],
  ]);
  assert.deepEqual(caminhos(filtrarSugestoes(grupos, "steps.pub")), [["publicar", ["steps.publicar", "steps.publicar.state"]]]);
  const [evento] = filtrarSugestoes(grupos, "t");
  assert.deepEqual(evento!.itens.map((i) => i.caminho), ["event.title", "event.text", "event"], "começo de trecho antes de contido (event só contém o t), ordem original no empate");
});

test("filtrar: acha pelo nome do passo, pelo número e pela descrição", () => {
  assert.deepEqual(filtrarSugestoes(grupos, "Revisar o").map((g) => g.id), ["revisar"]);
  assert.deepEqual(filtrarSugestoes(grupos, "2").map((g) => g.id), ["publicar"]);
  assert.deepEqual(caminhos(filtrarSugestoes(grupos, "message")), [["event", ["event.text"]]]);
  assert.deepEqual(filtrarSugestoes(grupos, "xyz"), []);
});

const inserir = (texto: string, caminho: string) => {
  const r = inserirSugestao(sem(texto), cursor(texto), caminho);
  return r === null ? null : `${r.texto.slice(0, r.cursor)}|${r.texto.slice(r.cursor)}`;
};

test("inserir: troca o que foi digitado por {{caminho}}, com a chave estável, e põe o cursor depois", () => {
  assert.equal(inserir("Revise {{ev|", "event.title"), "Revise {{event.title}}|");
  assert.equal(inserir("a {{rev| fim", "steps.revisar.text"), "a {{steps.revisar.text}}| fim");
});

test("inserir: não duplica as chaves que já estavam lá", () => {
  assert.equal(inserir("{{ev|}}", "event.title"), "{{event.title}}|");
  assert.equal(inserir("{{ev|ent.te}} x", "event.text"), "{{event.text}}| x", "come o resto da palavra e as chaves");
  assert.equal(inserir("{{ev| }} x", "event.text"), "{{event.text}}| x", "{{ ev }} com espaço também fecha sem duplicar");
});

test("inserir: sem marcador aberto não mexe", () => {
  assert.equal(inserir("nada aqui|", "event.title"), null);
});
