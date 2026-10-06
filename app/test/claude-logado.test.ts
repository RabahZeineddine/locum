import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeLogado } from "../src/providers/registry.js";

const devolve = (saida: string | Error) =>
  (() => {
    if (saida instanceof Error) throw saida;
    return saida;
  }) as never;

test("Claude Code instalado sem login não conta como assinatura disponível", () => {
  assert.equal(claudeLogado("claude", devolve('{"loggedIn": false, "authMethod": "none"}')), false);
  assert.equal(claudeLogado("claude", devolve('{"loggedIn": true, "authMethod": "claude.ai"}')), true);
  // Versão sem `auth status`: segue como antes, valendo o binário.
  assert.equal(claudeLogado("claude", devolve(new Error("unknown command"))), true);
});

test("conta do claude.ai sem plano pago também não conta", () => {
  assert.equal(claudeLogado("claude", devolve('{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": null}')), false);
  assert.equal(claudeLogado("claude", devolve('{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "free"}')), false);
  assert.equal(claudeLogado("claude", devolve('{"loggedIn": true, "authMethod": "claude.ai", "subscriptionType": "pro"}')), true);
  // Chave de API ou console não tem plano de assinatura e roda mesmo assim.
  assert.equal(claudeLogado("claude", devolve('{"loggedIn": true, "authMethod": "console", "subscriptionType": null}')), true);
});
