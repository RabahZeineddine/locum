import { after, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { McpServerConfig } from "../src/config/types.js";
import { McpRegistry } from "../src/mcp/registry.js";

const SERVIDOR = fileURLToPath(new URL("../src/fixtures/mcp-fixture-server.ts", import.meta.url));

const registro = McpRegistry.fromList([
  McpServerConfig.parse({
    name: "brinquedo",
    transport: "stdio",
    command: [process.execPath, "--import", "tsx", SERVIDOR],
    env: { PATH: process.env.PATH ?? "" },
    idleTimeoutMs: 100,
  }),
]);
after(() => registro.closeAll());

test("a escrita pedida para confirmar volta marcada para aprovação, e a de leitura não entra por aí", async () => {
  const { tools, release } = await registro.toolsComAprovacao([{ server: "brinquedo", tool: "echo", class: "external_write" }]);
  try {
    assert.deepEqual(Object.keys(tools), ["brinquedo__echo"]);
    assert.equal(tools["brinquedo__echo"]?.needsApproval, true);
  } finally {
    release();
  }

  await assert.rejects(
    registro.toolsComAprovacao([{ server: "brinquedo", tool: "pid", class: "read" }]),
    /so escrita externa/,
  );
});

test("a escrita sem aprovação continua recusada em toolsFor", async () => {
  await assert.rejects(registro.toolsFor([{ server: "brinquedo", tool: "echo", class: "external_write" }]), /escrita externa/);
});
