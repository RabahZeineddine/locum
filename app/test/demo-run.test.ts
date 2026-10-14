import { before, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { ensureDemoRun } from "../src/fixtures/demo-run.js";

/** A fixture do run de demonstração, sobre um banco que já tem a versão antiga dela. */

before(() => {
  migrateDb();
});

test("ensureDemoRun sobre banco com a fixture antiga não falha e planta a nova", async () => {
  const novo = await ensureDemoRun();
  const ANTIGO = "fixture-run-pr-review";

  // Reproduz o banco antigo: mesmo run e aprovação, com os ids de antes.
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, novo));
  const [aprovacao] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, novo));
  const passos = await db.select().from(schema.steps).where(eq(schema.steps.runId, novo));
  assert.ok(run && aprovacao && passos.length > 0);
  await db.delete(schema.approvals).where(eq(schema.approvals.runId, novo));
  await db.delete(schema.steps).where(eq(schema.steps.runId, novo));
  await db.delete(schema.runs).where(eq(schema.runs.id, novo));
  await db.insert(schema.runs).values({ ...run, id: ANTIGO });
  await db.insert(schema.steps).values(passos.map((p) => ({ ...p, id: `${ANTIGO}-${p.stepKey}`, runId: ANTIGO })));
  await db
    .insert(schema.approvals)
    .values({ ...aprovacao, id: "fixture-approval-post", runId: ANTIGO, stepId: `${ANTIGO}-post` });

  assert.equal(await ensureDemoRun(), novo);
  const [plantado] = await db.select().from(schema.runs).where(eq(schema.runs.id, novo));
  assert.ok(plantado);
});
