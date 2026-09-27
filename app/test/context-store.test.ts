import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFolderContextStore } from "../src/services/context-store.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "locum-context-"));
}

test("grava, le e lista", async () => {
  const root = tempRoot();
  try {
    const store = new LocalFolderContextStore(root);
    assert.equal(await store.read("context.md"), null);
    const { hash } = await store.write("context.md", "# ola\n");
    assert.equal(await store.read("context.md"), "# ola\n");
    assert.equal(await store.hash("context.md"), hash);
    assert.deepEqual(await store.list(), ["context.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("escrita e atomica: sem sobra de arquivo temporario", async () => {
  const root = tempRoot();
  try {
    const store = new LocalFolderContextStore(root);
    await store.write("handoffs/2026-09-27.md", "conteudo");
    assert.deepEqual(await store.list(), ["handoffs/2026-09-27.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expectHash errado recusa a escrita", async () => {
  const root = tempRoot();
  try {
    const store = new LocalFolderContextStore(root);
    await store.write("context.md", "v1");
    await assert.rejects(() => store.write("context.md", "v2", { expectHash: "errado" }));
    assert.equal(await store.read("context.md"), "v1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("append com marcador repetido nao faz nada", async () => {
  const root = tempRoot();
  try {
    const store = new LocalFolderContextStore(root);
    const marker = "<!-- locum:abc -->";
    const primeiro = await store.append("context.md", "passagem", marker);
    assert.equal(primeiro.applied, true);
    const conteudoApos = await store.read("context.md");

    const segundo = await store.append("context.md", "passagem repetida", marker);
    assert.equal(segundo.applied, false);
    assert.equal(await store.read("context.md"), conteudoApos);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recusa caminho com .. e caminho absoluto", async () => {
  const root = tempRoot();
  try {
    const store = new LocalFolderContextStore(root);
    await assert.rejects(() => store.write("../fora.md", "x"));
    await assert.rejects(() => store.write("/etc/fora.md", "x"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recusa link simbolico que resolve para fora da pasta", async () => {
  const root = tempRoot();
  const fora = tempRoot();
  try {
    symlinkSync(fora, join(root, "escape"));
    const store = new LocalFolderContextStore(root);
    await assert.rejects(() => store.write("escape/arquivo.md", "x"));
    assert.equal(existsSync(join(fora, "arquivo.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fora, { recursive: true, force: true });
  }
});
