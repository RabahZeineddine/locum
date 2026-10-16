import { test } from "node:test";
import assert from "node:assert/strict";
import { opcoesDeCanaisDoSlack, canalDoSlackDigitado, rotuloDoChipDoSlack } from "../renderer/lib/canais-do-slack.js";

const lista = [
  { id: "C1", name: "alfa", isPrivate: false },
  { id: "G9", name: "segredo", isPrivate: true },
  { id: "C2", name: "beta", isPrivate: false },
];

test("sem busca, marcados primeiro e o resto em ordem alfabética", () => {
  const opcoes = opcoesDeCanaisDoSlack(lista, new Set(["C2"]), "", { privado: "privado" });
  assert.deepEqual(opcoes.map((o) => o.id), ["C2", "C1", "G9"]);
  assert.equal(opcoes[0]!.rotulo, "#beta");
});

test("canal privado leva o detalhe e a busca acha por nome ou por id", () => {
  assert.deepEqual(opcoesDeCanaisDoSlack(lista, new Set(), "SEG", { privado: "privado" }), [
    { id: "G9", rotulo: "#segredo", detalhe: "privado" },
  ]);
  assert.deepEqual(opcoesDeCanaisDoSlack(lista, new Set(), "c1", { privado: "privado" }).map((o) => o.id), ["C1"]);
});

test("id digitado à mão vira opção quando não está na lista", () => {
  assert.equal(canalDoSlackDigitado(" c0abc1234 ", lista, new Set()), "C0ABC1234");
  assert.equal(canalDoSlackDigitado("C1", lista, new Set()), null);
  assert.equal(canalDoSlackDigitado("alfa", lista, new Set()), null);
  assert.equal(canalDoSlackDigitado("xx", lista, new Set()), null);
});

test("id digitado que já está marcado não oferece usar de novo (o clique tiraria o canal)", () => {
  assert.equal(canalDoSlackDigitado("C0ABC1234", lista, new Set(["C0ABC1234"])), null);
  assert.equal(canalDoSlackDigitado("C0ABC1234", lista, new Set(["C1"])), "C0ABC1234");
});

test("chip: nome quando a lista tem, arquivado, não encontrado ou o id cru", () => {
  const resposta = {
    canais: lista,
    arquivados: [{ id: "C7", name: "velho", isPrivate: false }],
    naoEncontrados: ["C8"],
  };
  const rotulos = { arquivado: "arquivado", naoEncontrado: "não encontrado" };
  assert.equal(rotuloDoChipDoSlack("C1", resposta, rotulos), "#alfa");
  assert.equal(rotuloDoChipDoSlack("C7", resposta, rotulos), "#velho (arquivado)");
  assert.equal(rotuloDoChipDoSlack("C8", resposta, rotulos), "C8 (não encontrado)");
  assert.equal(rotuloDoChipDoSlack("C9", resposta, rotulos), "C9");
  assert.equal(rotuloDoChipDoSlack("C9", null, rotulos), "C9");
});
