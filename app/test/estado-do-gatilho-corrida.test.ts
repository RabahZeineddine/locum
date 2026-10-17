import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { schema } from "../src/db/index.js";
import { registrarDescartes } from "../src/triggers/descartes.js";
import { registrarErro } from "../src/triggers/erros.js";
import { ESTADO_DO_GATILHO, esquecerGatilho, gravarCursorDoGatilho, gravarSettingDoGatilho } from "../src/triggers/estado-do-gatilho.js";
import type { TriggerConfig } from "../src/config/types.js";
import type { ExecutionService } from "../src/services/execution-service.js";
import type { McpService } from "../src/services/mcp-service.js";
import type { SlackService } from "../src/services/slack-service.js";
import type { TriggerEntry, TriggerService } from "../src/services/trigger-service.js";
import { Scheduler, type PollFn } from "../src/triggers/scheduler.js";
import { bancoDeTeste } from "./helpers/db.js";

type Banco = ReturnType<typeof bancoDeTeste>;

function comGatilho(db: Banco, id: string): void {
  db.insert(schema.agents).values({ id: "dono", name: "dono" }).onConflictDoNothing().run();
  db.insert(schema.triggers).values({ id, agentId: "dono", kind: "schedule", config: { kind: "schedule", everyMinutes: 30 }, enabled: true }).run();
}
const cursores = (db: Banco) => db.select().from(schema.cursors).all();

/** Uma linha de cada forma declarada, para o gatilho `id`. */
function linhasDeclaradas(id: string): { source: string; key: string }[] {
  return ESTADO_DO_GATILHO.flatMap((e) =>
    e.onde !== "cursor"
      ? []
      : [{ source: e.fonte.com === "id" ? `${e.fonte.nome}:${id}` : e.fonte.nome, key: e.chave === "id" ? id : e.chave === "termina-no-id" ? `channel:T:C:${id}` : "qualquer" }],
  );
}

test("gravar estado de gatilho que não existe mais descarta, em todas as formas declaradas", () => {
  const db = bancoDeTeste();
  for (const linha of linhasDeclaradas("sumiu")) assert.equal(gravarCursorDoGatilho(db, "sumiu", linha, "1"), false);
  assert.equal(gravarSettingDoGatilho(db, "sumiu", "teams.account.inbox", "conta"), false);
  assert.deepEqual(cursores(db), []);
  assert.equal(db.select().from(schema.settings).all().length, 0);
});

test("com o gatilho existindo grava e atualiza, e o esquecer leva tudo", () => {
  const db = bancoDeTeste();
  comGatilho(db, "g1");
  for (const linha of linhasDeclaradas("g1")) {
    assert.equal(gravarCursorDoGatilho(db, "g1", linha, "1"), true);
    assert.equal(gravarCursorDoGatilho(db, "g1", linha, "2"), true);
  }
  assert.equal(gravarSettingDoGatilho(db, "g1", "teams.account.inbox", "conta"), true);
  assert.equal(cursores(db).every((c) => c.value === "2"), true);
  esquecerGatilho(db, "g1");
  assert.deepEqual(cursores(db), []);
  assert.equal(db.select().from(schema.settings).all().length, 0);
});

test("linha que a tabela não declara para o gatilho é erro de programação", () => {
  const db = bancoDeTeste();
  comGatilho(db, "g1");
  assert.throws(() => gravarCursorDoGatilho(db, "g1", { source: "fonte-nova", key: "g1" }, "1"), /nao declara/);
  assert.throws(() => gravarCursorDoGatilho(db, "g1", { source: "scheduler", key: "outro-id" }, "1"), /nao declara/);
});

test("descarte e último erro de gatilho removido não são gravados", async () => {
  const db = bancoDeTeste();
  await registrarDescartes(db, "sumiu", [{ pr: "a/b#1", motivo: "x" } as never], Date.now());
  await registrarErro(db, "sumiu", { em: Date.now(), tipo: "batida", texto: "falhou" });
  assert.deepEqual(cursores(db), []);
});

test("o gatilho some entre a conferência da batida e a gravação final: nada fica", async () => {
  const db = bancoDeTeste();
  comGatilho(db, "g1");
  const entrada = { id: "g1", agentId: "dono", config: { kind: "poll", source: "github", owner: "org", repoMatch: ".", authorship: "mine", includeDrafts: false, everyMinutes: 15 } as TriggerConfig, enabled: true } as TriggerEntry;
  const triggers = { enabled: async () => [entrada], list: async () => [entrada], get: async () => entrada, pendencias: async () => [] } as unknown as TriggerService;
  // Outro processo arquiva a automação no meio da varredura: o gatilho e o estado dele saem.
  const poll: PollFn = async () => {
    esquecerGatilho(db, "g1");
    db.delete(schema.triggers).where(eq(schema.triggers.id, "g1")).run();
    throw new Error("a varredura falhou");
  };
  const scheduler = new Scheduler(db, triggers, {} as ExecutionService, {} as McpService, {} as SlackService, poll, undefined, async () => "eu");
  await scheduler.tick({ at: Date.UTC(2026, 9, 2, 3, 0, 0) });
  assert.deepEqual(cursores(db), []);
});
