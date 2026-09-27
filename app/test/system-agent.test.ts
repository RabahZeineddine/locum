import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SYSTEM_CONTEXT_AGENT_ID, SYSTEM_CONTEXT_AGENT_VERSION_ID } from "../src/db/migrate.js";

/**
 * A semeadura roda dentro de `migrateDb()`, chamada no início de todo processo
 * de entrada. Duas aberturas do app sobre o mesmo banco são o caso de verdade,
 * e é isso que dois `cli.ts` seguidos com o mesmo `LOCUM_HOME` reproduzem, sem
 * duplicar a lógica de `seedSystemAgents` aqui.
 */
const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(APP, "node_modules", "tsx", "dist", "cli.mjs");

function rodarCli(home: string, ...args: string[]) {
  return spawnSync(process.execPath, [TSX, "src/cli.ts", ...args], {
    cwd: APP,
    env: { ...process.env, LOCUM_HOME: home },
    encoding: "utf8",
  });
}

test("abrir duas vezes deixa exatamente um agent e uma versao do sistema", () => {
  const home = mkdtempSync(join(tmpdir(), "locum-seed-"));
  try {
    const primeira = rodarCli(home, "agents");
    assert.equal(primeira.status, 0, primeira.stderr || primeira.stdout);
    const segunda = rodarCli(home, "agents");
    assert.equal(segunda.status, 0, segunda.stderr || segunda.stdout);

    const sqlite = new Database(join(home, "watchers.db"), { readonly: true });
    try {
      const agentes = sqlite
        .prepare("select count(*) as n from agents where id = ?")
        .get(SYSTEM_CONTEXT_AGENT_ID) as { n: number };
      assert.equal(agentes.n, 1);

      const versoes = sqlite
        .prepare("select count(*) as n from agent_versions where id = ?")
        .get(SYSTEM_CONTEXT_AGENT_VERSION_ID) as { n: number };
      assert.equal(versoes.n, 1);
    } finally {
      sqlite.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("o agent do sistema fica fora da lista da linha de comando", () => {
  const home = mkdtempSync(join(tmpdir(), "locum-seed-"));
  try {
    const saida = rodarCli(home, "agents");
    assert.equal(saida.status, 0, saida.stderr || saida.stdout);
    assert.ok(!saida.stdout.includes(SYSTEM_CONTEXT_AGENT_ID), saida.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("agent alheio com o id do sistema, cadastrado antes da semeadura, nao ganha a versao do sistema", () => {
  const home = mkdtempSync(join(tmpdir(), "locum-seed-"));
  try {
    // Primeira abertura semeia o banco e cria as tabelas.
    const primeira = rodarCli(home, "agents");
    assert.equal(primeira.status, 0, primeira.stderr || primeira.stdout);

    // Simula um agent alheio que ja existia com este id antes desta versao do
    // Locum trazer o agent de sistema: apaga a versao do sistema e troca o nome.
    const sqlite = new Database(join(home, "watchers.db"));
    sqlite.prepare("delete from agent_versions where id = ?").run(SYSTEM_CONTEXT_AGENT_VERSION_ID);
    sqlite.prepare("update agents set name = ? where id = ?").run("agent de outra pessoa", SYSTEM_CONTEXT_AGENT_ID);
    sqlite.close();

    const segunda = rodarCli(home, "agents");
    assert.equal(segunda.status, 0, segunda.stderr || segunda.stdout);

    const depois = new Database(join(home, "watchers.db"), { readonly: true });
    try {
      const versoes = depois
        .prepare("select count(*) as n from agent_versions where id = ?")
        .get(SYSTEM_CONTEXT_AGENT_VERSION_ID) as { n: number };
      assert.equal(versoes.n, 0);

      const agente = depois
        .prepare("select name from agents where id = ?")
        .get(SYSTEM_CONTEXT_AGENT_ID) as { name: string };
      assert.equal(agente.name, "agent de outra pessoa");
    } finally {
      depois.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
