import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ApprovalGate } from "../src/approval/gate.js";
import { AgentSpec, type TriggerConfigInput } from "../src/config/types.js";
import { db } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { Executor } from "../src/executor/executor.js";
import type { McpRegistry } from "../src/mcp/registry.js";
import type { Runtime, RuntimeRequest } from "../src/runtimes/types.js";
import { AgentService } from "../src/services/agent-service.js";
import { AutomationService } from "../src/services/automation-service.js";
import { LibraryService } from "../src/services/library-service.js";
import { PacoteService, type AmbienteDoPacote } from "../src/services/pacote-service.js";
import { TriggerService } from "../src/services/trigger-service.js";
import { bancoDeTeste } from "./helpers/db.js";
import { schema } from "../src/db/index.js";
import { eq } from "drizzle-orm";

/** Campo a preencher: gravado na automação pelo import, trava o run e o ligar, e some quando a pessoa preenche. */

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

const HOME = "/Users/ana.souza";
const CHAT = "19:abcdef0123456789abcdef0123456789@thread.v2";
const ambiente: AmbienteDoPacote = {
  conexoes: async () => [],
  servidores: async () => [],
  guardadas: async () => null,
  skills: async () => [],
  provedores: async () => [{ provedor: "claude-code", disponivel: true, modelos: ["claude-sonnet-5"] }],
};
const base = { needs: [] as string[], optional: false };

function maquina() {
  const bd = bancoDeTeste();
  const agents = new AgentService(bd);
  const triggers = new TriggerService(bd);
  const automations = new AutomationService(agents, triggers, {} as never);
  const library = new LibraryService(bd, { servidoresDe: async () => [], ferramentasDe: async () => [] });
  return { agents, triggers, automations, pacotes: new PacoteService(agents, library, automations, ambiente, HOME) };
}

test("pacote com destino fixo omitido: a automação grava a pendência, não liga, e preencher e salvar a limpa", async () => {
  const dono = maquina();
  const spec = AgentSpec.parse({
    id: "aviso-do-time",
    name: "Aviso",
    steps: [
      { ...base, type: "action", key: "avisar", name: "Avisar", action: "teams.post", mode: "approve", params: { destino: { tipo: "fixo", conversa: { app: "teams", ref: `chat/${CHAT}`, rotulo: "Equipe" } } } },
    ],
  });
  await dono.automations.save({ spec, triggers: [{ config: { kind: "poll", source: "github", owner: "empresa-ana", repoMatch: "pagamentos-.*", authorship: "others", filters: { authors: { include: ["ana-souza"] } } } }], note: "", create: true });
  const { texto } = await dono.pacotes.exportar("aviso-do-time");

  const bruno = maquina();
  await bruno.pacotes.importar(texto);
  // O pacote traz o gatilho; a importação grava desligado.
  const gravada = (await bruno.automations.get("aviso-do-time"))!;
  const idDoPoll = gravada.triggers[0]!.id;
  assert.deepEqual(gravada.version.spec.pendentes, [
    { onde: "avisar", campo: "params.destino", motivo: "destino-a-escolher" },
    { onde: `gatilho:${idDoPoll}`, campo: "owner", motivo: "dono-do-github" },
    { onde: `gatilho:${idDoPoll}`, campo: "filters.authors", motivo: "filtros-de-pessoa" },
  ]);
  assert.ok(gravada.triggers.length > 0 && gravada.triggers.every((g) => !g.enabled));

  await assert.rejects(() => bruno.automations.setEnabled("aviso-do-time", true), /gatilho incompleto/);
  await assert.rejects(() => bruno.triggers.setEnabled(gravada.triggers[0]!.id, true), /gatilho incompleto/);

  // Salvar sem preencher não apaga a pendência.
  const mesma = await bruno.automations.save({ spec: gravada.version.spec, triggers: [], knownTriggerIds: [], note: "sem mudar" });
  assert.equal(mesma.version.spec.pendentes?.length, 3);

  const preenchida = { ...gravada.version.spec, steps: gravada.version.spec.steps.map((p) => (p.type === "action" ? { ...p, params: { destino: { tipo: "novo" } } } : p)) };
  // O destino preenchido tira a pendência do passo; a do gatilho espera o dono e os autores.
  const meio = await bruno.automations.save({ spec: preenchida, triggers: gravada.triggers.map((g) => ({ id: g.id, config: g.config })), note: "destino escolhido" });
  assert.deepEqual(meio.version.spec.pendentes?.map((p) => p.onde), [`gatilho:${idDoPoll}`, `gatilho:${idDoPoll}`]);
  await assert.rejects(() => bruno.automations.setEnabled("aviso-do-time", true), /gatilho incompleto/);
  const config = { ...gravada.triggers[0]!.config, owner: "empresa-bruno", filters: { authors: { include: ["bruno"] } } };
  const salva = await bruno.automations.save({ spec: meio.version.spec, triggers: [{ id: gravada.triggers[0]!.id, config }], note: "gatilho escolhido" });
  assert.equal(salva.version.spec.pendentes, undefined);
  const ligados = await bruno.automations.setEnabled("aviso-do-time", true);
  assert.ok(ligados.every((g) => g.enabled));
});

