import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AgentSpec } from "../src/config/types.js";
import { migrateDb } from "../src/db/migrate.js";
import { AgentService } from "../src/services/agent-service.js";
import { AutomationService } from "../src/services/automation-service.js";
import { LibraryService } from "../src/services/library-service.js";
import { PacoteService, type AmbienteDoPacote } from "../src/services/pacote-service.js";
import { skillsService } from "../src/services/skills-service.js";
import { TriggerService } from "../src/services/trigger-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/** Pendência que atravessa pacote: o formato antigo sem nome de param, e a reexportação que não a perde. */

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

test("pacote v1 com omitido de argumentos sem nome de param: o passo fica incompleto até a pessoa dispensar", async () => {
  // O formato antigo: o passo chega sem o que foi omitido, e o omitido só diz quantos.
  const v1 = {
    formato: "locum-pacote",
    versao: 1,
    automacao: {
      id: "aviso-antigo",
      spec: { name: "Aviso antigo", steps: [{ ...base, type: "action", key: "avisar", name: "Avisar", action: "teams.post", mode: "approve" }] },
      gatilhos: [],
    },
    agents: [],
    requisitos: { conexoes: [], servidores: [], provedores: [] },
    omitidos: [{ codigo: "argumentos", onde: "avisar", quantos: 2 }],
  };
  const bruno = maquina();
  await bruno.pacotes.importar(JSON.stringify(v1));
  const gravada = (await bruno.automations.get("aviso-antigo"))!;
  assert.deepEqual(gravada.version.spec.pendentes, [{ onde: "avisar", campo: "params", motivo: "passo-a-revisar" }]);

  // Salvar o passo com params preenchidos não resolve: só dispensar.
  const comParams = { ...gravada.version.spec, steps: gravada.version.spec.steps.map((p) => (p.type === "action" ? { ...p, params: { destino: { tipo: "evento" } } } : p)) };
  const salva = await bruno.automations.save({ spec: AgentSpec.parse(comParams), triggers: [], note: "revisei" });
  assert.equal(salva.version.spec.pendentes?.length, 1);
});

test("A exporta, B importa sem preencher e reexporta: C recebe a mesma pendência", async () => {
  const a = maquina();
  const spec = AgentSpec.parse({
    id: "aviso-do-time",
    name: "Aviso",
    steps: [{ ...base, type: "action", key: "avisar", name: "Avisar", action: "teams.post", mode: "approve", params: { destino: { tipo: "fixo", conversa: { app: "teams", ref: `chat/${CHAT}`, rotulo: "Equipe" } } } }],
  });
  await a.automations.save({ spec, triggers: [{ config: { kind: "poll", source: "github", owner: "empresa-ana", repoMatch: "pagamentos-.*", authorship: "others" } }], note: "", create: true });
  const doA = (await a.pacotes.exportar("aviso-do-time")).texto;

  const b = maquina();
  await b.pacotes.importar(doA);
  const emB = (await b.automations.get("aviso-do-time"))!;
  const doB = (await b.pacotes.exportar("aviso-do-time")).texto;

  const c = maquina();
  await c.pacotes.importar(doB);
  const emC = (await c.automations.get("aviso-do-time"))!;
  const resumo = (x: typeof emB): string[] => (x.version.spec.pendentes ?? []).map((p) => `${p.onde.startsWith("gatilho:") ? "gatilho" : p.onde}|${p.campo}|${p.motivo}`).sort();
  assert.deepEqual(resumo(emC), resumo(emB));
  assert.ok(resumo(emC).includes("avisar|params.destino|destino-a-escolher"));
  assert.ok(resumo(emC).includes("gatilho|owner|dono-do-github"));
});

test("skill-ausente some quando a skill passa a existir aqui, por salvar ou por upsert do agent, que não a ressuscita", async () => {
  const nome = `estilo-${randomUUID().slice(0, 6)}`;
  const v1 = {
    formato: "locum-pacote",
    versao: 1,
    automacao: {
      id: "com-skill",
      spec: { name: "Com skill", skills: [{ skill: nome, when: { always: true } }], steps: [{ ...base, type: "model", key: "ler", name: "Ler", model: "claude-code/claude-sonnet-5", prompt: "oi" }] },
      gatilhos: [],
    },
    agents: [],
    requisitos: { conexoes: [], servidores: [], provedores: [], skills: [{ nome }] },
    omitidos: [],
  };
  const m = maquina();
  await m.pacotes.importar(JSON.stringify(v1));
  await m.pacotes.importar(JSON.stringify(v1), { automacaoId: "com-skill-2" });
  const aberta = (await m.automations.get("com-skill"))!;
  assert.equal(aberta.version.spec.pendentes?.length, 1);
  // Enquanto a skill não existe, salvar não resolve.
  assert.equal((await m.automations.save({ spec: aberta.version.spec, triggers: [], note: "ainda sem a skill" })).version.spec.pendentes?.length, 1);

  await skillsService.criar({ name: nome, description: "Estilo", body: "corpo" });
  // O agent regrava sem a pendência: a que a skill resolveu não volta.
  const outra = (await m.automations.get("com-skill-2"))!.version.spec;
  const { pendentes: _p, ...sem } = outra;
  assert.equal((await m.agents.upsert(AgentSpec.parse({ ...sem, name: "Outra" }), "agent", "agent")).spec.pendentes, undefined);
  // A pessoa salva e a pendência some, sem ninguém dispensar.
  assert.equal((await m.automations.save({ spec: aberta.version.spec, triggers: [], note: "skill instalada" })).version.spec.pendentes, undefined);
});

