import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { digestDeliverHandler, markdownDaEntrega } from "../src/digest/action.js";
import { buildDigestProposal } from "../src/digest/proposal.js";
import { InitiativeService } from "../src/services/initiative-service.js";

before(() => {
  migrateDb();
});

const leitura = {
  headline: "W-40 (28/09 a 04/10), coluna 5/10: Cotação abaixo do alvo.",
  items: [
    { channel: "Parcerias", subject: "Toil | quantidade", kind: "info", summary: "16 · planilha vazia\nFonte: /api/toil/PAR." },
    { channel: "Novos Produtos", subject: "SLO · Cotação", kind: "needs_reply", summary: "93,41% · alvo 99% · abaixo" },
  ],
};

test("a entrega vira uma tabela por canal, com o resultado na frente", () => {
  const md = markdownDaEntrega(buildDigestProposal(leitura));
  assert.match(md, /^# W-40 \(28\/09 a 04\/10\)/);
  assert.match(md, /\| Toil \\\| quantidade \| 16 · planilha vazia \| ok \| Fonte: \/api\/toil\/PAR\. \|/);
  assert.match(md, /\| SLO · Cotação \| 93,41% · alvo 99% · abaixo \| pede atenção \|  \|/);
});

test("aprovar o digest de um run de iniciativa grava a entrega na pasta dela", async () => {
  const slug = `iniciativa-${randomUUID()}`;
  const service = new InitiativeService();
  await service.upsert({ slug, title: "Titulo", objective: "objetivo", doneCriteria: "pronto" });
  // Um run qualquer da iniciativa: a proposta de contexto cria um.
  const { approvalId } = await service.proposeContextUpdate({ slug, mode: "append", content: "x", origin: "teste" });
  const [aprovacao] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
  const runId = aprovacao!.runId;

  const handler = digestDeliverHandler();
  const proposta = buildDigestProposal(leitura);
  await handler.publish(proposta, `${runId}:passo`);
  // Repetir depois de uma queda reescreve o mesmo arquivo, sem duplicar.
  await handler.publish(proposta, `${runId}:passo`);

  const entregas = await service.deliveries(slug);
  assert.equal(entregas.length, 1);
  assert.match(entregas[0]!.file, new RegExp(`^entregas/\\d{4}-\\d{2}-\\d{2}-${runId.slice(0, 8)}\\.md$`));
  assert.match(entregas[0]!.content, /## Novos Produtos/);
});

test("digest de run sem iniciativa não grava nada e não falha", async () => {
  await digestDeliverHandler().publish(buildDigestProposal(leitura), `${randomUUID()}:passo`);
});
