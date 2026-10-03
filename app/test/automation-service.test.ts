import { test } from "node:test";
import assert from "node:assert/strict";
import { slackReplySpec } from "../src/examples/agents.js";
import { AgentService } from "../src/services/agent-service.js";
import { AutomationService } from "../src/services/automation-service.js";
import type { ExecutionService } from "../src/services/execution-service.js";
import { TriggerService } from "../src/services/trigger-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/** A automação: spec e gatilhos gravados juntos pelo canvas. */

function montar() {
  const db = bancoDeTeste();
  const agents = new AgentService(db);
  const triggers = new TriggerService(db);
  const iniciados: { agentId?: string; triggerId?: string; eventId: string | null }[] = [];
  const executions = {
    startForEvent: async (input: { agentId?: string; triggerId?: string; eventId: string | null }) => {
      iniciados.push(input);
      return { runId: `run-${iniciados.length}`, status: "queued" };
    },
  } as unknown as ExecutionService;
  return { automations: new AutomationService(agents, triggers, executions), triggers, iniciados };
}

const spec = { ...slackReplySpec, id: "canal-suporte", name: "Canal de suporte" };

test("automação nova grava spec e gatilhos, e o gatilho nasce desligado", async () => {
  const { automations } = montar();
  const salva = await automations.save({
    spec,
    triggers: [{ config: { kind: "slack-channel", channels: ["C1"] } }],
    note: "",
    create: true,
  });
  assert.equal(salva.version.version, 1);
  assert.equal(salva.triggers.length, 1);
  assert.equal(salva.triggers[0]?.enabled, false);
  assert.deepEqual(salva.triggers[0]?.config, { kind: "slack-channel", channels: ["C1"], everyMinutes: 5 });

  await assert.rejects(
    automations.save({ spec, triggers: [], note: "", create: true }),
    /já existe/,
  );
});

test("gatilho inválido recusa a gravação inteira, sem versão nova", async () => {
  const { automations } = montar();
  await automations.save({ spec, triggers: [], note: "", create: true });

  await assert.rejects(
    automations.save({
      spec: { ...spec, name: "Outro nome" },
      triggers: [{ config: { kind: "cron", expression: "toda hora" } }],
      note: "troca",
    }),
    /cron/,
  );
  const atual = await automations.get(spec.id);
  assert.equal(atual?.version.version, 1);
});

test("gatilho que sai do canvas sai do cadastro, e o que fica mantém o interruptor", async () => {
  const { automations, triggers } = montar();
  const primeira = await automations.save({
    spec,
    triggers: [{ config: { kind: "manual" } }, { config: { kind: "cron", expression: "0 9 * * 1-5" } }],
    note: "",
    create: true,
  });
  const cron = primeira.triggers.find((g) => g.config.kind === "cron")!;
  await triggers.setEnabled(cron.id, true);

  const segunda = await automations.save({
    spec: { ...spec, layout: { write: { x: 10, y: 20 } } },
    triggers: [{ id: cron.id, config: { kind: "cron", expression: "0 9 * * 1-5" } }],
    note: "tira o manual",
  });
  assert.equal(segunda.triggers.length, 1);
  assert.equal(segunda.triggers[0]?.enabled, true);
  assert.deepEqual(segunda.version.spec.layout, { write: { x: 10, y: 20 } });
});

test("interruptor liga e desliga todos os gatilhos, e executar agora usa o manual", async () => {
  const { automations, iniciados } = montar();
  const salva = await automations.save({
    spec,
    triggers: [{ config: { kind: "manual" } }, { config: { kind: "slack-channel", channels: ["C1"] } }],
    note: "",
    create: true,
  });

  const ligados = await automations.setEnabled(spec.id, true);
  assert.ok(ligados.every((g) => g.enabled));

  await automations.runNow(spec.id);
  const manual = salva.triggers.find((g) => g.config.kind === "manual")!;
  assert.deepEqual(iniciados[0], { eventId: null, agentId: spec.id, triggerId: manual.id, wait: false });
});

test("identificador sugerido sai do nome, sem acento, e não colide", async () => {
  const { automations } = montar();
  assert.equal(await automations.suggestId("Canal de Suporte → Jira"), "canal-de-suporte-jira");
  await automations.save({ spec: { ...spec, id: "triagem" }, triggers: [], note: "", create: true });
  assert.equal(await automations.suggestId("Triagem"), "triagem-2");
});
