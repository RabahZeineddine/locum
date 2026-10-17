import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogoDeDestinos, destinoDoPasso, type RegistroDeConversa, REGISTRO_DE_CONVERSA } from "../src/acao/destino.js";
import { conversaEscolhida, destinoDoNo, gatilhoTrazMensagem, opcoesDoApp, paramsComDestino } from "../renderer/lib/destino-da-conversa.js";
import { lerRefDoTeams } from "../src/teams/ref.js";

test("as opções saem das listas que o registro declara para o app, no ref de cada um", () => {
  const teams = opcoesDoApp("teams", {
    chats: [[{ chatId: "19:a", label: "Ana", conta: "a@x.test" }]],
    canais: [[{ teamId: "T", teamName: "Equipe", channelId: "C", channelName: "Geral" }]],
  });
  assert.deepEqual(teams, [
    { ref: "chat/19:a", rotulo: "Ana", conta: "a@x.test" },
    { ref: "canal/T/C", rotulo: "Geral", grupo: "Equipe" },
  ]);
  assert.deepEqual(lerRefDoTeams(teams[1]!.ref), { tipo: "canal", teamId: "T", channelId: "C" });
  assert.deepEqual(opcoesDoApp("slack", { canais: [{ canais: [{ id: "C1", name: "geral", isPrivate: false }] }] }), [{ ref: "C1", rotulo: "#geral" }]);
  assert.deepEqual(opcoesDoApp("outro", {}), []);
});

test("a conta por onde a lista saiu vai junto com a conversa escolhida", () => {
  assert.deepEqual(conversaEscolhida("teams", { ref: "chat/1", rotulo: "Ana", conta: "a@x.test" }), { app: "teams", ref: "chat/1", rotulo: "Ana", conta: "a@x.test" });
  assert.deepEqual(conversaEscolhida("slack", { ref: "C1", rotulo: "#geral" }), { app: "slack", ref: "C1", rotulo: "#geral" });
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

/** Um app que ninguém conhece no código: só a declaração no registro. */
const COM_ZAP: RegistroDeConversa = {
  acoes: {
    ...REGISTRO_DE_CONVERSA.acoes,
    "zap.post": { app: "zap", efeito: "responder", destinos: ["evento", "fixo"] },
    "zap.react": { app: "zap", efeito: "reagir", destinos: ["evento"] },
  },
  apps: {
    ...REGISTRO_DE_CONVERSA.apps,
    zap: {
      app: "zap",
      gatilhos: ["zap-inbox"],
      refs: "Zap: the room id (from list_zap_rooms)",
      listas: [
        {
          id: "salas",
          canal: "connections.zapRooms",
          fonteMcp: "list_zap_rooms",
          opcoes: (dados) => (dados as { id: string; nome: string }[]).map((s) => ({ ref: s.id, rotulo: s.nome })),
        },
      ],
    },
  },
};

test("app novo, declarado só no registro, aparece na tela (lógica) e no MCP", () => {
  assert.deepEqual(opcoesDoApp("zap", { salas: [{ id: "r1", nome: "Plantão" }] }, COM_ZAP), [{ ref: "r1", rotulo: "Plantão" }]);
  assert.equal(gatilhoTrazMensagem("zap.post", ["zap-inbox"], COM_ZAP), true);
  assert.equal(gatilhoTrazMensagem("zap.post", ["teams-inbox"], COM_ZAP), false);
  assert.deepEqual(destinoDoPasso("zap.post", { destino: { tipo: "fixo", conversa: { app: "zap", ref: "r1" } } }, COM_ZAP.acoes).tipo, "fixo");
  assert.throws(() => destinoDoPasso("zap.react", { destino: { tipo: "novo" } }, COM_ZAP.acoes), /reação/);

  const catalogo = catalogoDeDestinos(COM_ZAP);
  assert.deepEqual(catalogo.porAcao["zap.post"], { app: "zap", efeito: "responder", destinos: ["evento", "fixo"] });
  assert.deepEqual(catalogo.porApp.zap, { gatilhos: ["zap-inbox"], refs: "Zap: the room id (from list_zap_rooms)", listas: ["list_zap_rooms"] });
  assert.deepEqual(catalogo.porApp.slack?.listas, ["list_slack_channels"]);
});
