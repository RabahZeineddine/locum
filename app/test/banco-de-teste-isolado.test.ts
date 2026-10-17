import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ehProcessoDeTeste } from "../src/db/path.js";

test("reconhece o processo de teste pelo runner, pela flag e pelo arquivo", () => {
  assert.equal(ehProcessoDeTeste({ NODE_TEST_CONTEXT: "child-v8" }, ["node", "x.js"], []), true);
  assert.equal(ehProcessoDeTeste({}, ["node", "x.js"], ["--test"]), true);
  assert.equal(ehProcessoDeTeste({}, ["node", "/repo/app/test/pendencia.test.ts"], []), true);
  assert.equal(ehProcessoDeTeste({}, ["node", "/repo/app/dist/main.js"], ["--import", "tsx"]), false);
});

test("arquivo de teste rodado sem test/setup.ts não abre o banco de verdade", () => {
  const casa = mkdtempSync(join(tmpdir(), "locum-casa-falsa-"));
  const pasta = mkdtempSync(join(tmpdir(), "locum-sem-setup-"));
  try {
    const arquivo = join(pasta, "abre-banco.test.mts");
    writeFileSync(arquivo, `await import(${JSON.stringify(join(process.cwd(), "src/db/index.ts"))});\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: casa };
    delete env.LOCUM_HOME;
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ["--import", "tsx", arquivo], { cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000 });
    assert.equal((r.error as NodeJS.ErrnoException | undefined)?.code, undefined, "o processo filho passou de 60s: a trava de teste sem LOCUM_HOME devia recusar na hora");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /teste sem LOCUM_HOME/);
  } finally {
    rmSync(pasta, { recursive: true, force: true });
    rmSync(casa, { recursive: true, force: true });
  }
});
