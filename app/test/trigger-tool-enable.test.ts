import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentSpec } from "../src/config/types.js";
import { AgentService } from "../src/services/agent-service.js";
import { TriggerService } from "../src/services/trigger-service.js";
import { bancoDeTeste } from "./helpers/db.js";

async function montar() {
  const db = bancoDeTeste();
  await new AgentService(db).upsert(
    AgentSpec.parse({
      id: "vigia",
      name: "Vigia",
      steps: [{ type: "model", key: "ler", name: "Ler", model: "ollama/m", prompt: "leia" }],
    }),
    undefined,
    "human",
  );
  return new TriggerService(db);
}

test("ferramenta não liga gatilho, e pessoa liga", async () => {
  const triggers = await montar();
  await assert.rejects(
    triggers.set("vigia", { kind: "schedule", everyMinutes: 1 }, { enabled: true, fromTool: true }),
    /so e ligado por uma pessoa/,
  );
  const criado = await triggers.set("vigia", { kind: "schedule", everyMinutes: 30 }, { fromTool: true });
  assert.equal(criado.enabled, false);
  assert.equal((await triggers.setEnabled(criado.id, true)).enabled, true);
});

test("ferramenta que troca a config de um gatilho ligado desliga, e repetir a mesma config mantém ligado", async () => {
  const triggers = await montar();
  const criado = await triggers.set("vigia", { kind: "schedule", everyMinutes: 30 });
  await triggers.setEnabled(criado.id, true);

  const igual = await triggers.set("vigia", { kind: "schedule", everyMinutes: 30 }, { id: criado.id, fromTool: true });
  assert.equal(igual.enabled, true);

  const trocado = await triggers.set("vigia", { kind: "schedule", everyMinutes: 1 }, { id: criado.id, fromTool: true });
  assert.equal(trocado.enabled, false);
});
