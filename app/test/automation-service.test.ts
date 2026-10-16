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
  assert.equal(await automations.suggestId("Legacy"), "legacy-2");
});

test("zerar chatsPendentes sem valerParaTodosOsChats recusa antes de gravar o spec", async () => {
  const { automations } = montar();
  const teams = { kind: "teams-inbox", chats: [], chatsPendentes: 2, prLinks: true } as never;
  const criada = await automations.save({ spec, triggers: [{ config: teams }], note: "", create: true });
  const gatilho = criada.triggers[0]!;

  await assert.rejects(
    automations.save({
      spec: { ...spec, name: "Outro nome" },
      triggers: [{ id: gatilho.id, config: { ...(gatilho.config as object), chatsPendentes: 0 } as never }],
      note: "troca",
    }),
    /todos os chats|escolha os chats/,
  );
  const atual = await automations.get(spec.id);
  assert.equal(atual?.version.version, 1);
  assert.equal((atual?.triggers[0]?.config as { chatsPendentes: number }).chatsPendentes, 2);
});

test("salvar com a versão esperada recusa quando a gravada é outra, e sem ela segue como antes", async () => {
  const { automations } = montar();
  await automations.save({ spec, triggers: [], note: "", create: true });
  // Outro chamador (o MCP, por exemplo) grava a v2 sem versão esperada.
  await automations.save({ spec: { ...spec, name: "Pelo MCP" }, triggers: [], note: "mcp" });

  await assert.rejects(
    automations.save({ spec: { ...spec, name: "Da tela" }, triggers: [], note: "tela", expectedVersion: 1 }),
    /mudou.*v1.*v2/,
  );
  const atual = await automations.get(spec.id);
  assert.equal(atual?.version.version, 2);
  assert.equal(atual?.version.spec.name, "Pelo MCP");

  const ok = await automations.save({ spec: { ...spec, name: "Da tela" }, triggers: [], note: "tela", expectedVersion: 2 });
  assert.equal(ok.version.version, 3);
});

test("a versão esperada é conferida antes de qualquer escrita, inclusive dos gatilhos", async () => {
  const { automations } = montar();
  await automations.save({ spec, triggers: [], note: "", create: true });
  await automations.save({ spec: { ...spec, name: "v2" }, triggers: [], note: "v2" });
  await assert.rejects(
    automations.save({ spec, triggers: [{ config: { kind: "slack-channel", channels: ["C1"] } }], note: "x", expectedVersion: 1 }),
    /mudou/,
  );
  assert.equal((await automations.get(spec.id))?.triggers.length, 0);
});

test("a leitura da automação traz quando o agent nasceu, para o rascunho reconhecer id reaproveitado", async () => {
  const { automations } = montar();
  await automations.save({ spec, triggers: [], note: "", create: true });
  const lida = await automations.get(spec.id);
  assert.equal(typeof lida?.createdAt, "number");
});

test("duas gravações da mesma base em paralelo: uma passa, e a outra recebe o aviso de que a automação mudou", async () => {
  const { automations } = montar();
  await automations.save({ spec, triggers: [], note: "", create: true });
  const resultados = await Promise.allSettled([
    automations.save({ spec: { ...spec, name: "Da tela A" }, triggers: [], note: "a", expectedVersion: 1 }),
    automations.save({ spec: { ...spec, name: "Da tela B" }, triggers: [], note: "b", expectedVersion: 1 }),
  ]);
  assert.deepEqual(resultados.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  const recusada = resultados.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.match(String(recusada.reason), /mudou desde a v1/);
  assert.equal((await automations.get(spec.id))?.version.version, 2);
});

test("salvar sem dizer enabled mantém o ligado que entrou depois da base, pelo MCP ou pela lista", async () => {
  const { automations } = montar();
  const criada = await automations.save({ spec, triggers: [{ config: { kind: "manual" } }], note: "", create: true });
  await automations.setEnabled(spec.id, true); // não cria versão
  const salva = await automations.save({
    spec: { ...spec, name: "Outro nome" },
    triggers: [{ id: criada.triggers[0]!.id, config: { kind: "manual" } }],
    note: "troca o nome",
    expectedVersion: 1,
  });
  assert.equal(salva.triggers[0]?.enabled, true);
});

test("com knownTriggerIds, o gatilho criado por fora depois que o editor abriu fica, e o que a pessoa tirou sai", async () => {
  const { automations, triggers } = montar();
  const criada = await automations.save({
    spec,
    triggers: [{ config: { kind: "manual" } }, { config: { kind: "cron", expression: "0 9 * * 1-5" } }],
    note: "",
    create: true,
  });
  const manual = criada.triggers.find((g) => g.config.kind === "manual")!;
  const cron = criada.triggers.find((g) => g.config.kind === "cron")!;
  // Pelo MCP, sem versão nova, com o editor aberto.
  const deFora = await triggers.set(spec.id, { kind: "cron", expression: "0 18 * * 1-5" });

  const salva = await automations.save({
    spec: { ...spec, name: "Outro nome" },
    triggers: [{ id: manual.id, config: { kind: "manual" } }],
    note: "tira o cron",
    expectedVersion: 1,
    knownTriggerIds: [manual.id, cron.id],
  });
  assert.deepEqual(salva.triggers.map((g) => g.id).sort(), [manual.id, deFora.id].sort());
});
