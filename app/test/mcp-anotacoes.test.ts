import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ehLeituraDa } from "../src/config/leitura.js";
import { McpRegistry } from "../src/mcp/registry.js";

const SERVIDOR = fileURLToPath(new URL("../src/fixtures/mcp-fixture-server.ts", import.meta.url));

test("o catálogo do servidor traz o que ele anotou de cada ferramenta, e a anotação vence o nome", async () => {
  const registro = McpRegistry.fromList([
    { name: "fx", transport: "stdio", command: [process.execPath, "--import", "tsx", SERVIDOR], scope: "read", idleTimeoutMs: 1_000 },
  ]);
  try {
    const porNome = new Map((await registro.describeTools("fx")).map((t) => [t.name, t]));
    assert.equal(porNome.get("pid")?.readOnlyHint, true);
    assert.equal(porNome.get("fail")?.destructiveHint, true);
    assert.equal(porNome.get("echo")?.readOnlyHint, undefined);
    // `pid` não tem verbo de leitura no nome, e `fail` também não: só a anotação separa os dois.
    assert.equal(ehLeituraDa(porNome.get("pid")!), true);
    assert.equal(ehLeituraDa(porNome.get("fail")!), false);
  } finally {
    await registro.closeAll();
  }
});
