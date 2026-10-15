import { before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb } from "../src/db/migrate.js";
import { CATALOG, ConnectionService } from "../src/services/connection-service.js";
import type { GithubService } from "../src/services/github-service.js";
import type { McpOAuthService } from "../src/services/mcp-oauth-service.js";
import { McpService } from "../src/services/mcp-service.js";
import { SecretService } from "../src/services/secret-service.js";
import type { SlackService } from "../src/services/slack-service.js";

before(() => {
  migrateDb();
});

/** Serviço com cadastro de verdade e OAuth falso, que só sabe quem está autorizado. */
function montar(autorizados: string[] = [], trackers: { kind: string; enabled: boolean }[] = []) {
  const secrets = new SecretService(mkdtempSync(join(tmpdir(), "locum-estado-")));
  secrets.useBackend({
    available: () => true,
    encrypt: (plain) => Buffer.from(plain),
    decrypt: (blob) => blob.toString(),
  });
  const mcp = new McpService(undefined, secrets);
  const oauth = {
    status: (name: string) => ({ connected: autorizados.includes(name), expiresAt: null, renewable: false }),
  } as unknown as McpOAuthService;
  const servico = new ConnectionService({
    mcp,
    oauth,
    github: { status: async () => ({ stored: false, env: false, identity: null }) } as unknown as GithubService,
    slack: { get: async () => ({ server: null }) } as unknown as SlackService,
    trackers: async () => trackers,
  });
  return { servico, mcp };
}

const achar = async (servico: ConnectionService, id: string) => (await servico.list()).find((c) => c.id === id);

test("Claude Code e opencode não são conexões: são o Locum dentro da ferramenta de código", async () => {
  const { servico } = montar();
  const ids = (await servico.list()).map((c) => c.id);
  assert.ok(!ids.includes("claude-code"));
  assert.ok(!ids.includes("opencode"));
  assert.ok(!CATALOG.some((c) => c.id === "claude-code" || c.id === "opencode"));
});

test("serviço do catálogo autorizado e sem falha está ok, sem motivo", async () => {
  const { servico, mcp } = montar(["notion"]);
  await mcp.register({ name: "notion", transport: "http", url: "https://mcp.notion.com/mcp" });
  try {
    const c = await achar(servico, "notion");
    assert.equal(c?.state, "connected");
    assert.equal(c?.reason, null);
    assert.equal(c?.detail, null);
  } finally {
    await mcp.remove("notion");
  }
});

test("sem autorização pede atenção, e dá o motivo", async () => {
  const { servico, mcp } = montar([]);
  await mcp.register({ name: "linear", transport: "http", url: "https://mcp.linear.app/mcp" });
  try {
    const c = await achar(servico, "linear");
    assert.equal(c?.state, "attention");
    assert.equal(c?.reason, "needs-auth");
  } finally {
    await mcp.remove("linear");
  }
});

test("credencial recusada na última conexão pede atenção, não erro", async () => {
  const { servico, mcp } = montar(["figma"]);
  await mcp.register({ name: "figma", transport: "http", url: "https://mcp.figma.com/mcp" });
  await mcp.recordConnection("figma", { ok: false, error: "HTTP 401: Unauthorized" });
  try {
    const c = await achar(servico, "figma");
    assert.equal(c?.state, "attention");
    assert.equal(c?.reason, "needs-auth");
  } finally {
    await mcp.remove("figma");
  }
});

test("falha depois do último sucesso vira erro com o texto da falha", async () => {
  const { servico, mcp } = montar(["sentry"]);
  await mcp.register({ name: "sentry", transport: "http", url: "https://mcp.sentry.dev/mcp" });
  await mcp.recordConnection("sentry", { ok: true }, new Date(1_000));
  await mcp.recordConnection("sentry", { ok: false, error: "connect ETIMEDOUT" }, new Date(2_000));
  try {
    const c = await achar(servico, "sentry");
    assert.equal(c?.state, "error");
    assert.equal(c?.reason, "failing");
    assert.equal(c?.detail, "connect ETIMEDOUT");

    // Voltou a responder: o erro some.
    await mcp.recordConnection("sentry", { ok: true }, new Date(3_000));
    assert.equal((await achar(servico, "sentry"))?.state, "connected");
  } finally {
    await mcp.remove("sentry");
  }
});

test("servidor desligado pede atenção com o motivo", async () => {
  const { servico, mcp } = montar(["asana"]);
  await mcp.register({ name: "asana", transport: "http", url: "https://mcp.asana.com/v2/mcp" });
  await mcp.setEnabled("asana", false);
  try {
    const c = await achar(servico, "asana");
    assert.equal(c?.state, "attention");
    assert.equal(c?.reason, "disabled");
  } finally {
    await mcp.remove("asana");
  }
});

test("servidor próprio entra na mesma lista, marcado como personalizado, com a saúde dele", async () => {
  const { servico, mcp } = montar();
  const name = `casa-${Date.now()}`;
  await mcp.register({ name, transport: "stdio", command: ["node", "-e", "0"] });
  await mcp.recordConnection(name, { ok: false, error: "spawn ENOENT" });
  try {
    const c = await achar(servico, name);
    assert.equal(c?.custom, true);
    assert.equal(c?.state, "error");
    assert.equal(c?.detail, "spawn ENOENT");
  } finally {
    await mcp.remove(name);
  }
});

test("quantas ferramentas a conexão tem vem da última lista guardada, sem subir o servidor", async () => {
  const { servico, mcp } = montar(["notion"]);
  await mcp.register({ name: "notion", transport: "http", url: "https://mcp.notion.com/mcp" });
  mcp.cachedTools = async () => ({
    at: 1,
    tools: [
      { name: "search", description: "", estimatedTokens: 10 },
      { name: "create_page", description: "", estimatedTokens: 10 },
    ],
  });
  try {
    assert.equal((await achar(servico, "notion"))?.toolCount, 2);
    assert.equal((await achar(servico, "figma"))?.toolCount, null);
  } finally {
    await mcp.remove("notion");
  }
});

test("tracker cadastrado conta como conexão, mesmo sem servidor MCP", async () => {
  const { servico } = montar([], [
    { kind: "jira", enabled: true },
    { kind: "shortcut", enabled: false },
    { kind: "github-issues", enabled: true },
  ]);

  const atlassian = await achar(servico, "atlassian");
  assert.equal(atlassian?.state, "connected");
  assert.equal(atlassian?.trackers, 1);
  assert.equal(atlassian?.mcp, false);

  // Tracker desligado não conecta.
  const shortcut = await achar(servico, "shortcut");
  assert.equal(shortcut?.state, "available");
  assert.equal(shortcut?.trackers, 0);

  // O GitHub Issues acende o GitHub, que sem token estaria disponível.
  assert.equal((await achar(servico, "github"))?.state, "connected");
});

test("com servidor MCP e tracker, vale o estado do servidor", async () => {
  const { servico, mcp } = montar([], [{ kind: "jira-atlassian", enabled: true }]);
  await mcp.register({ name: "atlassian", transport: "http", url: "https://mcp.atlassian.com/v1/mcp" });
  try {
    const atlassian = await achar(servico, "atlassian");
    assert.equal(atlassian?.state, "attention");
    assert.equal(atlassian?.reason, "needs-auth");
    assert.equal(atlassian?.trackers, 1);
    assert.equal(atlassian?.mcp, true);
  } finally {
    await mcp.remove("atlassian");
  }
});
