import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const AMBIENTE = (execPath: string, existentes: string[]) => ({
  execPath,
  empacotado: true,
  home: "/Users/ana",
  plataforma: "darwin" as const,
  existe: (c: string) => existentes.includes(c),
});
const WORKTREE = "/Users/ana/.worktrees/locum-dock/app/release/mac-arm64/Locum.app/Contents/MacOS/Locum";

test("o aviso de cópia errada só existe no app instalado, e só com o Locum já cadastrado no Claude Code", async () => {
  const cadastro = { mcpServers: { locum: { command: WORKTREE, args: ["--mcp"] } } };

  const instalado = montar(cadastro);
  instalado.servico.useAmbiente(AMBIENTE(APP, [APP, WORKTREE]));
  assert.equal((await instalado.servico.status()).desatualizado, "outra-copia");
  // O status só lê: nada foi rodado no Claude Code.
  assert.deepEqual(instalado.chamadas, []);

  const solta = montar(cadastro);
  solta.servico.useAmbiente(AMBIENTE(WORKTREE, [APP, WORKTREE]));
  assert.equal((await solta.servico.status()).desatualizado, null);

  const semAmbiente = montar(cadastro);
  assert.equal((await semAmbiente.servico.status()).desatualizado, null);

  const semCadastro = montar({ mcpServers: {} });
  semCadastro.servico.useAmbiente(AMBIENTE(APP, [APP]));
  assert.equal((await semCadastro.servico.status()).desatualizado, null);

  const certo = montar({ mcpServers: { locum: { command: APP, args: ["--mcp"] } } });
  certo.servico.useAmbiente(AMBIENTE(APP, [APP]));
  assert.equal((await certo.servico.status()).desatualizado, null);
  for (const m of [instalado, solta, semAmbiente, semCadastro, certo]) m.limpar();
});

test("corrigir recadastra; se o add falha, o comando anterior volta e o erro sobe", async () => {
  const pasta = mkdtempSync(join(tmpdir(), "locum-claude-code-"));
  const configPath = join(pasta, ".claude.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: { locum: { command: WORKTREE, args: ["--mcp"] } } }));
  const chamadas: string[][] = [];
  let falharOAdd = true;
  const servico = new ClaudeCodeService({
    configPath,
    resolveClaude: async () => CLI,
    run: async (command, args) => {
      chamadas.push([command, ...args]);
      if (args[1] === "remove") writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
      if (args[1] === "add") {
        // O primeiro add (o comando novo) falha; o de recolocar o anterior passa.
        if (falharOAdd && args[6] === APP) throw new Error("claude: add falhou");
        writeFileSync(configPath, JSON.stringify({ mcpServers: { locum: { command: args[6], args: args.slice(7) } } }));
      }
    },
  });
  servico.useLauncher({ command: APP, args: [] });

  await assert.rejects(() => servico.connect(), /add falhou/);
  assert.deepEqual(chamadas.map((c) => c.slice(1, 3).join(" ")), ["mcp remove", "mcp add", "mcp add"]);
  assert.deepEqual(chamadas[2], [CLI, "mcp", "add", "--scope", "user", "locum", "--", WORKTREE, "--mcp"]);
  assert.equal((await servico.status()).current, false);
  const estado = JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers: { locum: { command: string } } };
  assert.equal(estado.mcpServers.locum.command, WORKTREE);

  falharOAdd = false;
  chamadas.length = 0;
  assert.equal((await servico.connect()).current, true);
  rmSync(pasta, { recursive: true, force: true });
});

test("o rollback recoloca a entrada inteira, com env e tipo", async () => {
  const pasta = mkdtempSync(join(tmpdir(), "locum-claude-code-"));
  const configPath = join(pasta, ".claude.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: { locum: { type: "stdio", command: WORKTREE, args: ["--mcp"], env: { LOCUM_HOME: "/dados" } } } }));
  const chamadas: string[][] = [];
  const servico = new ClaudeCodeService({
    configPath,
    resolveClaude: async () => CLI,
    run: async (command, args) => {
      chamadas.push([command, ...args]);
      if (args[1] === "add" && args.includes(APP)) throw new Error("claude: add falhou");
    },
  });
  servico.useLauncher({ command: APP, args: [] });
  await assert.rejects(() => servico.connect(), /add falhou/);
  assert.deepEqual(chamadas[2], [CLI, "mcp", "add", "--scope", "user", "-e", "LOCUM_HOME=/dados", "locum", "--", WORKTREE, "--mcp"]);
  rmSync(pasta, { recursive: true, force: true });
});

test("se o rollback também falha, o erro diz que o Claude Code ficou sem o locum e como recolocar, sem o valor do ambiente", async () => {
  const pasta = mkdtempSync(join(tmpdir(), "locum-claude-code-"));
  const configPath = join(pasta, ".claude.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: { locum: { command: WORKTREE, args: ["--mcp"], env: { SEGREDO: "valor-secreto" } } } }));
  const servico = new ClaudeCodeService({
    configPath,
    resolveClaude: async () => CLI,
    run: async (_c, args) => {
      if (args[1] === "add") throw new Error("claude: sem rede");
    },
  });
  servico.useLauncher({ command: APP, args: [] });
  await assert.rejects(
    () => servico.connect(),
    (e: Error) => {
      assert.match(e.message, /ficou sem o "locum"/);
      assert.match(e.message, new RegExp(`claude mcp add --scope user -e 'SEGREDO=<valor>' locum -- ${WORKTREE.replaceAll("/", "\\/")} --mcp`));
      assert.ok(!e.message.includes("valor-secreto"));
      return true;
    },
  );
  rmSync(pasta, { recursive: true, force: true });
});
