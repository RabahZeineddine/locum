import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeRegistration } from "../src/mcp-server/config-tools.js";
import { HIDDEN_VALUE, redactServerConfig } from "../src/mcp-server/redact.js";
import { McpService } from "../src/services/mcp-service.js";
import { SecretService } from "../src/services/secret-service.js";
import { bancoDeTeste } from "./helpers/db.js";

function montar() {
  const secrets = new SecretService(mkdtempSync(join(tmpdir(), "locum-registro-")));
  secrets.useBackend({
    available: () => true,
    encrypt: (plain) => Buffer.from(plain),
    decrypt: (blob) => blob.toString(),
  });
  secrets.set("mcp/gh", "TOKEN-SECRETO");
  return new McpService(bancoDeTeste(), secrets);
}

const oauth = {
  name: "gh",
  transport: "http" as const,
  url: "https://api.example/mcp",
  headers: { Authorization: "${credential}" },
};

test("regravar com outro endereço desfaz o vínculo da credencial", async () => {
  const mcp = montar();
  await mcp.register(oauth);
  await mcp.setCredentialRef("gh", "mcp/gh");

  await mcp.register({ ...oauth, url: "https://outro.example/coleta" });
  const [config] = await mcp.enabledConfigs();
  assert.equal((await mcp.get("gh"))?.credentialRef ?? null, null);
  assert.notEqual(config?.headers?.Authorization, "TOKEN-SECRETO");
});

test("regravar com o mesmo destino mantém a credencial", async () => {
  const mcp = montar();
  await mcp.register(oauth);
  await mcp.setCredentialRef("gh", "mcp/gh");

  await mcp.register({ ...oauth, scope: "write" });
  const [config] = await mcp.enabledConfigs();
  assert.equal(config?.headers?.Authorization, "TOKEN-SECRETO");
});

test("atualização pela ferramenta herda o que não veio, e transporte novo não herda endereço", () => {
  const atual = { ...oauth, scope: "write" as const, idleTimeoutMs: 1000 };
  assert.deepEqual(mergeRegistration(atual, { name: "gh", transport: "http", scope: "read" }), {
    name: "gh",
    transport: "http",
    scope: "read",
    idleTimeoutMs: 1000,
    url: oauth.url,
    headers: oauth.headers,
  });
  assert.deepEqual(mergeRegistration(atual, { name: "gh", transport: "stdio", command: ["srv"] }), {
    name: "gh",
    transport: "stdio",
    command: ["srv"],
    scope: "write",
    idleTimeoutMs: 1000,
  });
  assert.deepEqual(mergeRegistration(undefined, { name: "x", transport: "stdio", command: ["a"] }), {
    name: "x",
    transport: "stdio",
    command: ["a"],
  });
});

test("valor literal de env e headers sai oculto, e o marcador da credencial sai como está", () => {
  const visto = redactServerConfig({
    name: "gh",
    transport: "http",
    url: "https://mcp.exemplo.dev",
    headers: { Authorization: "${credential}", "X-Api-Key": "abc123" },
    env: { TOKEN: "segredo" },
    scope: "read",
    idleTimeoutMs: 300_000,
  });
  assert.deepEqual(visto.headers, { Authorization: "${credential}", "X-Api-Key": HIDDEN_VALUE });
  assert.deepEqual(visto.env, { TOKEN: HIDDEN_VALUE });
  assert.equal(visto.url, "https://mcp.exemplo.dev");
});

test("atualização que devolve o valor oculto mantém o cadastrado, e chave oculta nova cai fora", () => {
  const atual = {
    name: "gh",
    transport: "stdio" as const,
    command: ["gh-mcp"],
    env: { TOKEN: "segredo", REGIAO: "sa" },
    scope: "read" as const,
    idleTimeoutMs: 300_000,
  };
  const junto = mergeRegistration(atual, {
    name: "gh",
    transport: "stdio",
    env: { TOKEN: HIDDEN_VALUE, REGIAO: "us", NOVA: HIDDEN_VALUE },
  });
  assert.deepEqual(junto.env, { TOKEN: "segredo", REGIAO: "us" });
});
