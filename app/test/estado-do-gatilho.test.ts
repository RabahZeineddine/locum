import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { schema } from "../src/db/index.js";
import { ESTADO_DO_GATILHO, esquecerGatilho } from "../src/triggers/estado-do-gatilho.js";
import { AgentSpec } from "../src/config/types.js";
import { AgentService } from "../src/services/agent-service.js";
import { TriggerService } from "../src/services/trigger-service.js";
import { comTrava } from "../src/triggers/trava.js";
import { bancoDeTeste } from "./helpers/db.js";

type Banco = ReturnType<typeof bancoDeTeste>;

/** Grava uma linha de cada forma declarada, para o gatilho `id`. */
function gravarEstado(db: Banco, id: string): void {
  for (const e of ESTADO_DO_GATILHO) {
    if (e.onde === "cursor") {
      const fonte = e.fonte.com === "id" ? `${e.fonte.nome}:${id}` : e.fonte.nome;
      const chave = e.chave === "id" ? id : e.chave === "termina-no-id" ? `channel:T:C:${id}` : "qualquer";
      db.insert(schema.cursors).values({ source: fonte, key: chave, value: "1" }).run();
    } else {
      db.insert(schema.settings).values({ key: `${e.chave}:${id}`, value: "conta" }).run();
    }
  }
}

const restos = (db: Banco, id: string): number =>
  db.select().from(schema.cursors).all().filter((c) => c.source.includes(id) || c.key.includes(id)).length +
  db.select().from(schema.settings).all().filter((s) => s.key.includes(id)).length;

test("esquecerGatilho apaga o estado de cada forma declarada e só o do gatilho dado", () => {
  const db = bancoDeTeste();
  gravarEstado(db, "g1");
  gravarEstado(db, "g1-outro");
  assert.ok(restos(db, "g1") > 0);
  esquecerGatilho(db, "g1");
  const sobra = [
    ...db.select().from(schema.cursors).all().filter((c) => /(^|:)g1$/.test(c.key) || /:g1$/.test(c.source)),
    ...db.select().from(schema.settings).all().filter((s) => s.key.endsWith(":g1")),
  ];
  assert.deepEqual(sobra, []);
  // o gatilho de nome parecido não perde nada
  assert.equal(restos(db, "g1-outro"), ESTADO_DO_GATILHO.length);
});

test("o formato dos cursores de verdade (teams, falhas do filtro, github, relógio) é coberto", () => {
  const db = bancoDeTeste();
  const id = "gat-7";
  db.insert(schema.cursors).values([
    { source: "teams", key: `inbox:${id}`, value: "1" },
    { source: "teams", key: `channel:t1:c1:${id}`, value: "1" },
    { source: `teams-filtro-ia-falhas:${id}`, key: "msg-1", value: "1" },
    { source: "gatilho-cursor", key: id, value: "k" },
    { source: "gatilho-descartes", key: id, value: "[]" },
    { source: "gatilho-erro", key: id, value: "{}" },
    { source: "scheduler", key: id, value: "1" },
    { source: "scheduler-retry", key: id, value: "[]" },
    { source: "teams", key: "inbox:outro", value: "preservado" },
    { source: "github", key: "owner/repo", value: "preservado" },
  ]).run();
  db.insert(schema.settings).values({ key: `teams.account.inbox:${id}`, value: "a" }).run();
  esquecerGatilho(db, id);
  assert.deepEqual(db.select().from(schema.cursors).all().map((c) => c.value).sort(), ["preservado", "preservado"]);
  assert.equal(db.select().from(schema.settings).all().filter((s) => s.key.includes(id)).length, 0);
});

test("TriggerService.remove esquece o estado do gatilho", async () => {
  const db = bancoDeTeste();
  await new AgentService(db).upsert(
    AgentSpec.parse({ id: "vigia", name: "Vigia", steps: [{ type: "model", key: "ler", name: "Ler", model: "ollama/m", prompt: "leia" }] }),
    undefined,
    "human",
  );
  const triggers = new TriggerService(db);
  const g = await triggers.set("vigia", { kind: "schedule", everyMinutes: 30 });
  db.insert(schema.cursors).values([
    { source: "teams", key: `inbox:${g.id}`, value: "1" },
    { source: "scheduler", key: g.id, value: "1" },
  ]).run();
  db.insert(schema.settings).values({ key: `teams.account.inbox:${g.id}`, value: "a" }).run();
  assert.equal(await triggers.remove(g.id), true);
  assert.equal(db.select().from(schema.cursors).where(and(eq(schema.cursors.key, g.id))).all().length, 0);
  assert.equal(db.select().from(schema.cursors).all().length, 0);
  assert.equal(db.select().from(schema.settings).all().length, 0);
});

test("TriggerService.remove espera a batida que segura a trava do gatilho", async () => {
  const db = bancoDeTeste();
  await new AgentService(db).upsert(
    AgentSpec.parse({ id: "vigia", name: "Vigia", steps: [{ type: "model", key: "ler", name: "Ler", model: "ollama/m", prompt: "leia" }] }),
    undefined,
    "human",
  );
  const triggers = new TriggerService(db);
  const g = await triggers.set("vigia", { kind: "schedule", everyMinutes: 30 });
  let solta!: () => void;
  const batida = comTrava(`gatilho:${g.id}`, () => new Promise<void>((r) => (solta = r)));
  let removeu = false;
  const removendo = triggers.remove(g.id).then(() => (removeu = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(removeu, false);
  solta();
  await batida;
  await removendo;
  assert.equal(removeu, true);
});
