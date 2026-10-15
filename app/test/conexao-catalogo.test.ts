import { test } from "node:test";
import assert from "node:assert/strict";
import { conexaoDoServidor } from "../src/services/conexao-catalogo.js";

const dono = (c: { name: string; url?: string; command?: string[] }) => conexaoDoServidor(c)?.id;

test("o servidor com o id do catálogo é do item", () => {
  assert.equal(dono({ name: "github" }), "github");
  assert.equal(dono({ name: "Slack" }), "slack");
});

test("o host do endereço identifica o item, qualquer que seja o nome", () => {
  assert.equal(dono({ name: "gh", url: "https://api.githubcopilot.com/mcp/" }), "github");
  assert.equal(dono({ name: "chat", url: "https://mcp.slack.com/mcp" }), "slack");
  assert.equal(dono({ name: "design", url: "https://mcp.figma.com/mcp" }), "figma");
  assert.equal(dono({ name: "jira", url: "https://mcp.atlassian.com/v1/mcp" }), "atlassian");
  assert.equal(dono({ name: "apm", url: "https://mcp.newrelic.com/mcp" }), "newrelic");
});

test("o ms365 e o pacote do Softeria são do Teams", () => {
  assert.equal(dono({ name: "ms365" }), "teams");
  assert.equal(dono({ name: "microsoft", command: ["npx", "-y", "@softeria/ms-365-mcp-server@latest"] }), "teams");
});

test("servidor sem relação com o catálogo não é de item nenhum", () => {
  assert.equal(dono({ name: "locum-fixture", url: "https://exemplo.test/mcp" }), undefined);
  assert.equal(dono({ name: "x", url: "isto nao e url" }), undefined);
});
