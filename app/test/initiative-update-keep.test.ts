import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { InitiativeService } from "../src/services/initiative-service.js";
import { McpService } from "../src/services/mcp-service.js";

before(() => {
  migrateDb();
});

async function cadastrar(...nomes: string[]): Promise<void> {
  const mcp = new McpService();
  for (const name of nomes) {
    if (await mcp.get(name)) continue;
    await mcp.register({ name, transport: "stdio", command: ["true"] });
  }
}

async function servidoresDa(slug: string, service: InitiativeService): Promise<string[]> {
  const linha = (await service.get(slug))!;
  const linhas = await db
    .select()
    .from(schema.initiativeMcpServers)
    .where(eq(schema.initiativeMcpServers.initiativeId, linha.id));
  return linhas.map((l) => l.serverName).sort();
}

test("lista de servidores com nome repetido grava uma vez e não apaga a anterior", async () => {
  await cadastrar("srv-keep-a", "srv-keep-b");
  const service = new InitiativeService();
  const slug = `frente-${randomUUID()}`;
  await service.upsert({ slug, title: "T", objective: "o", doneCriteria: "d" });

  await service.setServers(slug, ["srv-keep-a"]);
  await service.setServers(slug, ["srv-keep-b", "srv-keep-b", "srv-keep-a"]);
  assert.deepEqual(await servidoresDa(slug, service), ["srv-keep-a", "srv-keep-b"]);

  await assert.rejects(service.setServers(slug, ["srv-keep-a", "nao-existe"]), /nao cadastrado/);
  assert.deepEqual(await servidoresDa(slug, service), ["srv-keep-a", "srv-keep-b"]);
});

test("atualizar sem prazo e sem meta mantém os dois, e null limpa", async () => {
  const service = new InitiativeService();
  const slug = `frente-${randomUUID()}`;
  await service.upsert({ slug, title: "T", objective: "o", doneCriteria: "d", dueAt: 1_900_000_000, goalRef: "OKR-1" });

  await service.upsert({ slug, title: "T2", objective: "o", doneCriteria: "d" });
  let linha = (await service.get(slug))!;
  assert.equal(linha.title, "T2");
  assert.equal(linha.dueAt, 1_900_000_000);
  assert.equal(linha.goalRef, "OKR-1");

  await service.upsert({ slug, title: "T2", objective: "o", doneCriteria: "d", dueAt: null, goalRef: null });
  linha = (await service.get(slug))!;
  assert.equal(linha.dueAt, null);
  assert.equal(linha.goalRef, null);
});