test("o agent que regrava o spec sem a pendência não a apaga", async () => {
  const m = maquina();
  const spec = AgentSpec.parse({
    id: "com-pendencia",
    name: "X",
    steps: [{ ...base, type: "action", key: "a", name: "A", action: "teams.post" }],
    pendentes: [{ onde: "a", campo: "params.destino", motivo: "destino-a-escolher" }],
  });
  await m.agents.upsert(spec, "importada", "human");
  const { pendentes: _p, ...sem } = spec;
  const v = await m.agents.upsert(AgentSpec.parse({ ...sem, name: "Y" }), "agent mexeu", "agent");
  assert.equal(v.spec.pendentes?.length, 1);
});

function runtimeQueRegistra(pedidos: RuntimeRequest[]): Runtime {
  return { id: "native", run: async (req) => (pedidos.push(req), { text: "ok", promptTokens: 1, completionTokens: 0, costUsd: 0, billable: true, toolsUsed: [] }) };
}
const registroFalso = { missing: () => [], toolsFor: async () => ({ tools: {}, release: () => undefined }) } as unknown as McpRegistry;

test("o executor não roda o passo com campo a preencher, e roda depois de preenchido", async () => {
  const id = `pend-${randomUUID().slice(0, 8)}`;
  const agents = new AgentService();
  const incompleto = AgentSpec.parse({
    id,
    name: "Incompleto",
    steps: [{ type: "model", key: "tarefa", name: "Tarefa", model: "ollama/x", prompt: "" }],
    pendentes: [{ onde: "tarefa", campo: "prompt", motivo: "argumentos" }],
  });
  const pedidos: RuntimeRequest[] = [];
  const executor = new Executor({ mcp: registroFalso, runtimes: new Map([["native", runtimeQueRegistra(pedidos)]]), gate: new ApprovalGate(new Map()), machineId: "m", profiles: new LibraryService(db, { servidoresDe: async () => [], ferramentasDe: async () => [] }) });

  const v1 = await agents.upsert(incompleto, "importada", "human");
  const run1 = await executor.createRun(v1.id, null);
  assert.equal(await executor.execute(run1), "failed");
  const [r1] = await db.select().from(schema.runs).where(eq(schema.runs.id, run1));
  assert.match(r1?.error ?? "", /nó "tarefa" incompleto: preencha os argumentos \(prompt\)/);
  assert.equal(pedidos.length, 0);

  const v2 = await agents.upsert(AgentSpec.parse({ ...incompleto, steps: [{ ...incompleto.steps[0], prompt: "Resuma." }] }), "preenchido", "human");
  assert.equal(v2.spec.pendentes, undefined);
  const run2 = await executor.createRun(v2.id, null);
  assert.equal(await executor.execute(run2), "done");
  assert.equal(pedidos.length, 1);
});

