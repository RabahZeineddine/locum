import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import { migrateDb, SYSTEM_CONTEXT_AGENT_ID } from "../src/db/migrate.js";
import { Executor } from "../src/executor/executor.js";
import { buildGate } from "../src/executor/build.js";
import { McpRegistry } from "../src/mcp/registry.js";
import type { Runtime } from "../src/runtimes/types.js";
import { LocalFolderContextStore } from "../src/services/context-store.js";
import { InitiativeService } from "../src/services/initiative-service.js";

// Mesmo banco do modulo dos outros testes de executor.
before(() => {
  migrateDb();
});

function montarExecutor() {
  return new Executor({
    mcp: new McpRegistry(new Map()),
    runtimes: new Map<string, Runtime>(),
    gate: buildGate(),
    machineId: "maquina-de-teste",
  });
}

async function novaIniciativa() {
  const slug = `iniciativa-${randomUUID()}`;
  const service = new InitiativeService();
  await service.upsert({ slug, title: "Titulo", objective: "objetivo", doneCriteria: "pronto" });
  return { slug, service };
}

const usoDoAgent = async () => {
  const hoje = new Date().toISOString().slice(0, 10);
  const [linha] = await db
    .select()
    .from(schema.usageDaily)
    .where(and(eq(schema.usageDaily.day, hoje), eq(schema.usageDaily.agentId, SYSTEM_CONTEXT_AGENT_ID)));
  return linha;
};

test("propor cria run pausado, passo aguardando aprovacao e pendencia pendente", async () => {
  const { slug, service } = await novaIniciativa();
  const { approvalId } = await service.proposeContextUpdate({
    slug,
    mode: "append",
    content: "\nnovo paragrafo\n",
    origin: "teste",
  });

  const [aprovacao] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
  assert.equal(aprovacao?.status, "pending");
  assert.equal(aprovacao?.kind, "context.update");

  const [passo] = await db.select().from(schema.steps).where(eq(schema.steps.id, aprovacao!.stepId));
  assert.equal(passo?.status, "awaiting_approval");

  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, aprovacao!.runId));
  assert.equal(run?.status, "paused");
  assert.ok(run?.startedAt);
});

test("aprovar em modo append acrescenta o bloco e atualiza o hash da iniciativa", async () => {
  const { slug, service } = await novaIniciativa();
  const { approvalId } = await service.proposeContextUpdate({
    slug,
    mode: "append",
    content: "bloco novo",
    origin: "teste",
  });

  const executor = montarExecutor();
  const resultado = await executor.decide(approvalId, "approved");
  assert.deepEqual(resultado, { status: "approved", run: "done" });

  const conteudo = await (await service.get(slug))!;
  assert.ok(conteudo.contextHash);
  assert.ok(conteudo.contextUpdatedAt);
});

test("aprovar em modo replace com baseHash certo substitui o arquivo inteiro", async () => {
  const { slug, service } = await novaIniciativa();
  const antes = (await service.get(slug))!;
  const hashAtual = await new LocalFolderContextStore(antes.contextPath).hash("context.md");

  const { approvalId } = await service.proposeContextUpdate({
    slug,
    mode: "replace",
    baseHash: hashAtual!,
    content: "conteudo totalmente novo",
    origin: "teste",
  });

  const executor = montarExecutor();
  assert.deepEqual(await executor.decide(approvalId, "approved"), { status: "approved", run: "done" });

  const depois = (await service.get(slug))!;
  assert.notEqual(depois.contextHash, antes.contextHash);
});

test("rejeitar nao escreve nada e o passo fica pulado", async () => {
  const { slug, service } = await novaIniciativa();
  const antes = (await service.get(slug))!;

  const { approvalId } = await service.proposeContextUpdate({
    slug,
    mode: "append",
    content: "nao deveria aparecer",
    origin: "teste",
  });

  const executor = montarExecutor();
  assert.deepEqual(await executor.decide(approvalId, "rejected"), { status: "rejected", run: "done" });

  const depois = (await service.get(slug))!;
  assert.equal(depois.contextHash, antes.contextHash);
  const [aprovacao] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
  const [passo] = await db.select().from(schema.steps).where(eq(schema.steps.id, aprovacao!.stepId));
  assert.equal(passo?.status, "skipped");
  assert.equal(passo?.error, "rejected");
});

test("replace com arquivo mudado por fora vira conflito, e a pendencia fecha sem publicar", async () => {
  const { slug, service } = await novaIniciativa();
  const antes = (await service.get(slug))!;
  const hashAtual = await new LocalFolderContextStore(antes.contextPath).hash("context.md");

  const { approvalId } = await service.proposeContextUpdate({
    slug,
    mode: "replace",
    baseHash: hashAtual!,
    content: "versao proposta",
    origin: "teste",
  });

  // Outra proposta aprovada por fora muda o arquivo antes desta decidir.
  const concorrente = await service.proposeContextUpdate({
    slug,
    mode: "append",
    content: "mudanca concorrente",
    origin: "teste",
  });
  const executor = montarExecutor();
  await executor.decide(concorrente.approvalId, "approved");

  const resultado = await executor.decide(approvalId, "approved");
  assert.deepEqual(resultado, { status: "conflict", run: "done" });

  const [aprovacao] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
  assert.equal(aprovacao?.status, "conflict");
  const [passo] = await db.select().from(schema.steps).where(eq(schema.steps.id, aprovacao!.stepId));
  assert.equal(passo?.status, "skipped");
  assert.equal(passo?.error, "publish_conflict");
});

test("decidir uma proposta nao soma run no gasto do dia: o agent de sistema nao chama modelo", async () => {
  const { slug, service } = await novaIniciativa();
  const antesUso = (await usoDoAgent())?.runs ?? 0;

  const { approvalId } = await service.proposeContextUpdate({
    slug,
    mode: "append",
    content: "nao deveria contar",
    origin: "teste",
  });
  const executor = montarExecutor();
  await executor.decide(approvalId, "approved");

  const depoisUso = (await usoDoAgent())?.runs ?? 0;
  assert.equal(depoisUso, antesUso);

  const { approvalId: approvalIdRejeitado } = await service.proposeContextUpdate({
    slug,
    mode: "append",
    content: "tambem nao deveria contar",
    origin: "teste",
  });
  await executor.decide(approvalIdRejeitado, "rejected");

  const usoFinal = (await usoDoAgent())?.runs ?? 0;
  assert.equal(usoFinal, antesUso);
});
