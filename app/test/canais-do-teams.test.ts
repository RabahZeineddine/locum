import { test } from "node:test";
import assert from "node:assert/strict";
import { organizarCanais } from "../renderer/lib/canais-do-teams.js";

const canal = (teamId: string, teamName: string, channelId: string, channelName: string) => ({ teamId, teamName, channelId, channelName });

const todos = [
  canal("t1", "Akad Seguros", "c1", "inc-0431"),
  canal("t1", "Akad Seguros", "c2", "geral"),
  canal("t2", "Plataforma", "c3", "deploys"),
  canal("t2", "Plataforma", "c4", "inc-0500"),
  canal("t3", "Zeta", "c5", "geral"),
];

test("agrupa por equipe, com as equipes de canal marcado primeiro e o marcado no topo do grupo", () => {
  const grupos = organizarCanais(todos, new Set(["t2/c4"]), "");
  assert.deepEqual(grupos.map((g) => g.teamName), ["Plataforma", "Akad Seguros", "Zeta"]);
  assert.deepEqual(grupos[0]!.canais.map((c) => c.channelName), ["inc-0500", "deploys"]);
  assert.equal(grupos[0]!.marcados, 1);
});

test("a busca olha equipe e canal, sem diferenciar maiúscula, e esconde grupo sem resultado", () => {
  assert.deepEqual(organizarCanais(todos, new Set(), "INC").map((g) => [g.teamName, g.canais.length]), [["Akad Seguros", 1], ["Plataforma", 1]]);
  assert.deepEqual(organizarCanais(todos, new Set(), "zeta").map((g) => g.canais.length), [1]);
  assert.deepEqual(organizarCanais(todos, new Set(), "nada"), []);
});

test("sem marcado, as equipes ficam em ordem alfabética", () => {
  assert.deepEqual(organizarCanais(todos, new Set(), "").map((g) => g.teamName), ["Akad Seguros", "Plataforma", "Zeta"]);
});

test("chats: a busca olha o rótulo e os marcados vêm primeiro", async () => {
  const { organizarChats } = await import("../renderer/lib/chats-do-teams.js");
  const lista = [
    { chatId: "1", label: "Bia Souza", chatType: "oneOnOne" as const },
    { chatId: "2", label: "Revisões de PR", chatType: "group" as const },
    { chatId: "3", label: "Ana Lima", chatType: "oneOnOne" as const },
  ];
  assert.deepEqual(organizarChats(lista, new Set(["2"]), "").map((c) => c.chatId), ["2", "3", "1"]);
  assert.deepEqual(organizarChats(lista, new Set(), " lima ").map((c) => c.chatId), ["3"]);
});
