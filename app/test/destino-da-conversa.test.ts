import { test } from "node:test";
import assert from "node:assert/strict";
import { destinoDoNo, gatilhoTrazMensagem, opcoesDeConversa, paramsComDestino } from "../renderer/lib/destino-da-conversa.js";
import { lerRefDoTeams } from "../src/teams/ref.js";

test("as opções saem das listas do gatilho, no ref de cada app", () => {
  const teams = opcoesDeConversa("teams", {
    teamsChats: [{ chatId: "19:a", label: "Ana" }],
    teamsCanais: [{ teamId: "T", teamName: "Equipe", channelId: "C", channelName: "Geral" }],
  });
  assert.deepEqual(teams, [
    { ref: "chat/19:a", rotulo: "Ana" },
    { ref: "canal/T/C", rotulo: "Geral", grupo: "Equipe" },
  ]);
  assert.deepEqual(lerRefDoTeams(teams[1]!.ref), { tipo: "canal", teamId: "T", channelId: "C" });
  assert.deepEqual(opcoesDeConversa("slack", { slackCanais: [{ id: "C1", name: "geral", isPrivate: false }] }), [{ ref: "C1", rotulo: "#geral" }]);
  assert.deepEqual(opcoesDeConversa("outro", {}), []);
});

test("o passo sem destino mostra o evento, e o evento sai do passo ao ser escolhido", () => {
  assert.deepEqual(destinoDoNo("teams.post", { x: 1 }), { tipo: "evento" });
  const fixo = { tipo: "fixo", conversa: { app: "slack", ref: "C1", rotulo: "#geral" } } as const;
  const params = paramsComDestino({ x: 1 }, fixo);
  assert.deepEqual(params, { x: 1, destino: fixo });
  assert.deepEqual(destinoDoNo("slack.post", params), fixo);
  assert.deepEqual(paramsComDestino(params, { tipo: "evento" }), { x: 1 });
});

test("só gatilho de conversa do mesmo app traz a mensagem a responder", () => {
  assert.equal(gatilhoTrazMensagem("teams.post", ["teams-inbox"]), true);
  assert.equal(gatilhoTrazMensagem("slack.react", ["slack-inbox"]), true);
  assert.equal(gatilhoTrazMensagem("slack.post", ["manual", "cron", "teams-inbox"]), false);
  assert.equal(gatilhoTrazMensagem("github.review", ["slack-inbox"]), false);
});
