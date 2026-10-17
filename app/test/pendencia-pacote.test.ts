import { before, test } from "node:test";
import assert from "node:assert/strict";
import { AgentSpec } from "../src/config/types.js";
import { migrateDb } from "../src/db/migrate.js";
import { AgentService } from "../src/services/agent-service.js";
import { AutomationService } from "../src/services/automation-service.js";
import { LibraryService } from "../src/services/library-service.js";
import { PacoteService, type AmbienteDoPacote } from "../src/services/pacote-service.js";
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
