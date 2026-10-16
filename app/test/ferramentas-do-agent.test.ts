import { test } from "node:test";
import assert from "node:assert/strict";
import { agruparPorArea, agruparPorTipo, areaDaFerramenta, contarDaConexao, filtrarFerramentas, revisarNovas } from "../renderer/lib/ferramentas-do-agent.js";

test("a área sai das palavras do nome", () => {
  assert.equal(areaDaFerramenta("list-chats"), "teams");
  assert.equal(areaDaFerramenta("get-channel-message"), "teams");
  assert.equal(areaDaFerramenta("list-mail-messages"), "mail");
  assert.equal(areaDaFerramenta("create-calendar-event"), "calendar");
  assert.equal(areaDaFerramenta("get-meeting-transcript"), "calendar");
  assert.equal(areaDaFerramenta("download-bytes-to-file"), "files");
  assert.equal(areaDaFerramenta("search-sharepoint-sites"), "files");
  assert.equal(areaDaFerramenta("copilot-retrieve"), "other");
  assert.equal(areaDaFerramenta("getTeamMember"), "teams");
});

test("a busca olha o nome e a descrição", () => {
  const lista = [
    { name: "list-chats", description: "Lista conversas" },
    { name: "list-mail-messages", description: "Caixa de entrada" },
  ];
  assert.deepEqual(filtrarFerramentas(lista, "CHAT").map((f) => f.name), ["list-chats"]);
  assert.deepEqual(filtrarFerramentas(lista, "entrada").map((f) => f.name), ["list-mail-messages"]);
  assert.equal(filtrarFerramentas(lista, " ").length, 2);
});

test("servidor pequeno não agrupa, e o grande agrupa na ordem das áreas, sem grupo vazio", () => {
  const poucas = [{ name: "a" }, { name: "list-chats" }];
  assert.deepEqual(agruparPorArea(poucas), [{ area: null, itens: poucas }]);
  const muitas = [{ name: "x" }, { name: "list-mail" }, { name: "list-chats" }];
  assert.deepEqual(
    agruparPorArea(muitas, 100).map((g) => [g.area, g.itens.map((i) => i.name)]),
    [["teams", ["list-chats"]], ["mail", ["list-mail"]], ["other", ["x"]]],
  );
});

test("agrupar por tipo põe a leitura primeiro e some com o grupo vazio", () => {
  const lista = [{ name: "create_issue" }, { name: "get_issue" }, { name: "list_commits" }];
  const eLeitura = (f: { name: string }): boolean => /^(get|list)_/.test(f.name);
  assert.deepEqual(
    agruparPorTipo(lista, eLeitura).map((g) => [g.tipo, g.itens.map((f) => f.name)]),
    [["leitura", ["get_issue", "list_commits"]], ["escrita", ["create_issue"]]],
  );
  assert.deepEqual(agruparPorTipo([{ name: "get_x" }], eLeitura).map((g) => g.tipo), ["leitura"]);
  assert.deepEqual(agruparPorTipo([], eLeitura), []);
});

test("a contagem da conexão diz quantas ligadas, quantas de escrita e quantas ferramentas novas", () => {
  const catalogo = [{ nome: "gh", ferramentas: [{ name: "get_a" }, { name: "get_b" }, { name: "create_c" }, { name: "get_nova" }] }];
  const conexao = { connectionId: "github", leituraPadrao: "limitada" as const, tools: { "gh/get_a": true, "gh/get_b": false, "gh/create_c": true } };
  assert.deepEqual(contarDaConexao(conexao, catalogo), { total: 4, ligadas: 2, escrita: 1, novas: 1, conhecida: true });
  // Sem lista guardada não há total: só o que está marcado.
  assert.deepEqual(contarDaConexao(conexao, [{ nome: "gh", ferramentas: null }]), { total: 0, ligadas: 2, escrita: 0, novas: 0, conhecida: false });
  // Regra antiga: leitura sem escolha liga, e nada é "novo".
  const antiga = { tools: {} };
  assert.deepEqual(contarDaConexao(antiga, catalogo), { total: 4, ligadas: 3, escrita: 0, novas: 0, conhecida: true });
});

test("revisar as novas grava a escolha explícita, true ou false, e só então o aviso some", () => {
  const catalogo = [{ nome: "gh", ferramentas: [{ name: "get_a" }, { name: "create_b" }, { name: "get_nova" }, { name: "create_nova" }] }];
  const conexao = { connectionId: "github", leituraPadrao: "limitada" as const, tools: { "gh/get_a": true } };
  assert.equal(contarDaConexao(conexao, catalogo).novas, 3);
  // Escolher uma só deixa as outras no aviso.
  const umaEscolhida = { ...conexao, tools: revisarNovas(conexao, catalogo, { "gh/get_nova": true }, false) };
  assert.equal(contarDaConexao(umaEscolhida, catalogo).novas, 2);
  // Concluir a revisão grava `false` no que ficou sem resposta.
  const revisada = { ...conexao, tools: revisarNovas(conexao, catalogo, { "gh/get_nova": true }) };
  assert.deepEqual(revisada.tools, { "gh/get_a": true, "gh/create_b": false, "gh/get_nova": true, "gh/create_nova": false });
  assert.deepEqual(contarDaConexao(revisada, catalogo), { total: 4, ligadas: 2, escrita: 0, novas: 0, conhecida: true });
});
