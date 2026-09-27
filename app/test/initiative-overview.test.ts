import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { DEFAULT_STALE_DAYS, InitiativeService } from "../src/services/initiative-service.js";
import { settingsService } from "../src/services/settings-service.js";

const STALE_DAYS_KEY = "initiatives.staleDays";

before(() => {
  migrateDb();
});

/** Relogio fixo, para o teste nao depender de quando ele roda. */
const AGORA_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
const agora = () => AGORA_MS;

async function novaIniciativa(diasParados: number): Promise<string> {
  const slug = `iniciativa-${randomUUID()}`;
  const service = new InitiativeService();
  await service.upsert({ slug, title: "Iniciativa", objective: "obj", doneCriteria: "pronto" });

  const atualizadaEm = Math.floor(AGORA_MS / 1000) - diasParados * 86_400;
  await db.update(schema.initiatives).set({ updatedAt: atualizadaEm }).where(eq(schema.initiatives.slug, slug));

  return slug;
}

test("com o padrao de 7 dias, iniciativa parada ha 7 dias entra como stale", async () => {
  await settingsService.remove(STALE_DAYS_KEY);
  const service = new InitiativeService();
  const slug = await novaIniciativa(7);

  const linha = (await service.overview(agora)).find((l) => l.slug === slug);

  assert.ok(linha);
  assert.equal(linha!.daysSinceUpdate, 7);
  assert.equal(linha!.stale, true);
});

test("com staleDays em 3, iniciativa parada ha 3 dias entra como stale", async () => {
  await settingsService.set(STALE_DAYS_KEY, "3");
  try {
    const service = new InitiativeService();
    const slug = await novaIniciativa(3);

    const linha = (await service.overview(agora)).find((l) => l.slug === slug);

    assert.ok(linha);
    assert.equal(linha!.daysSinceUpdate, 3);
    assert.equal(linha!.stale, true);
    assert.equal(await service.staleDays(), 3);
  } finally {
    await settingsService.remove(STALE_DAYS_KEY);
  }
});

test("valor gravado invalido cai para o padrao", async () => {
  await settingsService.set(STALE_DAYS_KEY, "banana");
  try {
    const service = new InitiativeService();
    assert.equal(await service.staleDays(), DEFAULT_STALE_DAYS);
  } finally {
    await settingsService.remove(STALE_DAYS_KEY);
  }
});
