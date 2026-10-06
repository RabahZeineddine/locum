import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProviderEntry } from "../src/providers/registry.js";
import { ProviderService } from "../src/services/provider-service.js";
import { rotuloDoModelo } from "../renderer/lib/rotulos.js";
import { bancoDeTeste } from "./helpers/db.js";

const provedores: Record<string, ProviderEntry> = {
  "claude-code": { available: () => true, requires: [], fixedModels: ["opus", "sonnet", "haiku"] },
  api: { available: () => true, requires: [], model: () => ({}) as never },
};

test("assinatura oferece os apelidos de família sem perguntar à rede", async () => {
  const servico = new ProviderService(bancoDeTeste(), provedores);
  assert.deepEqual(await servico.listModels("claude-code"), { modelos: ["opus", "sonnet", "haiku"] });
});

test("catálogo geral só traz a assinatura quando pedida", async () => {
  const servico = new ProviderService(bancoDeTeste(), provedores);
  const semAssinatura = await servico.listAllModels();
  assert.deepEqual(
    semAssinatura.map((c) => c.provedor),
    ["api"],
  );
  const comAssinatura = await servico.listAllModels({ assinatura: true });
  assert.deepEqual(
    comAssinatura.map((c) => c.provedor),
    ["claude-code", "api"],
  );
});

test("apelido e id datado viram nome legível", () => {
  assert.equal(rotuloDoModelo("claude-code/opus"), "Claude Opus · Claude Code");
  assert.equal(rotuloDoModelo("claude-code/claude-sonnet-5"), "Claude Sonnet 5 · Claude Code");
  assert.equal(rotuloDoModelo("google/gemini-2.5-pro"), "gemini-2.5-pro · Google");
});

test("provedor desligado some de tudo e volta ao religar", async () => {
  const servico = new ProviderService(bancoDeTeste(), provedores, undefined, undefined, () => provedores);
  await servico.setEnabled("claude-code", false);
  assert.equal(servico.isAvailable("claude-code"), false);
  assert.equal(servico.listProviders().find((p) => p.name === "claude-code")?.disabled, true);
  assert.deepEqual(
    (await servico.listAllModels({ assinatura: true })).map((c) => c.provedor),
    ["api"],
  );
  // Remontar o registro, como o app faz ao guardar chave, não religa.
  await servico.loadSecrets();
  assert.equal(servico.isAvailable("claude-code"), false);
  await servico.setEnabled("claude-code", true);
  assert.equal(servico.isAvailable("claude-code"), true);
  assert.equal(servico.listProviders().find((p) => p.name === "claude-code")?.disabled, false);
});
