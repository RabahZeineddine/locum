import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeService } from "../src/services/opencode-service.js";

const APP = "/Applications/Locum.app/Contents/MacOS/Locum";

function montar() {
  const configDir = mkdtempSync(join(tmpdir(), "locum-opencode-"));
  const servico = new OpencodeService({ configDir });
  servico.useLauncher({ command: APP, args: [] });
  return { servico, configDir, limpar: () => rmSync(configDir, { recursive: true, force: true }) };
}

test("sem arquivo, conectar cria o opencode.json com o locum", async () => {
  const { servico, configDir, limpar } = montar();
  try {
    assert.equal((await servico.status()).registered, false);
    const estado = await servico.connect();
    assert.equal(estado.current, true);
    const config = JSON.parse(readFileSync(join(configDir, "opencode.json"), "utf8"));
    assert.deepEqual(config.mcp.locum, { type: "local", command: [APP, "--mcp"], enabled: true });
  } finally {
    limpar();
  }
});

test("conectar preserva o resto do arquivo e troca o locum que aponta para outra cópia", async () => {
  const { servico, configDir, limpar } = montar();
  try {
    const arquivo = join(configDir, "opencode.json");
    writeFileSync(
      arquivo,
      JSON.stringify({ model: "x/y", mcp: { outro: { type: "remote", url: "https://a" }, locum: { type: "local", command: ["/velho", "--mcp"] } } }),
    );
    const antes = await servico.status();
    assert.equal(antes.registered, true);
    assert.equal(antes.current, false);
    await servico.connect();
    const config = JSON.parse(readFileSync(arquivo, "utf8"));
    assert.equal(config.model, "x/y");
    assert.deepEqual(config.mcp.outro, { type: "remote", url: "https://a" });
    assert.deepEqual(config.mcp.locum.command, [APP, "--mcp"]);
  } finally {
    limpar();
  }
});

test("opencode.jsonc ganha o locum e os comentários ficam", async () => {
  const { servico, configDir, limpar } = montar();
  try {
    const arquivo = join(configDir, "opencode.jsonc");
    writeFileSync(arquivo, '{\n  // meu modelo\n  "model": "x/y",\n  "mcp": {\n    // o de sempre\n    "outro": { "type": "remote", "url": "https://a" },\n  },\n}\n');
    assert.equal((await servico.status()).registered, false);
    const estado = await servico.connect();
    assert.equal(estado.configPath, arquivo);
    assert.equal(estado.current, true);
    const texto = readFileSync(arquivo, "utf8");
    assert.match(texto, /\/\/ meu modelo/);
    assert.match(texto, /\/\/ o de sempre/);
    assert.match(texto, /"outro"/);
  } finally {
    limpar();
  }
});

test("arquivo quebrado não é reescrito, e o erro manda colar o trecho", async () => {
  const { servico, configDir, limpar } = montar();
  try {
    const arquivo = join(configDir, "opencode.json");
    writeFileSync(arquivo, '{ "model": ');
    await assert.rejects(servico.connect(), /cole o trecho/);
    assert.equal(readFileSync(arquivo, "utf8"), '{ "model": ');
  } finally {
    limpar();
  }
});
