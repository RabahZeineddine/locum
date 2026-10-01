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
import type { SettingsService } from "../src/services/settings-service.js";
import { SLACK_MCP_URL, SLACK_REDIRECT_URI, slackManifest } from "../src/services/slack-app.js";
import { SlackService } from "../src/services/slack-service.js";

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

/** Configuração em memória, para o Slack de um teste não vazar para o outro. */
function memoria(): SettingsService {
  const mapa = new Map<string, string>();
  return {
    get: async (k: string) => mapa.get(k),
    set: async (k: string, v: string) => void mapa.set(k, v),
    remove: async (k: string) => mapa.delete(k),
  } as unknown as SettingsService;
}

function montarSlack() {
  const secrets = new SecretService(mkdtempSync(join(tmpdir(), "locum-slack-")));
  secrets.useBackend({
    available: () => true,
    encrypt: (plain) => Buffer.from(plain),
    decrypt: (blob) => blob.toString(),
  });
  const mcp = new McpService(undefined, secrets);
  const settings = memoria();
  const slack = new SlackService(memoria());
  const pedidos: Array<{ name: string; client: unknown }> = [];
  let ligado = false;
  const oauth = {
    status: () => ({ connected: ligado, expiresAt: null, renewable: false }),
    connect: async (name: string, client: unknown) => {
      pedidos.push({ name, client });
      ligado = true;
      return { connected: true, expiresAt: null, renewable: false };
    },
    disconnect: async () => {
      ligado = false;
    },
  } as unknown as McpOAuthService;
  const servico = new ConnectionService({
    mcp,
    oauth,
    slack,
    settings,
    claudeCode: { status: async () => ({ registered: false, current: false }) } as unknown as ClaudeCodeService,
    github: { status: async () => ({ stored: false, env: false, identity: null }) } as unknown as GithubService,
  });
  return { servico, mcp, slack, pedidos };
}

test("Slack oficial conecta com o client id da pessoa e aponta a origem para as ferramentas oficiais", async () => {
  const { servico, mcp, slack, pedidos } = montarSlack();
  await slack.addChannel("C0CANAL");
  try {
    const conexao = await servico.connectSlack(" 123.456 ");
    assert.equal(conexao.state, "connected");
    assert.equal((await mcp.get("slack"))?.config.url, SLACK_MCP_URL);
    assert.equal(pedidos.length, 1);
    const pedido = pedidos[0]!.client as { clientId: string; redirectUri: string; scope: string };
    assert.equal(pedido.clientId, "123.456");
    assert.equal(pedido.redirectUri, SLACK_REDIRECT_URI);
    assert.match(pedido.scope, /channels:history/);

    const origem = await slack.get();
    assert.equal(origem.server, "slack");
    assert.equal(origem.tool, "slack_read_channel");
    assert.equal(origem.postTool, "slack_send_message");
    assert.equal(origem.textArg, "message");
    assert.deepEqual(origem.channels, ["C0CANAL"], "os canais observados continuam");

    const app = await servico.slackApp();
    assert.equal(app.clientId, "123.456");
    assert.equal(app.connected, true);

    const desligada = await servico.disconnectSlack();
    assert.equal(desligada.state, "available");
    assert.equal(await mcp.get("slack"), undefined);
    assert.equal((await slack.get()).server, null);
    assert.equal((await servico.slackApp()).clientId, "123.456", "o client id fica para reconectar");
  } finally {
    if ((await mcp.get("slack")) !== undefined) await mcp.remove("slack");
  }
});

test("client id fora do formato do Slack é recusado antes de abrir o navegador", async () => {
  const { servico, pedidos } = montarSlack();
  await assert.rejects(servico.connectSlack("nao-e-client-id"), /formato/);
  assert.equal(pedidos.length, 0);
});

test("manifesto do Slack é cliente público com PKCE e retorno no loopback", () => {
  const manifesto = slackManifest() as {
    oauth_config: { pkce_enabled: boolean; redirect_urls: string[]; scopes: { user: string[] } };
  };
  assert.equal(manifesto.oauth_config.pkce_enabled, true);
  assert.deepEqual(manifesto.oauth_config.redirect_urls, [SLACK_REDIRECT_URI]);
  assert.ok(manifesto.oauth_config.scopes.user.includes("chat:write"));
});
