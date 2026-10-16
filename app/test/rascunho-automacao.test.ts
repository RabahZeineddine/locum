import { test } from "node:test";
import assert from "node:assert/strict";
import { rascunhoDoModelo, type Rascunho } from "../renderer/lib/automacao.js";
import {
  chaveDoRascunho,
  descartarRascunho,
  guardarRascunho,
  lerRascunho,
  temMudanca,
  type ArmazemLocal,
} from "../renderer/lib/rascunho-automacao.js";
import { registrarGuarda, sairDaTela } from "../renderer/lib/saida-do-editor.js";

/** O rascunho do editor de automação: quando há mudança, o que sobrevive e a saída com confirmação. */

function armazem(): ArmazemLocal & { itens: Map<string, string> } {
  const itens = new Map<string, string>();
  return {
    itens,
    getItem: (k) => itens.get(k) ?? null,
    setItem: (k, v) => void itens.set(k, v),
    removeItem: (k) => void itens.delete(k),
  };
}

const base = (): Rascunho => rascunhoDoModelo("teamsPrReview", "revisar-pr", "Revisar PR", null);
const comNome = (r: Rascunho, name: string): Rascunho => ({ ...r, spec: { ...r.spec, name } });

test("sem diferença do gravado não há mudança, e nome diferente é mudança", () => {
  assert.equal(temMudanca(base(), base()), false);
  assert.equal(temMudanca(comNome(base(), "Outro"), base()), true);
});

test("gatilho acrescentado ou ligado conta como mudança", () => {
  const r = base();
  const ligado = { ...r, gatilhos: r.gatilhos.map((g) => ({ ...g, enabled: !g.enabled })) };
  assert.equal(temMudanca(ligado, r), true);
  assert.equal(temMudanca({ ...r, gatilhos: [] }, r), true);
});

test("o rascunho guardado volta igual ao que foi escrito, com a versão e a hora", () => {
  const a = armazem();
  const salvo = base();
  const editado = comNome(salvo, "Editado");
  guardarRascunho(a, "revisar-pr", editado, salvo, 3, 1_700_000_000_000);
  const lido = lerRascunho(a, "revisar-pr");
  assert.deepEqual(lido?.rascunho, editado);
  assert.equal(lido?.versao, 3);
  assert.equal(lido?.salvoEm, 1_700_000_000_000);
});

test("o rascunho é por automação", () => {
  const a = armazem();
  const salvo = base();
  guardarRascunho(a, "um", comNome(salvo, "Um"), salvo, 1);
  assert.equal(lerRascunho(a, "dois"), null);
  assert.notEqual(chaveDoRascunho("um"), chaveDoRascunho("dois"));
});

test("voltar ao gravado apaga o rascunho, e descartar também", () => {
  const a = armazem();
  const salvo = base();
  guardarRascunho(a, "x", comNome(salvo, "Editado"), salvo, 1);
  guardarRascunho(a, "x", salvo, salvo, 1);
  assert.equal(lerRascunho(a, "x"), null);
  guardarRascunho(a, "x", comNome(salvo, "Editado"), salvo, 1);
  descartarRascunho(a, "x");
  assert.equal(a.itens.size, 0);
});

test("conteúdo corrompido não derruba a leitura", () => {
  const a = armazem();
  a.setItem(chaveDoRascunho("x"), "{nao e json");
  assert.equal(lerRascunho(a, "x"), null);
  a.setItem(chaveDoRascunho("x"), JSON.stringify({ rascunho: { spec: null } }));
  assert.equal(lerRascunho(a, "x"), null);
});

test("armazém cheio não quebra a edição", () => {
  const cheio: ArmazemLocal = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => undefined };
  const salvo = base();
  assert.doesNotThrow(() => guardarRascunho(cheio, "x", comNome(salvo, "E"), salvo, 1));
});

test("sair com mudança espera a decisão, e sem guarda segue direto", () => {
  let foi = 0;
  sairDaTela(() => foi++);
  assert.equal(foi, 1, "sem guarda");

  let pendente: (() => void) | null = null;
  const tirar = registrarGuarda((prosseguir) => {
    pendente = prosseguir;
    return true;
  });
  sairDaTela(() => foi++);
  assert.equal(foi, 1, "a guarda segurou");
  pendente!();
  assert.equal(foi, 2, "a decisão liberou");
  tirar();
  sairDaTela(() => foi++);
  assert.equal(foi, 3, "guarda removida");
});

test("guarda que não segura deixa passar", () => {
  let foi = 0;
  const tirar = registrarGuarda(() => false);
  sairDaTela(() => foi++);
  tirar();
  assert.equal(foi, 1);
});