test("dois gatilhos do mesmo tipo têm pendências separadas: preencher um não limpa nem libera o outro", async () => {
  const dono = maquina();
  const spec = AgentSpec.parse({ id: "dois-polls", name: "Dois", steps: [{ ...base, type: "model", key: "ler", name: "Ler", prompt: "olhe", model: "claude-code/claude-sonnet-5" }] });
  const poll = (owner: string): TriggerConfigInput => ({ kind: "poll" as const, source: "github" as const, owner, repoMatch: `${owner}-.*`, authorship: "others" as const });
  await dono.automations.save({ spec, triggers: [{ config: poll("empresa-a") }, { config: poll("empresa-b") }], note: "", create: true });
  const { texto } = await dono.pacotes.exportar("dois-polls");

  const outra = maquina();
  await outra.pacotes.importar(texto);
  const gravada = (await outra.automations.get("dois-polls"))!;
  const [a, b] = gravada.triggers;
  assert.deepEqual(gravada.version.spec.pendentes?.map((p) => p.onde), [`gatilho:${a!.id}`, `gatilho:${b!.id}`]);

  // O dono do primeiro preenchido: a pendência do segundo continua, e só o primeiro liga.
  const salva = await outra.automations.save({ spec: gravada.version.spec, triggers: [{ id: a!.id, config: { ...a!.config, owner: "empresa-c" } as TriggerConfigInput }, { id: b!.id, config: b!.config }], note: "a" });
  assert.deepEqual(salva.version.spec.pendentes?.map((p) => p.onde), [`gatilho:${b!.id}`]);
  await outra.triggers.setEnabled(a!.id, true);
  await assert.rejects(() => outra.triggers.setEnabled(b!.id, true), /gatilho incompleto/);

  // Tirar o segundo gatilho leva a pendência dele junto.
  const sem = await outra.automations.save({ spec: salva.version.spec, triggers: [{ id: a!.id, config: { ...a!.config, owner: "empresa-c" } as TriggerConfigInput }], note: "tirei" });
  assert.equal(sem.version.spec.pendentes, undefined);
});

test("a prévia lista por nó e por gatilho o mesmo que a importação grava em pendentes", async () => {
  const dono = maquina();
  const spec = AgentSpec.parse({
    id: "previa-pendencias",
    name: "Prévia",
    steps: [
      { ...base, type: "action", key: "avisar", name: "Avisar", action: "teams.post", mode: "approve", params: { destino: { tipo: "fixo", conversa: { app: "teams", ref: `chat/${CHAT}`, rotulo: "Equipe" } } } },
      { ...base, type: "action", key: "hook", name: "Hook", action: "http.request", mode: "approve", params: { url: "https://api.exemplo.com/x", method: "POST" } },
    ],
  });
  await dono.automations.save({
    spec,
    triggers: [{ config: { kind: "poll", source: "github", owner: "empresa-ana", repoMatch: "a-.*", authorship: "others" } }, { config: { kind: "poll", source: "github", owner: "empresa-ana", repoMatch: "b-.*", authorship: "others" } }, { config: { kind: "slack-channel", channels: ["C0123ABCD45"], everyMinutes: 5 } }],
    note: "",
    create: true,
  });
  const { texto } = await dono.pacotes.exportar("previa-pendencias");

  const outra = maquina();
  const previa = await outra.pacotes.previa(texto);
  const resumo: (string | boolean)[][] = previa.aPreencher.map((p) => [p.no.tipo === "passo" ? p.no.chave : `gatilho:${p.no.posicao}`, p.campo, p.motivo, p.criado]);
  assert.deepEqual(resumo, [
    ["avisar", "params.destino", "destino-a-escolher", true],
    ["gatilho:0", "owner", "dono-do-github", true],
    ["gatilho:1", "owner", "dono-do-github", true],
    ["gatilho:2", "channels", "canais", false],
    ["hook", "params.url", "url-a-preencher", true],
  ]);
  assert.deepEqual(previa.gatilhos.map((g) => g.criado), [true, true, false]);

  await outra.pacotes.importar(texto);
  const gravada = (await outra.automations.get("previa-pendencias"))!;
  const idDe = (posicao: number): string => gravada.triggers[posicao]!.id;
  const gravadas = (gravada.version.spec.pendentes ?? []).filter((p) => !p.onde.startsWith("gatilho:") || p.onde === `gatilho:${idDe(0)}` || p.onde === `gatilho:${idDe(1)}`);
  assert.equal(gravadas.length, resumo.filter((r) => r[3] === true).length);
  assert.equal(gravada.triggers.length, 2);
});
