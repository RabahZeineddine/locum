import assert from "node:assert/strict";
import { test } from "node:test";
import { McpRegistry } from "../src/mcp/registry.js";

test("servidor stdio que sai antes de responder leva o stderr para o erro", async () => {
  const registro = McpRegistry.fromList([
    {
      name: "quebrado",
      transport: "stdio",
      command: ["/bin/sh", "-c", "echo 'linha de aviso' >&2; echo 'token não encontrado' >&2; exit 78"],
      scope: "read",
      idleTimeoutMs: 1_000,
    },
  ]);
  try {
    await assert.rejects(registro.describeTools("quebrado"), /linha de aviso \| token não encontrado/);
  } finally {
    await registro.closeAll();
  }
});
