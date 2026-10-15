import { before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb } from "../src/db/migrate.js";
import { McpRegistry } from "../src/mcp/registry.js";
import { McpService } from "../src/services/mcp-service.js";
import { SecretService } from "../src/services/secret-service.js";

before(() => {
  migrateDb();
});

function montar() {
  const secrets = new SecretService(mkdtempSync(join(tmpdir(), "locum-cred-gh-")));
  secrets.useBackend({
    available: () => true,
    encrypt: (plain) => Buffer.from(plain),
    decrypt: (blob) => blob.toString(),
  });
  return { mcp: new McpService(undefined, secrets), secrets };
}

const GITHUB = {
  name: "github",
  transport: "http",
  url: "https://api.githubcopilot.com/mcp/",
  headers: { Authorization: "${credential}" },
} as const;

async function cabecalho(mcp: McpService): Promise<string | undefined> {
  const config = (await mcp.enabledConfigs()).find((c) => c.name === "github");
  return config?.headers?.["Authorization"];
}

test("o token guardado no GitHub vai no cabeçalho do servidor MCP, com Bearer", async () => {
  const { mcp, secrets } = montar();
  secrets.set("source/github", "ghp_abc");
  await mcp.register(GITHUB);
  try {
    assert.equal(await cabecalho(mcp), "Bearer ghp_abc");
  } finally {
    await mcp.remove("github");
  }
});

test("o prefixo Bearer não é duplicado quando o token já vem com ele", async () => {
  const { mcp, secrets } = montar();
  secrets.set("source/github", "Bearer ghp_abc");
  await mcp.register(GITHUB);
  try {
    assert.equal(await cabecalho(mcp), "Bearer ghp_abc");
  } finally {
    await mcp.remove("github");
  }
});

test("a credencial própria do servidor vence a do GitHub", async () => {
  const { mcp, secrets } = montar();
  secrets.set("source/github", "ghp_da_conexao");
  await mcp.register(GITHUB);
  await mcp.setCredential("github", { campo: "Authorization", valor: "ghp_do_servidor" });
  try {
    assert.equal(await cabecalho(mcp), "Bearer ghp_do_servidor");
  } finally {
    await mcp.remove("github");
  }
});

test("servidor do GitHub cadastrado sem cabeçalho usa o token da conexão", async () => {
  const { mcp, secrets } = montar();
  secrets.set("source/github", "ghp_abc");
  await mcp.register({ name: "gh", transport: "http", url: "https://api.githubcopilot.com/mcp/" });
  try {
    const config = (await mcp.enabledConfigs()).find((c) => c.name === "gh");
    assert.equal(config?.headers?.["Authorization"], "Bearer ghp_abc");
  } finally {
    await mcp.remove("gh");
  }
});

test("sem credencial nenhuma, o teste diz onde colar o token em vez do 401 do servidor", async () => {
  const { mcp } = montar();
  const antes = process.env["GITHUB_TOKEN"];
  delete process.env["GITHUB_TOKEN"];
  await mcp.register(GITHUB);
  try {
    assert.equal(await mcp.credencialDoServidor("github"), "falta");
    const teste = await mcp.testConnection("github");
    assert.equal(teste.ok, false);
    assert.equal(teste.error, "falta a credencial de GitHub; cole o token em Conexões > GitHub");
    assert.doesNotMatch(teste.error ?? "", /Authorization/);
  } finally {
    if (antes !== undefined) process.env["GITHUB_TOKEN"] = antes;
    await mcp.remove("github");
  }
});

test("a falta da credencial vale para qualquer servidor com marcador, com o nome dele", async () => {
  const { mcp } = montar();
  await mcp.register({ name: "casa", transport: "http", url: "https://casa.test/mcp", headers: { "X-Api-Key": "${credential}" } });
  try {
    const teste = await mcp.testConnection("casa");
    assert.equal(teste.error, "falta a credencial de casa; cole o token em Conexões > casa");
  } finally {
    await mcp.remove("casa");
  }
});

test("servidor sem marcador de credencial não é barrado", async () => {
  const { mcp } = montar();
  await mcp.register({ name: "aberto", transport: "http", url: "https://aberto.test/mcp" });
  try {
    assert.equal(await mcp.credencialDoServidor("aberto"), "dispensa");
  } finally {
    await mcp.remove("aberto");
  }
});

test("a recusa de credencial manda para Conexões, e não para Configuração", async () => {
  const registro = McpRegistry.fromList([
    { name: "github", transport: "http", url: "http://127.0.0.1:1/mcp", scope: "read", idleTimeoutMs: 1000, credencialFaltando: undefined },
  ]);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
  try {
    await assert.rejects(registro.describeTools("github"), (e: Error) => {
      assert.match(e.message, /reconecte em Conexões > GitHub/);
      assert.doesNotMatch(e.message, /Configuração/);
      return true;
    });
  } finally {
    globalThis.fetch = original;
    await registro.closeAll();
  }
});
