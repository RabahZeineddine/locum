import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb } from "../src/db/migrate.js";
import { LANGUAGE_KEY } from "../src/services/i18n-service.js";
import { InitiativeService } from "../src/services/initiative-service.js";
import { settingsService } from "../src/services/settings-service.js";
import { translate } from "../src/services/text-service.js";

before(() => {
  migrateDb();
});

function raiz(): string {
  return process.env.LOCUM_INITIATIVES_DIR!;
}

test("upsert cria pasta e context.md em ingles, sem preferencia gravada", async () => {
  await settingsService.remove(LANGUAGE_KEY);
  const service = new InitiativeService();
  const slug = `frente-${randomUUID()}`;

  await service.upsert({ slug, title: "Minha Frente", objective: "obj", doneCriteria: "pronto" });

  const contextPath = join(raiz(), slug, "context.md");
  assert.ok(existsSync(contextPath));
  const conteudo = readFileSync(contextPath, "utf8");
  assert.equal(conteudo, translate("en", "initiatives.contextTemplate.initial", { title: "Minha Frente" }));
});

test("upsert em pt-BR quando i18n.language esta gravado", async () => {
  await settingsService.set(LANGUAGE_KEY, "pt-BR");
  try {
    const service = new InitiativeService();
    const slug = `frente-${randomUUID()}`;
    await service.upsert({ slug, title: "Frente PT", objective: "obj", doneCriteria: "pronto" });

    const conteudo = readFileSync(join(raiz(), slug, "context.md"), "utf8");
    assert.equal(conteudo, translate("pt-BR", "initiatives.contextTemplate.initial", { title: "Frente PT" }));
  } finally {
    await settingsService.remove(LANGUAGE_KEY);
  }
});

test("segundo upsert nao reescreve context.md editado a mao", async () => {
  await settingsService.remove(LANGUAGE_KEY);
  const service = new InitiativeService();
  const slug = `frente-${randomUUID()}`;
  await service.upsert({ slug, title: "T1", objective: "o1", doneCriteria: "d1" });

  const contextPath = join(raiz(), slug, "context.md");
  writeFileSync(contextPath, "editado a mao");

  await service.upsert({ slug, title: "T2", objective: "o2", doneCriteria: "d2" });

  assert.equal(readFileSync(contextPath, "utf8"), "editado a mao");
  const linha = await service.get(slug);
  assert.equal(linha?.title, "T2");
});

test("slug invalido e recusado", async () => {
  const service = new InitiativeService();
  await assert.rejects(() =>
    service.upsert({ slug: "Slug Invalido", title: "x", objective: "o", doneCriteria: "d" }),
  );
});

test("setServers valida contra os servidores cadastrados", async () => {
  const service = new InitiativeService();
  const slug = `frente-${randomUUID()}`;
  await service.upsert({ slug, title: "T", objective: "o", doneCriteria: "d" });

  await assert.rejects(() => service.setServers(slug, ["servidor-que-nao-existe"]));
  const resultado = await service.setServers(slug, []);
  assert.deepEqual(resultado.affectedAgents, []);
});

test("setWorkspaces recusa caminho relativo, inexistente e arquivo", async () => {
  const service = new InitiativeService();
  const slug = `frente-${randomUUID()}`;
  await service.upsert({ slug, title: "T", objective: "o", doneCriteria: "d" });

  await assert.rejects(() => service.setWorkspaces(slug, [{ repoPath: "relativo" }]));
  await assert.rejects(() => service.setWorkspaces(slug, [{ repoPath: "/nao/existe/de/verdade/mesmo" }]));

  const arquivo = join(tmpdir(), `locum-arquivo-${randomUUID()}.txt`);
  writeFileSync(arquivo, "x");
  try {
    await assert.rejects(() => service.setWorkspaces(slug, [{ repoPath: arquivo }]));
  } finally {
    rmSync(arquivo);
  }

  const pasta = mkdtempSync(join(tmpdir(), "locum-workspace-"));
  try {
    await service.setWorkspaces(slug, [{ repoPath: pasta }]);
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
});

test("overview devolve fato cru com data fixa", async () => {
  const service = new InitiativeService();
  const slug = `frente-${randomUUID()}`;
  await service.upsert({ slug, title: "T", objective: "o", doneCriteria: "d" });

  const dezDiasDepois = () => Date.now() + 10 * 86_400_000;
  const overview = await service.overview(dezDiasDepois);
  const linha = overview.find((item) => item.slug === slug);
  assert.ok(linha);
  assert.equal(linha!.daysSinceUpdate, 10);
});

test("deliveries lista os .md de entregas/, o mais novo primeiro", async () => {
  const service = new InitiativeService();
  const slug = `frente-${randomUUID()}`;
  await service.upsert({ slug, title: "Entregas", objective: "obj", doneCriteria: "pronto" });

  const pasta = join(raiz(), slug, "entregas");
  mkdirSync(pasta, { recursive: true });
  writeFileSync(join(pasta, "2026-W38.md"), "# W-38\n");
  writeFileSync(join(pasta, "2026-W39.md"), "# W-39\n");
  writeFileSync(join(pasta, "rascunho.txt"), "fora");

  const entregas = await service.deliveries(slug);
  assert.deepEqual(
    entregas.map((entrega) => entrega.file),
    ["entregas/2026-W39.md", "entregas/2026-W38.md"],
  );
  assert.equal(entregas[0]?.content, "# W-39\n");
});
