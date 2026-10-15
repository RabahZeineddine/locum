import { test } from "node:test";
import assert from "node:assert/strict";
import { agruparPorArea, areaDaFerramenta, filtrarFerramentas } from "../renderer/lib/ferramentas-do-agent.js";

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
