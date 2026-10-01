import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb } from "../src/db/migrate.js";
import { McpOAuthService } from "../src/services/mcp-oauth-service.js";
import { McpService } from "../src/services/mcp-service.js";
import { SecretService } from "../src/services/secret-service.js";

before(() => {
  migrateDb();
});

/** Cofre de verdade numa pasta de rascunho, com a cifra trocada por texto puro. */
function cofre(): SecretService {
  const secrets = new SecretService(mkdtempSync(join(tmpdir(), "locum-oauth-")));
  secrets.useBackend({
    available: () => true,
    encrypt: (plain) => Buffer.from(plain),
    decrypt: (blob) => blob.toString(),
  });
  return secrets;
}

function corpo(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let texto = "";
    req.on("data", (pedaco) => (texto += pedaco));
    req.on("end", () => resolve(texto));
  });
}

/**
 * Servidor MCP e servidor de autorização de mentira, no mesmo endereço, com o
 * que a especificação pede: metadado do recurso, metadado do autorizador,
 * registro de cliente, autorização que devolve código e troca por token.
 */
async function servicoFalso({ registro = true, recusar = false } = {}) {
  const visto = {
    registros: 0,
    trocas: 0,
    renovacoes: 0,
    desafio: "",
    recurso: "",
    cliente: "",
    retorno: "",
    escopo: "",
    form: new URLSearchParams(),
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const json = (status: number, valor: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(valor));
    };
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["read"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(registro ? { registration_endpoint: `${base}/register` } : {}),
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        // Sem registro, como o Slack: anuncia só segredo, e cliente público tem que passar mesmo assim.
        token_endpoint_auth_methods_supported: registro ? ["none"] : ["client_secret_post"],
      });
    }
    if (url.pathname === "/register") {
      visto.registros++;
      const pedido = JSON.parse(await corpo(req)) as Record<string, unknown>;
      return json(201, { ...pedido, client_id: `cliente-${visto.registros}` });
    }
    if (url.pathname === "/authorize") {
      visto.desafio = url.searchParams.get("code_challenge") ?? "";
      visto.recurso = url.searchParams.get("resource") ?? "";
      visto.cliente = url.searchParams.get("client_id") ?? "";
      visto.retorno = url.searchParams.get("redirect_uri") ?? "";
      visto.escopo = url.searchParams.get("scope") ?? "";
      const volta = new URL(url.searchParams.get("redirect_uri")!);
      if (recusar) volta.searchParams.set("error", "access_denied");
      else volta.searchParams.set("code", "codigo-1");
      volta.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: volta.toString() }).end();
      return;
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await corpo(req));
      if (form.get("grant_type") === "refresh_token") {
        visto.renovacoes++;
        return json(200, { access_token: "token-2", token_type: "Bearer", expires_in: 3600 });
      }
      visto.trocas++;
      visto.form = form;
      assert.equal(form.get("code"), "codigo-1");
      assert.ok((form.get("code_verifier") ?? "").length >= 43);
      return json(200, { access_token: "token-1", token_type: "Bearer", expires_in: 600, refresh_token: "renova-1" });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, visto, fechar: () => server.close() };
}

async function montar(opcoes: { registro?: boolean; recusar?: boolean } = {}) {
  const falso = await servicoFalso(opcoes);
  const secrets = cofre();
  const mcp = new McpService(undefined, secrets);
  const name = `oauth-${randomUUID().slice(0, 8)}`;
  await mcp.register({ name, transport: "http", url: `${falso.base}/mcp` });
  let agora = 1_000_000;
  const oauth = new McpOAuthService({
    mcp,
    secrets,
    now: () => agora,
    timeoutMs: 5_000,
    // O "navegador" segue o redirecionamento até o loopback, como a pessoa faria ao autorizar.
    openBrowser: async (url) => {
      await fetch(url);
    },
  });
  return { ...falso, secrets, mcp, oauth, name, avancar: (ms: number) => (agora += ms) };
}