test("set_trigger que preenche o campo limpa a pendência do gatilho, e só a dele", async () => {
  const a = maquina();
  const spec = AgentSpec.parse({ id: "gatilho-pelo-mcp", name: "X", steps: [{ ...base, type: "model", key: "ler", name: "Ler", model: "claude-code/claude-sonnet-5", prompt: "oi" }] });
  await a.automations.save({ spec, triggers: [{ config: { kind: "poll", source: "github", owner: "empresa-ana", repoMatch: "x-.*", authorship: "others", filters: { authors: { include: ["ana"] } } } }], note: "", create: true });
  const b = maquina();
  await b.pacotes.importar((await a.pacotes.exportar("gatilho-pelo-mcp")).texto);
  const gravada = (await b.automations.get("gatilho-pelo-mcp"))!;
  const gatilho = gravada.triggers[0]!;
  assert.deepEqual(gravada.version.spec.pendentes?.map((p) => p.campo), ["owner", "filters.authors"]);

  // Pelo MCP, sem passar pela gravação da automação: o dono preenchido tira a pendência dele.
  await b.triggers.set("gatilho-pelo-mcp", { ...gatilho.config, owner: "empresa-bruno" } as never, { id: gatilho.id, fromTool: true });
  const depois = (await b.automations.get("gatilho-pelo-mcp"))!;
  assert.deepEqual(depois.version.spec.pendentes?.map((p) => p.campo), ["filters.authors"]);
});

test("gravar mantém a pendência que não foi preenchida nem dispensada, e dispensar é por nome", async () => {
  const m = maquina();
  const pendentes = [
    { onde: "ler", campo: "prompt", motivo: "argumentos" },
    { onde: "ler", campo: "model", motivo: "argumentos" },
  ];
  const spec = AgentSpec.parse({ id: "mantem", name: "X", steps: [{ ...base, type: "model", key: "ler", name: "Ler", model: "", prompt: "", maxSteps: 3 }], pendentes });
  const criada = await m.automations.save({ spec, triggers: [], note: "importada", create: true });
  const { pendentes: _p, ...sem } = criada.version.spec;

  // O spec remontado sem pendentes não apaga nada em silêncio.
  const mesma = await m.automations.save({ spec: AgentSpec.parse({ ...sem, name: "Y" }), triggers: [], note: "remontado" });
  assert.deepEqual(mesma.version.spec.pendentes?.map((p) => p.campo), ["prompt", "model"]);

  // Dispensar nomeia a pendência, e só essa sai.
  const dispensada = await m.automations.save({ spec: AgentSpec.parse({ ...sem, name: "Y" }), triggers: [], note: "dispensei", dispensadas: [{ onde: "ler", campo: "prompt" }] });
  assert.deepEqual(dispensada.version.spec.pendentes?.map((p) => p.campo), ["model"]);
  await assert.rejects(() => m.automations.save({ spec: AgentSpec.parse({ ...sem, name: "Y" }), triggers: [], note: "x", dispensadas: [{ onde: "ler", campo: "nao-existe" }] }), /não há pendência/);
});

async function comGatilhoPendente(id: string) {
  const a = maquina();
  const spec = AgentSpec.parse({ id, name: "X", steps: [{ ...base, type: "model", key: "ler", name: "Ler", model: "claude-code/claude-sonnet-5", prompt: "oi" }] });
  await a.automations.save({ spec, triggers: [{ config: { kind: "poll", source: "github", owner: "empresa-ana", repoMatch: "x-.*", authorship: "others" } }], note: "", create: true });
  const b = maquina();
  await b.pacotes.importar((await a.pacotes.exportar(id)).texto);
  return { b, gravada: (await b.automations.get(id))! };
}

test("duplicar leva só a pendência de passo: a de gatilho não tem a quem apontar na cópia", async () => {
  const { b, gravada } = await comGatilhoPendente("origem-dup");
  const comPasso = { ...gravada.version.spec, pendentes: [...gravada.version.spec.pendentes!, { onde: "ler", campo: "params.destino", motivo: "destino-a-escolher" }] };
  await b.automations.save({ spec: comPasso, triggers: [{ id: gravada.triggers[0]!.id, config: gravada.triggers[0]!.config }], note: "com passo" });
  const copia = await b.agents.duplicate("origem-dup", "copia-dup", "Cópia");
  assert.deepEqual(copia.spec.pendentes, [{ onde: "ler", campo: "params.destino", motivo: "destino-a-escolher" }]);
});

test("restaurar uma versão antiga: a pendência do gatilho volta só se o gatilho existe e segue vazio", async () => {
  const { b, gravada } = await comGatilhoPendente("origem-rest");
  const idDoGatilho = gravada.triggers[0]!.id;
  const antiga = gravada.version.version;
  // Gatilho preenchido: a pendência saiu, e restaurar a versão antiga não a traz de volta.
  await b.triggers.set("origem-rest", { ...gravada.triggers[0]!.config, owner: "empresa-bruno" } as never, { id: idDoGatilho });
  assert.equal((await b.agents.restoreVersion("origem-rest", antiga)).spec.pendentes, undefined);

  // Gatilho que saiu: nada fica à espera dele.
  await b.automations.save({ spec: (await b.automations.get("origem-rest"))!.version.spec, triggers: [], note: "sem gatilho" });
  assert.equal((await b.agents.restoreVersion("origem-rest", antiga)).spec.pendentes, undefined);
});
