import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeArgs, mcpConfigJson } from "../src/runtimes/claude-code.js";
import type { McpServerConfig } from "../src/config/types.js";
import type { RuntimeRequest } from "../src/runtimes/types.js";

const pedido = (extra: Partial<RuntimeRequest> = {}): RuntimeRequest => ({
  provider: "claude-code",
  model: "claude-sonnet-5",
  prompt: "triagem",
  tools: {},
  maxSteps: 4,
  ...extra,
});

const fixture = new Map<string, McpServerConfig>([
  ["locum-fixture", { name: "locum-fixture", transport: "stdio", command: ["npx", "tsx", "fixture.ts"] } as McpServerConfig],
]);

const valorDe = (args: string[], flag: string) => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};

test("passo sem servidor não herda os servidores MCP da máquina", () => {
  const args = claudeArgs(pedido());
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args.includes("--mcp-config"), false);
});

test("passo com servidor usa só os servidores do passo", () => {
  const args = claudeArgs(pedido({ mcpServers: ["locum-fixture"] }), "/tmp/mcp.json");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(valorDe(args, "--mcp-config"), "/tmp/mcp.json");
  const config = JSON.parse(mcpConfigJson(["locum-fixture"], fixture)) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(Object.keys(config.mcpServers), ["locum-fixture"]);
});

test("a credencial do servidor não aparece nos argumentos do processo", () => {
  const comSegredo = new Map<string, McpServerConfig>([
    ["gh", { name: "gh", transport: "http", url: "https://mcp.exemplo.dev", headers: { Authorization: "Bearer SEGREDO" }, scope: "read", idleTimeoutMs: 1 }],
  ]);
  assert.match(mcpConfigJson(["gh"], comSegredo), /SEGREDO/);
  const args = claudeArgs(pedido({ mcpServers: ["gh"] }), "/tmp/mcp.json");
  assert.equal(args.some((a) => a.includes("SEGREDO")), false);
});

test("nenhuma fonte de configuração pessoal é carregada", () => {
  // Vazio tira usuário, projeto e local: sem hooks, regras e plugins da máquina.
  assert.equal(valorDe(claudeArgs(pedido()), "--setting-sources"), "");
});

test("execução não grava sessão no histórico pessoal", () => {
  assert.ok(claudeArgs(pedido()).includes("--no-session-persistence"));
});

test("não usa --bare, que derruba o login de assinatura", () => {
  assert.equal(claudeArgs(pedido()).includes("--bare"), false);
});