test("conectar registra o cliente, autoriza com PKCE e guarda o token no cofre", async () => {
  const { base, visto, fechar, secrets, mcp, oauth, name } = await montar();
  try {
    const estado = await oauth.connect(name);
    assert.equal(estado.connected, true);
    assert.equal(estado.renewable, true);
    assert.equal(visto.registros, 1);
    assert.equal(visto.trocas, 1);
    assert.ok(visto.desafio.length > 0);
    assert.equal(visto.recurso, `${base}/mcp`);

    assert.equal(secrets.get(`mcp/${name}`), "Bearer token-1");
    const entrada = await mcp.get(name);
    assert.equal(entrada?.credentialRef, `mcp/${name}`);
    // O cadastro guarda o marcador, nunca o token.
    assert.equal(entrada?.config.headers?.["Authorization"], "${credential}");
  } finally {
    fechar();
  }
});

test("token perto de vencer é renovado antes de conectar, sem abrir o navegador", async () => {
  const { visto, fechar, secrets, mcp, oauth, name, avancar } = await montar();
  try {
    await oauth.connect(name);
    mcp.useRefresher((n) => oauth.refreshIfNeeded(n));

    await oauth.refreshIfNeeded(name);
    assert.equal(visto.renovacoes, 0, "token com folga não é trocado");

    avancar(500_000);
    await mcp.enabledConfigs();
    assert.equal(visto.renovacoes, 1);
    assert.equal(secrets.get(`mcp/${name}`), "Bearer token-2");
    // A renovação não devolveu refresh token novo, e o antigo continua valendo.
    assert.equal(oauth.status(name).renewable, true);
  } finally {
    fechar();
  }
});

test("recusa no navegador vira erro e não grava nada", async () => {
  const { fechar, secrets, oauth, name } = await montar({ recusar: true });
  try {
    await assert.rejects(oauth.connect(name), /recusou a autorização: access_denied/);
    assert.equal(secrets.has(`mcp/${name}`), false);
    assert.equal(oauth.status(name).connected, false);
  } finally {
    fechar();
  }
});

test("servidor sem registro automático recusa com o motivo", async () => {
  const { base, fechar, oauth, name } = await montar({ registro: false });
  try {
    assert.deepEqual(await oauth.probe(`${base}/mcp`), { oauth: true, registration: false });
    await assert.rejects(oauth.connect(name), /não aceita registro automático/);
  } finally {
    fechar();
  }
});

/** Uma porta livre agora, para o retorno fixo não brigar com outro teste. */
async function portaLivre(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address() as AddressInfo;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

test("cliente cadastrado à mão pula o registro e volta pelo retorno fixo", async () => {
  const { visto, fechar, secrets, oauth, name } = await montar({ registro: false });
  try {
    const redirectUri = `http://localhost:${await portaLivre()}/callback`;
    const estado = await oauth.connect(name, { clientId: "111.222", redirectUri, scope: "a:read b:write" });
    assert.equal(estado.connected, true);
    assert.equal(visto.registros, 0);
    assert.equal(visto.cliente, "111.222");
    assert.equal(visto.retorno, redirectUri);
    assert.equal(visto.escopo, "a:read b:write");
    // Cliente público: a troca leva o client id e o verificador, nunca segredo.
    assert.equal(visto.form.get("client_id"), "111.222");
    assert.equal(visto.form.get("redirect_uri"), redirectUri);
    assert.equal(visto.form.has("client_secret"), false);
    assert.equal(secrets.get(`mcp/${name}`), "Bearer token-1");
  } finally {
    fechar();
  }
});

test("retorno fixo fora do loopback é recusado antes de abrir o navegador", async () => {
  const { visto, fechar, oauth, name } = await montar({ registro: false });
  try {
    await assert.rejects(
      oauth.connect(name, { clientId: "111.222", redirectUri: "https://exemplo.invalid/callback" }),
      /precisa ser loopback/,
    );
    assert.equal(visto.trocas, 0);
  } finally {
    fechar();
  }
});

test("desconectar apaga token e registro e solta a referência", async () => {
  const { fechar, secrets, mcp, oauth, name } = await montar();
  try {
    await oauth.connect(name);
    await oauth.disconnect(name);
    assert.equal(secrets.has(`mcp/${name}`), false);
    assert.equal(secrets.has(`oauth/${name}`), false);
    assert.equal((await mcp.get(name))?.credentialRef, null);
  } finally {
    fechar();
  }
});
