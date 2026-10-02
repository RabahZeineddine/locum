import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "../src/config/types.js";
import { CODEX_DEFAULT_MODEL, CodexRuntime, codexArgs, readCodexEvents } from "../src/runtimes/codex.js";
import type { RuntimeRequest } from "../src/runtimes/types.js";

const pedido = (extra: Partial<RuntimeRequest> = {}): RuntimeRequest => ({
  provider: "codex",
  model: CODEX_DEFAULT_MODEL,
  prompt: "triagem",
  tools: {},
  maxSteps: 4,
  ...extra,
});

const fixture = new Map<string, McpServerConfig>([
  [
    "locum-fixture",
    { name: "locum-fixture", transport: "stdio", command: ["npx", "tsx", "fixture.ts"], env: { TOKEN: "x" } } as unknown as McpServerConfig,
  ],
  ["remoto", { name: "remoto", transport: "http", url: "https://exemplo.com/mcp" } as McpServerConfig],
]);

const pasta = { pasta: "/tmp/vazia" };

test("codex roda isolado: sem config pessoal, sem sessão gravada e só leitura", () => {
  const args = codexArgs(pedido(), fixture, pasta);
  assert.equal(args[0], "exec");
  for (const flag of ["--json", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check"]) {
    assert.ok(args.includes(flag), flag);
  }
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(args[args.indexOf("--cd") + 1], "/tmp/vazia");
  assert.equal(args.at(-1), "-", "o prompt vai pela entrada padrão");
  assert.equal(args.includes("-c"), false, "passo sem servidor não sobe servidor nenhum");
  assert.equal(args.includes("--model"), false, "o modelo padrão fica com o Codex");
});

test("codex recebe só os servidores do passo, com as ferramentas marcadas", () => {
  const args = codexArgs(
    pedido({ model: "gpt-x", mcpServers: ["locum-fixture"], tools: { "locum-fixture__ler": {} as never } }),
    fixture,
    pasta,
  );
  assert.equal(args[args.indexOf("--model") + 1], "gpt-x");
  const overrides = args.filter((_, i) => args[i - 1] === "-c");
  assert.deepEqual(overrides, [
    'mcp_servers.locum-fixture.command="npx"',
    'mcp_servers.locum-fixture.args=["tsx","fixture.ts"]',
    'mcp_servers.locum-fixture.env={"TOKEN"="x"}',
    'mcp_servers.locum-fixture.enabled_tools=["ler"]',
  ]);
  assert.ok(!overrides.some((o) => o.includes("remoto")));
});

test("servidor remoto entra pelo endereço", () => {
  const args = codexArgs(pedido({ mcpServers: ["remoto"] }), fixture, pasta);
  assert.ok(args.includes('mcp_servers.remoto.url="https://exemplo.com/mcp"'));
  assert.ok(args.includes("mcp_servers.remoto.enabled_tools=[]"));
});

test("nome de servidor que quebraria a chave do -c é recusado", () => {
  const ruim = new Map<string, McpServerConfig>([
    ["a.b", { name: "a.b", transport: "http", url: "https://exemplo.com" } as McpServerConfig],
  ]);
  assert.throws(() => codexArgs(pedido({ mcpServers: ["a.b"] }), ruim, pasta), /não aceita/);
});

test("eventos do codex viram texto, uso e ferramentas", () => {
  const linhas = [
    { type: "thread.started", thread_id: "t" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "1", type: "mcp_tool_call", server: "gh", tool: "ler", status: "completed" } },
    { type: "item.completed", item: { id: "2", type: "agent_message", text: "rascunho" } },
    { type: "item.completed", item: { id: "3", type: "agent_message", text: "final" } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } },
  ];
  const lido = readCodexEvents(["aviso solto", ...linhas.map((l) => JSON.stringify(l))].join("\n"));
  assert.equal(lido.text, "final");
  assert.equal(lido.promptTokens, 100);
  assert.equal(lido.cacheReadTokens, 40);
  assert.equal(lido.completionTokens, 7);
  assert.deepEqual(lido.toolsUsed, ["gh__ler"]);
  assert.equal(lido.error, undefined);

  const falho = readCodexEvents(JSON.stringify({ type: "turn.failed", error: { message: "quota" } }));
  assert.equal(falho.error, "quota");
});

/** Um `codex` de mentira que guarda o que recebeu e responde com o schema. */
function binarioFalso(resposta: object[], saida = 0): { caminho: string; registro: string } {
  const pastaFalsa = mkdtempSync(join(tmpdir(), "codex-falso-"));
  const registro = join(pastaFalsa, "registro.json");
  const caminho = join(pastaFalsa, "codex");
  writeFileSync(
    caminho,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const i = args.indexOf("--output-schema");
const schema = i < 0 ? null : fs.readFileSync(args[i + 1], "utf8");
const stdin = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(registro)}, JSON.stringify({ args, stdin, schema }));
for (const l of ${JSON.stringify(resposta)}) process.stdout.write(JSON.stringify(l) + "\\n");
process.exit(${saida});
`,
  );
  chmodSync(caminho, 0o755);
  return { caminho, registro };
}

test("CodexRuntime manda o prompt pela entrada e lê a saída estruturada", async () => {
  const { caminho, registro } = binarioFalso([
    { type: "item.completed", item: { id: "1", type: "agent_message", text: '{"ok":true}' } },
    { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
  ]);
  const schema = { type: "object", properties: { ok: { type: "boolean" } } };
  const resultado = await new CodexRuntime(new Map(), caminho).run(
    pedido({ system: "sistema", prompt: "revise", outputSchema: schema }),
  );
  assert.deepEqual(resultado.structured, { ok: true });
  assert.equal(resultado.billable, false);
  assert.equal(resultado.costUsd, 0);
  assert.equal(resultado.promptTokens, 10);

  const visto = JSON.parse(readFileSync(registro, "utf8")) as { args: string[]; stdin: string; schema: string };
  assert.equal(visto.stdin, "sistema\n\nrevise");
  assert.deepEqual(JSON.parse(visto.schema), schema);
});

test("CodexRuntime falha com a mensagem do turno", async () => {
  const { caminho } = binarioFalso([{ type: "turn.failed", error: { message: "usage limit reached" } }], 1);
  await assert.rejects(new CodexRuntime(new Map(), caminho).run(pedido()), /codex exec falhou: usage limit reached/);
});
