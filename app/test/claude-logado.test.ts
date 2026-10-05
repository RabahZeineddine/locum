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
