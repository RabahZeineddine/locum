import { test } from "node:test";
import assert from "node:assert/strict";
import { filtrarComandos, normalizar } from "../renderer/lib/paleta.js";
import { assinarAcaoDaTela, consumirPedido, pedirAcaoDaTela, VALIDADE_DO_PEDIDO_MS } from "../renderer/lib/acao-da-tela.js";

const comandos = [
  { id: "1", grupo: "go" as const, rotulo: "Ir para Automações", palavras: "Automações" },
  { id: "2", grupo: "actions" as const, rotulo: "Nova automação" },
  { id: "3", grupo: "connections" as const, rotulo: "GitHub" },
  { id: "4", grupo: "go" as const, rotulo: "Ir para Conexões", palavras: "Conexões" },
];

test("normalizar tira acento e caixa", () => {
  assert.equal(normalizar("Automações ÁRVORE"), "automacoes arvore");
});

test("sem termo, agrupa na ordem dos grupos e mantém a ordem dentro deles", () => {
  assert.deepEqual(filtrarComandos(comandos, "  ").map((c) => c.id), ["2", "1", "4", "3"]);
});

test("o termo casa sem acento nem caixa, no rótulo ou nas palavras extras", () => {
  assert.deepEqual(filtrarComandos(comandos, "AUTOMAC").map((c) => c.id), ["2", "1"]);
  assert.deepEqual(filtrarComandos(comandos, "conexoes").map((c) => c.id), ["4"]);
  assert.deepEqual(filtrarComandos(comandos, "zzz"), []);
});

test("pedido guardado vale uma vez, só para a ação pedida", () => {
  pedirAcaoDaTela("nova-automacao", 1000);
  assert.equal(consumirPedido("adicionar-conexao", 1001), false);
  assert.equal(consumirPedido("nova-automacao", 1001), true);
  assert.equal(consumirPedido("nova-automacao", 1002), false);
});

test("pedido de uma tela que não montou expira", () => {
  pedirAcaoDaTela("nova-automacao", 1000);
  assert.equal(consumirPedido("nova-automacao", 1000 + VALIDADE_DO_PEDIDO_MS + 1), false);
});

test("a tela que monta depois recebe o pedido, e a que já está no ar recebe o próximo", () => {
  let chamadas = 0;
  pedirAcaoDaTela("adicionar-conexao");
  const cancelar = assinarAcaoDaTela("adicionar-conexao", () => chamadas++);
  assert.equal(chamadas, 1);
  pedirAcaoDaTela("adicionar-conexao");
  assert.equal(chamadas, 2);
  pedirAcaoDaTela("nova-automacao");
  assert.equal(chamadas, 2);
  consumirPedido("nova-automacao");
  cancelar();
  pedirAcaoDaTela("adicionar-conexao");
  assert.equal(chamadas, 2);
  consumirPedido("adicionar-conexao");
});
