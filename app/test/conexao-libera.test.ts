import { test } from "node:test";
import assert from "node:assert/strict";
import { liberaDaConexao } from "../renderer/lib/conexao-libera.js";

test("Slack libera os gatilhos de mensagem e a ação de postar", () => {
  const l = liberaDaConexao("slack", { servidor: true });
  assert.deepEqual(l.gatilhos, ["slack-channel", "slack-inbox"]);
  assert.deepEqual(l.acoes, ["slack.post", "mcp.call"]);
});

test("GitHub libera o gatilho de pull request e nenhuma ação própria", () => {
  const l = liberaDaConexao("github", { servidor: false });
  assert.deepEqual(l.gatilhos, ["poll"]);
  assert.deepEqual(l.acoes, []);
});

test("Teams e Atlassian liberam o que a paleta amarra a eles", () => {
  assert.deepEqual(liberaDaConexao("teams", { servidor: false }), { gatilhos: ["teams-inbox"], acoes: ["teams.post"] });
  assert.deepEqual(liberaDaConexao("atlassian", { servidor: true }).acoes, ["tracker.create_issue", "mcp.call"]);
});

test("Shortcut abre tarefa pelo tracker, como a Atlassian", () => {
  assert.deepEqual(liberaDaConexao("shortcut", { servidor: true }).acoes, ["tracker.create_issue", "mcp.call"]);
});

test("serviço só de servidor MCP libera a ação genérica de chamar ferramenta, e nenhum gatilho", () => {
  assert.deepEqual(liberaDaConexao("notion", { servidor: true }), { gatilhos: [], acoes: ["mcp.call"] });
});

test("conexão sem servidor e sem nada na paleta não libera nada", () => {
  assert.deepEqual(liberaDaConexao("grafana-sem-servidor", { servidor: false }), { gatilhos: [], acoes: [] });
});
