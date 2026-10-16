import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { schema } from "../src/db/index.js";
import { motivoDoEventoGuardado } from "../src/triggers/reavaliar.js";
import { bancoDeTeste } from "./helpers/db.js";

const pr = (n: number) => ({ owner: "acme", repoName: "api", pull: n, headSha: `s${n}`, author: "ana", prOwner: "acme", prRepo: "api", prNumber: n, title: `PR ${n}`, description: "", diff: `d${n}`, repo: "acme/api" });

async function eventoCom(prs: ReturnType<typeof pr>[]) {
  const db = bancoDeTeste();
  await db.insert(schema.events).values({ id: "e1", source: "teams", externalId: "x", payload: { ...prs[0], prs, prLinks: [], prsTexto: "" } });
  return db;
}
const deps = (estados: Record<number, string>) => ({
  buscar: (async (_o: string, _r: string, n: number) => ({ owner: "acme", repoName: "api", pull: n, headSha: `s${n}`, author: "ana", state: estados[n] ?? "open", draft: false })) as never,
  viewer: async () => null,
  revisados: async () => new Set<string>(),
});

test("depois da pausa, o PR que fechou sai da lista e os outros seguem", async () => {
  const db = await eventoCom([pr(7), pr(9)]);
  assert.equal(await motivoDoEventoGuardado("e1", db, deps({ 7: "closed" })), null);
  const [e] = await db.select().from(schema.events).where(eq(schema.events.id, "e1"));
  const p = e!.payload as { prs: { prNumber: number }[]; prNumber: number; prsTexto: string };
  assert.deepEqual(p.prs.map((x) => x.prNumber), [9]);
  assert.equal(p.prNumber, 9);
  assert.doesNotMatch(p.prsTexto, /#7/);
});

test("depois da pausa, o evento só deixa de valer quando nenhum PR vale", async () => {
  const db = await eventoCom([pr(7), pr(9)]);
  assert.equal(await motivoDoEventoGuardado("e1", db, deps({ 7: "closed", 9: "closed" })), "fechado");
});
