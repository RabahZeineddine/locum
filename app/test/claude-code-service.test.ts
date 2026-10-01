import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeService } from "../src/services/claude-code-service.js";

const APP = "/Applications/Locum.app/Contents/MacOS/Locum";
const CLI = "/Users/teste/.local/bin/claude";

function montar(config: unknown | null, cli: string | null = CLI) {
  const pasta = mkdtempSync(join(tmpdir(), "locum-claude-code-"));
  const configPath = join(pasta, ".claude.json");
  if (config !== null) writeFileSync(configPath, JSON.stringify(config));
  const chamadas: string[][] = [];
  const servico = new ClaudeCodeService({
    configPath,
    resolveClaude: async () => cli ?? undefined,
    run: async (command, args) => {
      chamadas.push([command, ...args]);
      // O que o `claude mcp add` faria no arquivo, para o estado seguinte bater.
      if (args[1] === "add") {
        writeFileSync(configPath, JSON.stringify({ mcpServers: { locum: { command: args[6], args: args.slice(7) } } }));
      }
    },
  });
  servico.useLauncher({ command: APP, args: [] });
  return { servico, chamadas, limpar: () => rmSync(pasta, { recursive: true, force: true }) };
}

test("sem cadastro, o estado diz que falta e mostra a linha do botão", async () => {
  const { servico, limpar } = montar(null);
  try {
    const estado = await servico.status();
    assert.equal(estado.registered, false);
    assert.equal(estado.current, false);
    assert.equal(estado.cli, CLI);
    assert.equal(estado.command, `claude mcp add --scope user locum -- ${APP} --mcp`);
  } finally {
    limpar();
  }
});

test("conectar cadastra pelo claude, e o estado passa a apontar para este aplicativo", async () => {
  const { servico, chamadas, limpar } = montar({ mcpServers: {} });
  try {
    const estado = await servico.connect();
    assert.deepEqual(chamadas, [[CLI, "mcp", "add", "--scope", "user", "locum", "--", APP, "--mcp"]]);
    assert.equal(estado.registered, true);
    assert.equal(estado.current, true);
  } finally {
    limpar();
  }
});

test("cadastro apontando para outra cópia vale como desatualizado, e conectar troca", async () => {
  const antigo = { command: "node", args: ["app/node_modules/tsx/dist/cli.mjs", "app/src/mcp-server/index.ts"] };
  const { servico, chamadas, limpar } = montar({ mcpServers: { locum: antigo } });
  try {
    const antes = await servico.status();
    assert.equal(antes.registered, true);
    assert.equal(antes.current, false);

    await servico.connect();
    assert.deepEqual(chamadas[0], [CLI, "mcp", "remove", "--scope", "user", "locum"]);
    assert.equal(chamadas[1]?.[2], "add");
  } finally {
    limpar();
  }
});

test("sem claude na máquina, conectar recusa com o motivo e não roda nada", async () => {
  const { servico, chamadas, limpar } = montar(null, null);
  try {
    await assert.rejects(servico.connect(), /não achei o claude/);
    assert.equal(chamadas.length, 0);
  } finally {
    limpar();
  }
});

test("caminho com espaço sai entre aspas na linha mostrada", async () => {
  const { servico, limpar } = montar(null);
  try {
    servico.useLauncher({ command: "/Users/teste/Meus Apps/Locum.app/Contents/MacOS/Locum", args: [] });
    const estado = await servico.status();
    assert.match(estado.command, /-- '\/Users\/teste\/Meus Apps\/Locum\.app\/Contents\/MacOS\/Locum' --mcp$/);
  } finally {
    limpar();
  }
});
