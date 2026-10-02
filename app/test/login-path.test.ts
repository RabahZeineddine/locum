import { test } from "node:test";
import assert from "node:assert/strict";
import { mergePath, readLoginPath } from "../src/runtimes/login-path.js";

test("o PATH de login entra depois do atual, sem repetir e sem pasta relativa", () => {
  assert.equal(
    mergePath("/usr/bin:/bin", "/Users/x/.local/bin:/usr/bin:.:/opt/homebrew/bin:"),
    "/usr/bin:/bin:/Users/x/.local/bin:/opt/homebrew/bin",
  );
  assert.equal(mergePath(undefined, "/opt/homebrew/bin"), "/opt/homebrew/bin");
  assert.equal(mergePath("/usr/bin", undefined), "/usr/bin");
});

test("o PATH de login é lido entre as marcas, ignorando o eco do .zshrc", async () => {
  const visto: string[][] = [];
  const path = await readLoginPath({
    shell: async (comando, args) => {
      visto.push([comando, ...args]);
      return "bem-vindo!\n__LOCUM_PATH__/a/bin:/b/bin__LOCUM_PATH__\ntchau\n";
    },
  });
  assert.equal(path, "/a/bin:/b/bin");
  assert.equal(visto[0]?.[0], "/bin/zsh");
  assert.equal(visto[0]?.[1], "-ilc");
});

test("shell que falha ou não imprime a marca não muda nada", async () => {
  assert.equal(await readLoginPath({ shell: async () => Promise.reject(new Error("timeout")) }), undefined);
  assert.equal(await readLoginPath({ shell: async () => "/a/bin" }), undefined);
  assert.equal(await readLoginPath({ shell: async () => "__LOCUM_PATH____LOCUM_PATH__" }), undefined);
});
