import { test } from "node:test";
import assert from "node:assert/strict";
import { opcoesDeCanaisDoSlack, canalDoSlackDigitado } from "../renderer/lib/canais-do-slack.js";

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
  assert.equal(canalDoSlackDigitado(" c0abc1234 ", lista), "C0ABC1234");
  assert.equal(canalDoSlackDigitado("C1", lista), null);
  assert.equal(canalDoSlackDigitado("alfa", lista), null);
  assert.equal(canalDoSlackDigitado("xx", lista), null);
});
