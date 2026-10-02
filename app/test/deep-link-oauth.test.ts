import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepLinkService, parseDeepLink } from "../src/services/deep-link-service.js";
import { McpService } from "../src/services/mcp-service.js";
import { SecretService } from "../src/services/secret-service.js";
import { bancoDeTeste } from "./helpers/db.js";

async function montar() {
  const secrets = new SecretService(mkdtempSync(join(tmpdir(), "locum-oauth-")));
  secrets.useBackend({
    available: () => true,
    encrypt: (plain) => Buffer.from(plain),
    decrypt: (blob) => blob.toString(),
  });
  const mcp = new McpService(bancoDeTeste(), secrets);
  await mcp.register({ name: "linear", transport: "http", url: "https://mcp.exemplo.dev/mcp" });
  const servico = new DeepLinkService(mcp, secrets);
  const { state } = await servico.beginAuthorization({
    server: "linear",
    authorizeUrl: "https://auth.exemplo.dev/authorize",
    tokenUrl: "https://auth.exemplo.dev/token",
    clientId: "cliente",
  });
  return { servico, state, mcp };
}

test("retorno com state errado não consome a autorização em andamento", async () => {
  const { servico, state, mcp } = await montar();
  const troca = async () => ({ accessToken: "tok", tokenType: "Bearer" });

  await assert.rejects(
    servico.completeOAuth({ kind: "oauth-callback", server: "linear", code: "c", state: "outro" }, troca),
    /nao confere/,
  );
  assert.equal(servico.isAwaitingCallback("linear"), true);

  const feito = await servico.completeOAuth({ kind: "oauth-callback", server: "linear", code: "c", state }, troca);
  assert.equal(feito.credentialRef, "mcp/linear");
  assert.equal((await mcp.get("linear"))?.credentialRef, "mcp/linear");
  assert.equal(servico.isAwaitingCallback("linear"), false);
});

test("retorno de erro só cancela com o state da autorização", async () => {
  const { servico, state } = await montar();

  const semState = parseDeepLink("locum://oauth/callback?server=linear&error=access_denied");
  assert.equal(semState.kind, "oauth-error");
  assert.equal(servico.cancelFromCallback("linear", semState.kind === "oauth-error" ? semState.state : ""), false);
  assert.equal(servico.isAwaitingCallback("linear"), true);

  const comState = parseDeepLink(`locum://oauth/callback?server=linear&error=access_denied&state=${state}`);
  assert.equal(servico.cancelFromCallback("linear", comState.kind === "oauth-error" ? comState.state : ""), true);
  assert.equal(servico.isAwaitingCallback("linear"), false);
});
