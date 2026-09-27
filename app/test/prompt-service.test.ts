import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrateDb } from "../src/db/migrate.js";
import { PromptService } from "../src/services/prompt-service.js";

before(() => {
  migrateDb();
});

test("upsert cria e reaproveita, versao nova so quando o corpo muda", async () => {
  const service = new PromptService();
  const name = `prompt-${randomUUID()}`;

  const v1 = await service.upsert(name, "corpo 1", "primeira");
  assert.equal(v1.version, 1);

  const semMudanca = await service.upsert(name, "corpo 1", "nota diferente, corpo igual");
  assert.equal(semMudanca.version, 1);

  const v2 = await service.upsert(name, "corpo 2", "mudou");
  assert.equal(v2.version, 2);

  const versoes = await service.versions(name);
  assert.equal(versoes.length, 2);
  assert.equal(versoes[0]!.version, 2);
});

test("get devolve undefined para nome desconhecido", async () => {
  const service = new PromptService();
  assert.equal(await service.get(`nao-existe-${randomUUID()}`), undefined);
});

test("list devolve o prompt criado", async () => {
  const service = new PromptService();
  const name = `prompt-${randomUUID()}`;
  await service.upsert(name, "corpo", "nota");

  const todos = await service.list();
  assert.ok(todos.some((prompt) => prompt.name === name && prompt.body === "corpo"));
});
