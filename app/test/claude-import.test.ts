import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeImportService, preparar, servidoresDosPlugins } from "../src/services/claude-import.js";
import { CREDENTIAL_PLACEHOLDER } from "../src/services/secret-service.js";

function casa(): string {
  const home = mkdtempSync(join(tmpdir(), "locum-import-"));
  const raiz = join(home, ".claude", "plugins", "cache", "acme", "acme", "1.0.0");
  mkdirSync(raiz, { recursive: true });
  writeFileSync(
    join(raiz, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        incidentes: { type: "http", url: "https://incidentes.exemplo/mcp" },
        metricas: { type: "http", url: "https://metricas.exemplo/mcp", headers: { "Api-Key": "${METRICAS_KEY}" } },
        local: { command: "${CLAUDE_PLUGIN_ROOT}/bin/servidor.sh", args: ["prod"], env: { MODO: "leitura" } },
      },
    }),
  );
  const desligado = join(home, ".claude", "plugins", "cache", "outro", "outro", "1.0.0");
  mkdirSync(desligado, { recursive: true });
  writeFileSync(join(desligado, ".mcp.json"), JSON.stringify({ fora: { type: "http", url: "https://fora.exemplo/mcp" } }));
  writeFileSync(
    join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "acme@acme": [{ installPath: raiz }], "outro@outro": [{ installPath: desligado }] } }),
  );
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "acme@acme": true, "outro@outro": false } }));
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        locum: { command: "/Applications/Locum.app/Contents/MacOS/Locum", args: ["--mcp"] },
        plataforma: { type: "http", url: "https://plataforma.exemplo/mcp", headers: { "x-api-key": "literal-secreto" } },
      },
    }),
  );
  return home;
}

test("plugins: só os ligados, com a pasta de cada um", () => {
  const home = casa();
  const fontes = servidoresDosPlugins(home);
  assert.deepEqual(fontes.map((f) => f.origem), ["acme@acme"]);
  assert.deepEqual(Object.keys(fontes[0]!.servidores).sort(), ["incidentes", "local", "metricas"]);
});

test("segredo vai para o marcador, variável resolve e a que falta aparece", () => {
  const p = preparar("metricas", "acme", { type: "http", url: "https://m/mcp", headers: { "Api-Key": "${K}", Accept: "json" } }, undefined, { K: "abc" }, new Set());
  assert.equal(p.config.headers?.["Api-Key"], CREDENTIAL_PLACEHOLDER);
  assert.equal(p.config.headers?.Accept, "json");
  assert.equal(p.segredo, "abc");
  assert.equal(p.oauth, false);

  const semValor = preparar("metricas", "acme", { url: "https://m/mcp", headers: { "Api-Key": "${K}" } }, undefined, {}, new Set(["metricas"]));
  assert.deepEqual(semValor.faltando, ["K"]);
  assert.equal(semValor.segredo, undefined);
  assert.equal(semValor.jaCadastrado, true);

  const local = preparar("local", "acme", { command: "${CLAUDE_PLUGIN_ROOT}/s.sh", args: ["${MODO:-leitura}"] }, "/raiz", {}, new Set());
  assert.deepEqual(local.config.command, ["/raiz/s.sh", "leitura"]);
  assert.equal(local.destino, "<plugin>/s.sh leitura");
  assert.equal(local.config.scope, "write");

  const daCasa = preparar("backoffice", "acme", { type: "http", url: "https://b/mcp", oauth: { clientId: "app-1", callbackPort: 53682 } }, undefined, {}, new Set());
  assert.deepEqual(daCasa.cliente, { clientId: "app-1", redirectUri: "http://localhost:53682/callback" });
  assert.equal(daCasa.oauth, true);
});

test("importar cadastra desligado, guarda o segredo e não traz o próprio Locum", async () => {
  const home = casa();
  const registrados: string[] = [];
  const desligados: string[] = [];
  const cofre = new Map<string, string>();
  const refs = new Map<string, string | null>();
  const servico = new ClaudeImportService({
    home,
    ambiente: async (nomes): Promise<Record<string, string>> => (nomes.includes("METRICAS_KEY") ? { METRICAS_KEY: "do-shell" } : {}),
    mcp: {
      list: async () => [],
      register: async (c) => {
        registrados.push(c.name);
        return {} as never;
      },
      setEnabled: async (n, ligado) => void (ligado ? undefined : desligados.push(n)),
      setCredentialRef: async (n, r) => void refs.set(n, r),
    },
    secrets: { set: (r, v) => void cofre.set(r, v) },
    settings: { set: async () => undefined },
  });

  const lista = await servico.listar();
  assert.deepEqual(lista.map((c) => c.name).sort(), ["incidentes", "local", "metricas", "plataforma"]);
  assert.ok(lista.every((c) => !("segredo" in c) && !("config" in c)));
  assert.equal(lista.find((c) => c.name === "incidentes")?.oauth, true);

  await servico.importar(["metricas", "plataforma"]);
  assert.deepEqual(registrados.sort(), ["metricas", "plataforma"]);
  assert.deepEqual(desligados.sort(), ["metricas", "plataforma"]);
  assert.equal(cofre.get("mcp/metricas"), "do-shell");
  assert.equal(cofre.get("mcp/plataforma"), "literal-secreto");
  assert.equal(refs.get("plataforma"), "mcp/plataforma");
});
