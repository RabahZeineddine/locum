import { test } from "node:test";
import assert from "node:assert/strict";
import { registrarGuarda, sairDaTela, seguirSeSalvou } from "../renderer/lib/saida-do-editor.js";

/** A pilha de guardas da janela: quem pergunta, em que ordem, e quando a navegação segue. */

test("três níveis perguntam do mais alto ao mais baixo, um de cada vez, e só então a navegação segue", () => {
  const ordem: string[] = [];
  const pendentes = new Map<string, () => void>();
  const guarda = (nome: string) => (prosseguir: () => void) => {
    ordem.push(nome);
    pendentes.set(nome, prosseguir);
    return true;
  };
  const tirar = [registrarGuarda(guarda("editor"), 0), registrarGuarda(guarda("modal"), 1), registrarGuarda(guarda("painel"), 2)];
  let navegou = 0;
  sairDaTela(() => navegou++);
  assert.deepEqual(ordem, ["painel"]);
  pendentes.get("painel")!();
  pendentes.get("modal")!();
  assert.deepEqual(ordem, ["painel", "modal", "editor"]);
  assert.equal(navegou, 0);
  pendentes.get("editor")!();
  assert.equal(navegou, 1);
  tirar.forEach((t) => t());
});

test("guarda que não segura passa a vez para a próxima sem perguntar nada", () => {
  const ordem: string[] = [];
  let pendente: (() => void) | undefined;
  const tirar = [
    registrarGuarda(() => (ordem.push("modal"), false), 1),
    registrarGuarda((prosseguir) => (ordem.push("editor"), (pendente = prosseguir), true), 0),
  ];
  let navegou = 0;
  sairDaTela(() => navegou++);
  assert.deepEqual(ordem, ["modal", "editor"]);
  assert.equal(navegou, 0);
  pendente!();
  assert.equal(navegou, 1);
  tirar.forEach((t) => t());
});

test("desdeONivel ignora as guardas de baixo, e tirar a guarda duas vezes não tira a de outro", () => {
  const ordem: string[] = [];
  const tirarEditor = registrarGuarda(() => (ordem.push("editor"), false), 0);
  const tirarModal = registrarGuarda(() => (ordem.push("modal"), false), 1);
  sairDaTela(() => undefined, 1);
  assert.deepEqual(ordem, ["modal"]);
  tirarModal();
  tirarModal();
  ordem.length = 0;
  sairDaTela(() => undefined);
  assert.deepEqual(ordem, ["editor"], "a do editor continua registrada");
  tirarEditor();
  let navegou = 0;
  sairDaTela(() => navegou++);
  assert.equal(navegou, 1);
});

test("depois de salvar a saída pendente segue, uma vez só, e salvar que falhou não a solta", () => {
  let seguiu = 0;
  let limpou = 0;
  const saida = { prosseguir: () => void seguiu++ };
  assert.equal(seguirSeSalvou(saida, false, () => void limpou++), false);
  assert.deepEqual([seguiu, limpou], [0, 0]);
  assert.equal(seguirSeSalvou(saida, true, () => void limpou++), true);
  assert.deepEqual([seguiu, limpou], [1, 1]);
  assert.equal(seguirSeSalvou(null, true, () => void limpou++), false, "sem pergunta aberta não há o que seguir");
  assert.deepEqual([seguiu, limpou], [1, 1]);
});
