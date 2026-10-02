import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeRuntime } from "../src/runtimes/claude-code.js";

test("o runtime chama o claude pelo caminho absoluto achado, e não pelo nome", async () => {
  // Um `claude` fora do PATH, como o de `~/.claude/local`, que só existe como
  // alias do `.zshrc`. Pelo nome, o processo não acharia.
  const pasta = mkdtempSync(join(tmpdir(), "locum-claude-"));
  const falso = join(pasta, "claude");
  writeFileSync(
    falso,
    `#!/bin/sh\necho '{"result":"oi","usage":{"input_tokens":3,"output_tokens":2}}'\n`,
  );
  chmodSync(falso, 0o755);

  const runtime = new ClaudeCodeRuntime(new Map(), async () => falso);
  const resposta = await runtime.run({ prompt: "olá", model: "sonnet", tools: {} } as never);
  assert.equal(resposta.text, "oi");
  assert.equal(resposta.promptTokens, 3);
  assert.equal(resposta.billable, false);
});
