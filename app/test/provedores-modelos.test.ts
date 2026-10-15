import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProviders } from "../src/providers/registry.js";
import { ProviderService } from "../src/services/provider-service.js";
import { SecretService } from "../src/services/secret-service.js";
import { SettingsService } from "../src/services/settings-service.js";
import { bancoDeTeste } from "./helpers/db.js";

const VARIAVEIS = ["OLLAMA_BASE_URL", "GLM_API_KEY", "GLM_BASE_URL"] as const;
const guardadas: Record<string, string | undefined> = {};

// O ambiente de quem roda o teste não pode decidir o resultado.
beforeEach(() => {
  for (const v of VARIAVEIS) {
    guardadas[v] = process.env[v];
    delete process.env[v];
  }
});
afterEach(() => {
  for (const v of VARIAVEIS) {
    if (guardadas[v] === undefined) delete process.env[v];
    else process.env[v] = guardadas[v];
  }
});

function montar() {
  const db = bancoDeTeste();
  const secrets = new SecretService(mkdtempSync(join(tmpdir(), "locum-provedores-")));
  secrets.useBackend({
    available: () => true,
    encrypt: (plain) => Buffer.from(plain),
    decrypt: (blob) => blob.toString(),
  });
  const settings = new SettingsService(db);
  const novo = () => new ProviderService(db, buildProviders(), secrets, settings);
  return { servico: novo(), novo };
}

const ollama = (s: ProviderService) => s.listProviders().find((p) => p.name === "ollama");

test("endereço do Ollama salvo na tela vale na hora, sem reiniciar", async () => {
  const { servico } = montar();
  assert.equal(ollama(servico)?.available, false);

  await servico.setOllamaUrl("http://127.0.0.1:11434/v1");

  assert.equal(ollama(servico)?.available, true);
  assert.equal(servico.entries().ollama?.catalog?.().url, "http://127.0.0.1:11434/v1/models");
  assert.deepEqual(await servico.ollamaUrl(), { saved: "http://127.0.0.1:11434/v1", env: null });
});

test("o endereço salvo vence a variável de ambiente, e apagar volta a ela", async () => {
  process.env.OLLAMA_BASE_URL = "http://da-variavel:11434/v1";
  const { servico } = montar();
  await servico.loadSecrets();
  assert.equal(servico.entries().ollama?.catalog?.().url, "http://da-variavel:11434/v1/models");

  await servico.setOllamaUrl("http://salvo:11434/v1");
  assert.equal(servico.entries().ollama?.catalog?.().url, "http://salvo:11434/v1/models");
  assert.deepEqual(await servico.ollamaUrl(), { saved: "http://salvo:11434/v1", env: "http://da-variavel:11434/v1" });

  await servico.setOllamaUrl(null);
  assert.equal(servico.entries().ollama?.catalog?.().url, "http://da-variavel:11434/v1/models");
  assert.equal((await servico.ollamaUrl()).saved, null);
});

test("o endereço salvo sobrevive a um serviço novo, como na próxima abertura do app", async () => {
  const { servico, novo } = montar();
  await servico.setOllamaUrl("http://127.0.0.1:11434/v1/");

  const reaberto = novo();
  await reaberto.loadSecrets();
  assert.equal(ollama(reaberto)?.available, true);
  // A barra final não vai duas vezes para o catálogo.
  assert.equal(reaberto.entries().ollama?.catalog?.().url, "http://127.0.0.1:11434/v1/models");
});

test("endereço que não é http nem https é recusado e nada é gravado", async () => {
  const { servico } = montar();
  await assert.rejects(servico.setOllamaUrl("ollama.local"), /endereço/);
  await assert.rejects(servico.setOllamaUrl("ftp://ollama.local"), /endereço/);
  assert.equal((await servico.ollamaUrl()).saved, null);
  assert.equal(ollama(servico)?.available, false);
});

test("GLM só aparece quando já está configurado nesta máquina", async () => {
  const { servico } = montar();
  const glm = () => servico.listProviders().find((p) => p.name === "glm");

  assert.equal(glm()?.visible, false);
  // Os de fábrica públicos continuam à mostra.
  assert.equal(servico.listProviders().find((p) => p.name === "openai")?.visible, true);

  process.env.GLM_API_KEY = "chave-de-mentira";
  assert.equal(glm()?.visible, true);
  delete process.env.GLM_API_KEY;
  assert.equal(glm()?.visible, false);

  // Chave guardada no cofre, sem endereço ainda: o GLM não responde, mas já está configurado.
  await servico.setSecret("glm", "chave-no-cofre");
  assert.equal(glm()?.available, false);
  assert.equal(glm()?.visible, true);
});

test("GLM desligado continua na tela, para religar ou esquecer a chave", async () => {
  const { servico } = montar();
  const glm = () => servico.listProviders().find((p) => p.name === "glm");

  await servico.setSecret("glm", "chave-no-cofre");
  await servico.setEnabled("glm", false);

  assert.equal(glm()?.disabled, true);
  assert.equal(glm()?.visible, true);
});
