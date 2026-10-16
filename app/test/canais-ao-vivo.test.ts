import { test } from "node:test";
import assert from "node:assert/strict";
import { AO_VIVO, READ_CHANNELS } from "../renderer/lib/bridge.js";

/** Cada leitura declara se acompanha o banco ao vivo; canal novo sem decisão falha aqui. */

test("todo canal de leitura declara se é ao vivo", () => {
  for (const canal of READ_CHANNELS) {
    assert.equal(typeof AO_VIVO[canal], "boolean", `${canal} não declarou AO_VIVO`);
  }
  assert.deepEqual(Object.keys(AO_VIVO).sort(), [...READ_CHANNELS].sort());
});

test("o que vai à rede, a processo ou ao disco fora do banco não é relido por aviso", () => {
  for (const canal of [
    "agents.templates",
    "github.ghAccounts",
    "claudeCode.status",
    "claudeSessions.list",
    "sessions.installedTerminals",
    "opencode.status",
    "claudeImport.origins",
  ] as const) {
    assert.equal(AO_VIVO[canal], false, canal);
  }
});

test("as leituras dos contadores do menu lateral são ao vivo", () => {
  for (const canal of ["agents.list", "library.profiles", "runs.list", "approvals.listPending"] as const) {
    assert.equal(AO_VIVO[canal], true, canal);
  }
});
