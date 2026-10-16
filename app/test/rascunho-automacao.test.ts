import { test } from "node:test";
import assert from "node:assert/strict";
import { rascunhoDoModelo, type Rascunho } from "../renderer/lib/automacao.js";
import {
  chaveDoRascunho,
  descartarReserva,
  descartarRascunho,
  diferencas,
  guardarRascunho,
  lerRascunho,
  lerReservas,
  apagarProvisoria,
  guardarProvisoria,
  lerProvisoria,
  ofertaDeRascunho,
  restaurarRascunho,
  reservarRascunho,
  temMudanca,
  type ArmazemListavel,
  type ArmazemLocal,
} from "../renderer/lib/rascunho-automacao.js";
import { registrarGuarda, sairDaTela } from "../renderer/lib/saida-do-editor.js";

/** O rascunho do editor de automação: quando há mudança, o que sobrevive e a saída com confirmação. */

function armazem(): ArmazemListavel & { itens: Map<string, string> } {
  const itens = new Map<string, string>();
  return {
    itens,
    get length() {
      return itens.size;
    },
    key: (i) => [...itens.keys()][i] ?? null,
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

/* ---------------------------------------------------------- base que mudou */

const comGatilhoLigado = (r: Rascunho, enabled: boolean): Rascunho => ({ ...r, gatilhos: r.gatilhos.map((g) => ({ ...g, enabled })) });
const gravado = (v: number, r: Rascunho, criadaEm = 100) => ({ versao: v, criadaEm, rascunho: r });

test("rascunho sobre a versão que ainda é a gravada é oferecido sem aviso de base", () => {
  const a = armazem();
  const salvo = base();
  guardarRascunho(a, "x", comNome(salvo, "Editado"), salvo, 5, 10, 100);
  const oferta = ofertaDeRascunho(a, "x", gravado(5, salvo));
  assert.equal(oferta?.baseMudou, false);
  assert.equal(oferta?.guardado.versao, 5);
});

test("rascunho da v5 sobre uma base que já está na v6 avisa que a automação mudou", () => {
  const a = armazem();
  const v5 = base();
  guardarRascunho(a, "x", comNome(v5, "Editado"), v5, 5, 10, 100);
  const v6 = comNome(v5, "Entrou pelo MCP");
  const oferta = ofertaDeRascunho(a, "x", gravado(6, v6));
  assert.equal(oferta?.baseMudou, true);
  assert.equal(oferta?.guardado.versao, 5);
});

test("rascunho de outra encarnação do mesmo id (createdAt diferente) é ignorado", () => {
  const a = armazem();
  const salvo = base();
  guardarRascunho(a, "x", comNome(salvo, "Editado"), salvo, 1, 10, 100);
  assert.equal(ofertaDeRascunho(a, "x", gravado(1, salvo, 999)), null);
});

test("restaurar nunca traz enabled do rascunho: a automação ligada depois do rascunho continua ligada", () => {
  const salvo = comGatilhoLigado(base(), false);
  const gatilhosComId = { ...salvo, gatilhos: salvo.gatilhos.map((g) => ({ ...g, id: "g1" })) };
  const rascunho = comNome(gatilhosComId, "Editado"); // gravado com o gatilho desligado
  const agoraLigado = comGatilhoLigado(gatilhosComId, true);
  const restaurado = restaurarRascunho(rascunho, agoraLigado);
  assert.equal(restaurado.spec.name, "Editado");
  assert.deepEqual(restaurado.gatilhos.map((g) => g.enabled), [true]);
});

test("restaurar sobre a v6 que entrou pelo MCP mantém orçamento e skills gravados e o que a pessoa editou no canvas", () => {
  const v5 = base();
  const rascunho = comNome(v5, "Nome do canvas");
  const v6: Rascunho = { ...v5, spec: { ...v5.spec, budget: { perRunUsd: 1 }, skills: [], defaultTools: [] } };
  const restaurado = restaurarRascunho(rascunho, v6);
  assert.equal(restaurado.spec.name, "Nome do canvas");
  assert.deepEqual(restaurado.spec.budget, { perRunUsd: 1 });
});

test("gatilho do rascunho que sumiu do gravado volta como novo e desligado, e gatilho novo nasce desligado", () => {
  const v5 = base();
  const comId = { ...v5, gatilhos: v5.gatilhos.map((g) => ({ ...g, id: "velho", enabled: true })) };
  const atual: Rascunho = { ...v5, gatilhos: [] };
  const restaurado = restaurarRascunho(comId, atual);
  assert.equal(restaurado.gatilhos[0]?.id, undefined);
  assert.equal(restaurado.gatilhos[0]?.enabled, false);
});

test("as diferenças listam passos e gatilhos que mudaram", () => {
  const v6 = { ...base(), gatilhos: base().gatilhos.map((g, i) => ({ ...g, id: `g${i}` })) };
  const rascunho: Rascunho = {
    ...v6,
    spec: { ...v6.spec, steps: [{ ...v6.spec.steps[0]!, name: "Outro nome do passo" }, ...v6.spec.steps.slice(1, -1)] },
    gatilhos: [],
  };
  const d = diferencas(v6, rascunho);
  assert.deepEqual(d.passos.map((p) => [p.chave, p.tipo]), [
    [v6.spec.steps[0]!.key, "alterado"],
    [v6.spec.steps.at(-1)!.key, "removido"],
  ]);
  assert.deepEqual(d.gatilhos.map((g) => g.tipo), ["removido"]);
  assert.equal(diferencas(v6, v6).passos.length + diferencas(v6, v6).gatilhos.length, 0);
});

/* ----------------------------------------------------------------- reserva */

test("reservar move o rascunho para uma chave com a data, e ele continua achável", () => {
  const a = armazem();
  const salvo = base();
  guardarRascunho(a, "x", comNome(salvo, "Velho"), salvo, 5, 10, 100);
  assert.ok(reservarRascunho(a, "x", 1_700_000_000_000)?.startsWith("locum.rascunho-automacao-reserva.x."));
  assert.equal(lerRascunho(a, "x"), null);
  const reservas = lerReservas(a, "x");
  assert.equal(reservas.length, 1);
  assert.equal(reservas[0]?.guardado.rascunho.spec.name, "Velho");
  assert.equal(reservarRascunho(a, "x", 1_700_000_000_001), null, "sem rascunho ativo não há o que reservar");
});

test("descartar o rascunho ativo não apaga a reserva, e a oferta volta a achá-la", () => {
  const a = armazem();
  const salvo = base();
  guardarRascunho(a, "x", comNome(salvo, "Velho"), salvo, 5, 10, 100);
  reservarRascunho(a, "x", 20);
  guardarRascunho(a, "x", comNome(salvo, "Novo"), salvo, 5, 30, 100);
  descartarRascunho(a, "x"); // "Descartar" no diálogo de saída
  assert.equal(lerReservas(a, "x").length, 1);
  const oferta = ofertaDeRascunho(a, "x", gravado(5, salvo));
  assert.equal(oferta?.guardado.rascunho.spec.name, "Velho");
  assert.notEqual(oferta?.reserva, undefined);
  descartarReserva(a, oferta!.reserva!);
  assert.equal(ofertaDeRascunho(a, "x", gravado(5, salvo)), null);
});

test("a reserva é por automação", () => {
  const a = armazem();
  const salvo = base();
  guardarRascunho(a, "um", comNome(salvo, "Velho"), salvo, 5, 10, 100);
  reservarRascunho(a, "um", 20);
  assert.equal(lerReservas(a, "dois").length, 0);
  assert.equal(lerReservas(a, "um-a").length, 0);
});

/* ----------------------------------------------- automação ainda não gravada */

test("automação nova só existe como provisória até o primeiro salvar, e abandonar sem edição não deixa rastro", () => {
  const a = armazem();
  const modelo = base();
  guardarProvisoria(a, "nova-um", { rascunho: modelo, nota: "Modelo", iniciativa: "squad" });
  const lida = lerProvisoria(a, "nova-um");
  assert.deepEqual(lida?.rascunho, modelo);
  assert.equal(lida?.iniciativa, "squad");
  assert.equal(lerProvisoria(a, "outra"), null);
  apagarProvisoria(a, "nova-um");
  assert.equal(lerProvisoria(a, "nova-um"), null);
  assert.equal(a.itens.size, 0);
});

test("provisória corrompida é ignorada", () => {
  const a = armazem();
  a.setItem("locum.automacao-provisoria.x", "{nao");
  assert.equal(lerProvisoria(a, "x"), null);
  a.setItem("locum.automacao-provisoria.x", JSON.stringify({ rascunho: { spec: null } }));
  assert.equal(lerProvisoria(a, "x"), null);
});

test("com o modal aberto a saída passa pela guarda dele e depois pela do editor, e fechar o modal só pergunta a dele", () => {
  const ordem: string[] = [];
  const pendentes: Record<string, () => void> = {};
  const tirarEditor = registrarGuarda((prosseguir) => {
    pendentes.editor = prosseguir;
    ordem.push("editor");
    return true;
  });
  const tirarModal = registrarGuarda((prosseguir) => {
    pendentes.modal = prosseguir;
    ordem.push("modal");
    return true;
  }, 1);

  let navegou = 0;
  sairDaTela(() => navegou++);
  assert.deepEqual(ordem, ["modal"], "a do modal pergunta primeiro");
  pendentes.modal!();
  assert.deepEqual(ordem, ["modal", "editor"], "depois a do editor");
  assert.equal(navegou, 0);
  pendentes.editor!();
  assert.equal(navegou, 1);

  ordem.length = 0;
  let fechou = 0;
  sairDaTela(() => fechou++, 1);
  assert.deepEqual(ordem, ["modal"], "fechar o modal não pergunta do editor");
  pendentes.modal!();
  assert.equal(fechou, 1);
  assert.deepEqual(ordem, ["modal"]);

  tirarModal();
  tirarEditor();
  sairDaTela(() => navegou++);
  assert.equal(navegou, 2);
});
