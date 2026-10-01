import { before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb } from "../src/db/migrate.js";
import type { ClaudeCodeService } from "../src/services/claude-code-service.js";
import { CATALOG, ConnectionService } from "../src/services/connection-service.js";
import type { GithubService } from "../src/services/github-service.js";
import type { McpOAuthService } from "../src/services/mcp-oauth-service.js";
import { McpService } from "../src/services/mcp-service.js";
import { SecretService } from "../src/services/secret-service.js";
import type { SlackService } from "../src/services/slack-service.js";
import type { TrackerService } from "../src/services/tracker-service.js";

before(() => {
  migrateDb();
});

/**
 * Vitrine com cadastro de verdade num cofre de rascunho, e o resto de mentira.
 * O OAuth falso grava o que o de verdade gravaria, para o estado seguinte bater.
 */
function montar(sonda = { oauth: true, registration: true }) {
  const secrets = new SecretService(mkdtempSync(join(tmpdir(), "locum-vitrine-")));
  secrets.useBackend({
    available: () => true,
    encrypt: (plain) => Buffer.from(plain),
    decrypt: (blob) => blob.toString(),
  });
  const mcp = new McpService(undefined, secrets);
  const ligados = new Set<string>();
  const chamadas: string[] = [];
  const oauth = {
    probe: async () => sonda,
    status: (name: string) => ({ connected: ligados.has(name), expiresAt: null, renewable: false }),
    connect: async (name: string) => {
      chamadas.push(`connect:${name}`);
      ligados.add(name);
      return { connected: true, expiresAt: null, renewable: false };
    },
    disconnect: async (name: string) => {
      chamadas.push(`disconnect:${name}`);
      ligados.delete(name);
    },
  } as unknown as McpOAuthService;

  const servico = new ConnectionService({
    mcp,
    oauth,
    claudeCode: { status: async () => ({ registered: false, current: false }) } as unknown as ClaudeCodeService,
    github: { status: async () => ({ stored: true, env: false, identity: { login: "octo" } }) } as unknown as GithubService,
    slack: { get: async () => ({ server: null }) } as unknown as SlackService,
    trackers: { list: async () => [] } as unknown as TrackerService,
  });
  return { servico, mcp, chamadas };
}

test("o catálogo inteiro aparece, com o estado de cada um", async () => {
  const { servico } = montar();
  const lista = await servico.list();
  for (const entrada of CATALOG) assert.ok(lista.some((c) => c.id === entrada.id), entrada.id);

  const porId = new Map(lista.map((c) => [c.id, c]));
  assert.equal(porId.get("github")?.state, "connected");
  assert.equal(porId.get("github")?.account, "octo");
  assert.equal(porId.get("teams")?.state, "soon");
  assert.equal(porId.get("claude-code")?.state, "available");
});

test("conectar servidor do catálogo cadastra pelo id e autoriza", async () => {
  const { servico, mcp, chamadas } = montar();
  const id = "linear";
  try {
    const conexao = await servico.connect(id);
    assert.equal(conexao.state, "connected");
    assert.deepEqual(chamadas, [`connect:${id}`]);
    assert.equal((await mcp.get(id))?.config.url, CATALOG.find((c) => c.id === id)?.url);

    const desligada = await servico.disconnect(id);
    assert.equal(desligada?.state, "available");
    assert.equal(await mcp.get(id), undefined);
  } finally {
    await mcp.remove(id);
  }
});

test("servidor próprio sem OAuth só entra no cadastro", async () => {
  const { servico, mcp, chamadas } = montar({ oauth: false, registration: false });
  const name = `proprio-${Date.now()}`;
  try {
    const conexao = await servico.addCustom({ name, url: "https://exemplo.test/mcp" });
    assert.equal(conexao.custom, true);
    assert.equal(conexao.state, "connected");
    assert.deepEqual(chamadas, []);
  } finally {
    await mcp.remove(name);
  }
});

test("servidor próprio com OAuth sem registro automático é recusado antes de cadastrar", async () => {
  const { servico, mcp } = montar({ oauth: true, registration: false });
  const name = `semdcr-${Date.now()}`;
  await assert.rejects(servico.addCustom({ name, url: "https://exemplo.test/mcp" }), /registro automático/);
  assert.equal(await mcp.get(name), undefined);
});

test("endereço sem https e nome do catálogo são recusados", async () => {
  const { servico } = montar();
  await assert.rejects(servico.addCustom({ name: "x", url: "http://exemplo.test/mcp" }), /https/);
  await assert.rejects(servico.addCustom({ name: "linear", url: "https://exemplo.test/mcp" }), /catálogo/);
});
