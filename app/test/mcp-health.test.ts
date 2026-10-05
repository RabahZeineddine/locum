import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrateDb } from "../src/db/migrate.js";
import { McpRegistry } from "../src/mcp/registry.js";
import { McpServerConfig } from "../src/config/types.js";
import { isAuthError, McpService } from "../src/services/mcp-service.js";

before(() => {
  migrateDb();
});

function nomeNovo(): string {
  return `saude-${randomUUID().slice(0, 8)}`;
}

test("isAuthError reconhece credencial recusada e deixa o resto de fora", () => {
  for (const msg of [
    "HTTP 401: Unauthorized",
    "Error POSTing to endpoint (HTTP 403): Forbidden",
    "invalid_token",
    "The access token has expired",
    "session expired, please sign in",
    "Authentication required",
  ]) {
    assert.ok(isAuthError(msg), msg);
  }
  for (const msg of ["spawn npx ENOENT", "connect ECONNREFUSED 127.0.0.1:9", "HTTP 500: Internal Server Error", "timeout após 4013 ms"]) {
    assert.ok(!isAuthError(msg), msg);
  }
});

test("needsAuth vale só enquanto a falha de credencial é a mais recente", async () => {
  const servico = new McpService();
  const nome = nomeNovo();
  await servico.register({ name: nome, transport: "http", url: "http://127.0.0.1:9/mcp" });

  let saude = (await servico.get(nome))!.health;
  assert.deepEqual(saude, { lastOkAt: null, lastFailureAt: null, lastError: null, needsAuth: false });

  await servico.recordConnection(nome, { ok: true }, new Date(1_000));
  await servico.recordConnection(nome, { ok: false, error: "HTTP 401: Unauthorized" }, new Date(2_000));
  saude = (await servico.get(nome))!.health;
  assert.equal(saude.lastOkAt, 1_000);
  assert.equal(saude.lastFailureAt, 2_000);
  assert.equal(saude.needsAuth, true);

  await servico.recordConnection(nome, { ok: true }, new Date(3_000));
  saude = (await servico.get(nome))!.health;
  assert.equal(saude.needsAuth, false);
  assert.equal(saude.lastError, "HTTP 401: Unauthorized", "o último erro fica para quem quiser ver");

  await servico.recordConnection(nome, { ok: false, error: "connect ECONNREFUSED" }, new Date(4_000));
  assert.equal((await servico.get(nome))!.health.needsAuth, false, "fora do ar não é credencial");

  await servico.recordConnection(nome, { ok: false, error: "x".repeat(2_000) }, new Date(5_000));
  assert.equal((await servico.get(nome))!.health.lastError?.length, 500);

  await servico.remove(nome);
});

test("conexão que falha em qualquer registro chega ao observador", async () => {
  const vistos: [string, boolean][] = [];
  const nome = nomeNovo();
  McpRegistry.observe((n, desfecho) => vistos.push([n, desfecho.ok]));
  try {
    const registro = McpRegistry.fromList([
      McpServerConfig.parse({ name: nome, transport: "stdio", command: ["/nao/existe/locum-saude"] }),
    ]);
    await assert.rejects(registro.describeTools(nome));
    await registro.closeAll();
  } finally {
    McpRegistry.observe(null);
  }
  assert.deepEqual(vistos, [[nome, false]]);
});

test("servidor que responde 401 falha dizendo que a credencial foi recusada", async () => {
  const { createServer } = await import("node:http");
  const servidor = createServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_token" }));
  });
  await new Promise<void>((pronto) => servidor.listen(0, "127.0.0.1", pronto));
  const endereco = servidor.address();
  const porta = typeof endereco === "object" && endereco !== null ? endereco.port : 0;
  const nome = nomeNovo();
  const registro = McpRegistry.fromList([
    McpServerConfig.parse({ name: nome, transport: "http", url: `http://127.0.0.1:${porta}/mcp` }),
  ]);
  try {
    await assert.rejects(registro.describeTools(nome), /recusou a credencial/);
  } finally {
    await registro.closeAll();
    servidor.close();
  }
});

test("credencial colada vai para o cofre, com o marcador no cadastro e Bearer no Authorization", async () => {
  const cofre = new Map<string, string>();
  const segredos = {
    set: (ref: string, valor: string) => void cofre.set(ref, valor),
    get: (ref: string) => cofre.get(ref),
    pathFor: (ref: string) => ref,
  } as unknown as ConstructorParameters<typeof McpService>[1];
  const servico = new McpService(undefined, segredos);

  const remoto = nomeNovo();
  await servico.register({ name: remoto, transport: "http", url: "http://127.0.0.1:9/mcp" });
  const http = await servico.setCredential(remoto, { campo: "Authorization", valor: "abc" });
  assert.equal(http.config.headers?.Authorization, "${credential}");
  assert.equal(http.credentialRef, `mcp/${remoto}`);
  assert.equal(cofre.get(`mcp/${remoto}`), "Bearer abc");

  const local = nomeNovo();
  await servico.register({ name: local, transport: "stdio", command: ["/bin/true"] });
  const stdio = await servico.setCredential(local, { campo: "API_KEY", valor: "Bearer fica" });
  assert.equal(stdio.config.env?.API_KEY, "${credential}");
  assert.equal(cofre.get(`mcp/${local}`), "Bearer fica");

  await assert.rejects(servico.setCredential(local, { campo: "com espaço", valor: "x" }), /não serve/);
});

test("a lista de ferramentas fica guardada para a tela mostrar sem subir o servidor", async () => {
  const servico = new McpService();
  const nome = nomeNovo();
  await servico.register({ name: nome, transport: "stdio", command: ["/nao/existe/locum-cache"] });
  assert.equal(await servico.cachedTools(nome), null, "nunca listou, nada guardado");
  await assert.rejects(servico.listTools(nome));
  assert.equal(await servico.cachedTools(nome), null, "falha não apaga nem inventa lista");
  await servico.remove(nome);

  const vivo = nomeNovo();
  const fixture = fileURLToPath(new URL("../src/fixtures/mcp-fixture-server.ts", import.meta.url));
  await servico.register({ name: vivo, transport: "stdio", command: [process.execPath, "--import", "tsx", fixture] });
  const lidas = await servico.listTools(vivo);
  const guardada = await servico.cachedTools(vivo);
  assert.ok(lidas.length > 0);
  assert.deepEqual(guardada?.tools, lidas);
  assert.ok((guardada?.at ?? 0) > 0);
  await servico.remove(vivo);
});
