import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

/**
 * A linha de comando e o servidor MCP abriam o banco sem aplicar migração, e
 * só o processo principal do Electron migrava. Contra um banco de antes de uma
 * migração, os dois quebravam na primeira consulta com coluna inexistente.
 *
 * O loop nunca pegou porque cria banco novo a cada rodada, sempre no esquema
 * mais recente. Estes testes montam o banco antigo de propósito e abrem as duas
 * entradas do jeito que elas são chamadas de verdade.
 */

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAIZ = join(APP, "..");
const TSX = join(APP, "node_modules", "tsx", "dist", "cli.mjs");

/** Um banco migrado só até a primeira migração, como o de quem atualizou o app. */
function bancoAntigo(): { home: string; limpar: () => void } {
  const home = mkdtempSync(join(tmpdir(), "locum-migracao-"));
  const pasta = join(home, "drizzle-antigo");
  cpSync(join(APP, "drizzle"), pasta, { recursive: true });

  const journal = join(pasta, "meta", "_journal.json");
  const lido = JSON.parse(readFileSync(journal, "utf8")) as { entries: unknown[] };
  lido.entries = lido.entries.slice(0, 1);
  writeFileSync(journal, JSON.stringify(lido));

  const sqlite = new Database(join(home, "watchers.db"));
  migrate(drizzle(sqlite), { migrationsFolder: pasta });
  sqlite.close();

  return { home, limpar: () => rmSync(home, { recursive: true, force: true }) };
}

/** Banco migrado até uma migração específica, para testar a próxima em cima. */
function bancoAte(quantidade: number): { home: string; pasta: string; limpar: () => void } {
  const home = mkdtempSync(join(tmpdir(), "locum-migracao-"));
  const pasta = join(home, "drizzle-parcial");
  cpSync(join(APP, "drizzle"), pasta, { recursive: true });

  const journal = join(pasta, "meta", "_journal.json");
  const lido = JSON.parse(readFileSync(journal, "utf8")) as { entries: unknown[] };
  lido.entries = lido.entries.slice(0, quantidade);
  writeFileSync(journal, JSON.stringify(lido));

  const sqlite = new Database(join(home, "watchers.db"));
  migrate(drizzle(sqlite), { migrationsFolder: pasta });
  sqlite.close();

  return { home, pasta, limpar: () => rmSync(home, { recursive: true, force: true }) };
}

function colunas(home: string, tabela: string): string[] {
  const sqlite = new Database(join(home, "watchers.db"), { readonly: true });
  const nomes = (sqlite.prepare(`pragma table_info(${tabela})`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  sqlite.close();
  return nomes;
}

test("a linha de comando migra o banco antigo antes de consultar", () => {
  const { home, limpar } = bancoAntigo();
  try {
    assert.equal(colunas(home, "steps").includes("cache_read_tokens"), false, "banco já nasceu migrado");

    const saida = spawnSync(process.execPath, [TSX, "src/cli.ts", "runs"], {
      cwd: APP,
      env: { ...process.env, LOCUM_HOME: home },
      encoding: "utf8",
    });

    assert.equal(saida.status, 0, `linha de comando falhou: ${saida.stderr || saida.stdout}`);
    assert.ok(colunas(home, "steps").includes("cache_read_tokens"), "a migração pendente não rodou");
  } finally {
    limpar();
  }
});

test("migração das iniciativas aplica sobre banco com dados da 0004 e preserva agents e runs", () => {
  // Só até a 0004: a migração 0005 (iniciativas) ainda não rodou aqui.
  const { home, limpar } = bancoAte(5);
  try {
    const antes = new Database(join(home, "watchers.db"));
    antes.exec(`insert into agents (id, name) values ('agente-x', 'Agente X')`);
    antes.exec(
      `insert into agent_versions (id, agent_id, version, spec) values ('versao-x', 'agente-x', 1, '{}')`,
    );
    antes.exec(`insert into runs (id, agent_version_id) values ('run-x', 'versao-x')`);
    antes.close();

    // Pasta completa, com a 0005 no journal: pasta (truncada na 5) so serviu
    // para deixar o banco parado na 0004 antes do teste.
    const sqlite = new Database(join(home, "watchers.db"));
    migrate(drizzle(sqlite), { migrationsFolder: join(APP, "drizzle") });

    const agente = sqlite.prepare("select * from agents where id = ?").get("agente-x") as
      | { id: string; name: string; initiative_id: string | null }
      | undefined;
    const run = sqlite.prepare("select * from runs where id = ?").get("run-x") as
      | { id: string; agent_version_id: string; initiative_id: string | null }
      | undefined;
    sqlite.close();

    assert.ok(agente, "agent sumiu depois da migração");
    assert.equal(agente!.name, "Agente X");
    assert.equal(agente!.initiative_id, null);

    assert.ok(run, "run sumiu depois da migração");
    assert.equal(run!.agent_version_id, "versao-x");
    assert.equal(run!.initiative_id, null);

    assert.ok(colunas(home, "agents").includes("initiative_id"));
    assert.ok(colunas(home, "runs").includes("initiative_id"));
    assert.ok(colunas(home, "initiatives").includes("context_path"));
  } finally {
    limpar();
  }
});

test("o servidor MCP migra o banco antigo mesmo subindo da raiz do repositório", async () => {
  const { home, limpar } = bancoAntigo();
  try {
    // Exatamente o que o .mcp.json manda: rodar da raiz, com o caminho para app/.
    const processo = spawn(process.execPath, [TSX, "app/src/mcp-server/index.ts"], {
      cwd: RAIZ,
      env: { ...process.env, LOCUM_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const resposta = await new Promise<string>((resolve, reject) => {
      let lido = "";
      const prazo = setTimeout(() => reject(new Error(`sem resposta do servidor MCP: ${lido}`)), 20_000);
      processo.stdout.on("data", (pedaco: Buffer) => {
        lido += pedaco.toString();
        if (lido.includes('"id":1')) {
          clearTimeout(prazo);
          resolve(lido);
        }
      });
      processo.on("exit", (codigo) => {
        clearTimeout(prazo);
        reject(new Error(`servidor MCP saiu com ${codigo} antes de responder`));
      });
      processo.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "teste", version: "1" } },
        }) + "\n",
      );
    });

    processo.kill();
    assert.ok(resposta.includes('"result"'), "o servidor não respondeu ao initialize");
    assert.ok(colunas(home, "steps").includes("cache_read_tokens"), "a migração pendente não rodou");
  } finally {
    limpar();
  }
});
