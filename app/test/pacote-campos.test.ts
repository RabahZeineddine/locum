import { before, test } from "node:test";
import assert from "node:assert/strict";
import { AgentProfile, AgentSpec } from "../src/config/types.js";
import { migrateDb } from "../src/db/migrate.js";
import { MARCAS_DO_AGENT, MARCAS_DO_SPEC, ehLocal, type Marca } from "../src/pacote/marcacao.js";
import { AgentService } from "../src/services/agent-service.js";
import { AutomationService } from "../src/services/automation-service.js";
import { LibraryService } from "../src/services/library-service.js";
import { PacoteService, type AmbienteDoPacote } from "../src/services/pacote-service.js";
import { TriggerService } from "../src/services/trigger-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/** O spec e o agent saem e entram pela marcação: campo portável do esquema viaja sem o serviço saber o nome dele. */

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

const ambiente: AmbienteDoPacote = {
  conexoes: async () => [],
  servidores: async () => [],
  guardadas: async () => null,
  skills: async () => [],
  provedores: async () => [{ provedor: "claude-code", disponivel: true, modelos: ["claude-sonnet-5"] }],
};

function maquina() {
  const bd = bancoDeTeste();
  const agents = new AgentService(bd);
  const triggers = new TriggerService(bd);
  const automations = new AutomationService(agents, triggers, {} as never);
  const library = new LibraryService(bd, { servidoresDe: async () => [], ferramentasDe: async () => [] });
  return { agents, automations, library, pacotes: new PacoteService(agents, library, automations, ambiente, "/Users/ana.souza") };
}

const viaja = (m: Marca): boolean => !(m === "dobrado" || m === "seguro" || ehLocal(m));

/** Todo campo do esquema preenchido: o teste falha se um campo novo não entrar aqui, para ninguém esquecer de decidir a marcação dele. */
const SPEC = {
  id: "campos-do-spec",
  name: "Todos os campos",
  defaultTools: [{ server: "jira", tool: "get_issue", class: "read" }],
  skills: [{ skill: "estilo", when: { always: true } }],
  steps: [{ type: "model", key: "ler", name: "Ler", model: "claude-code/claude-sonnet-5", prompt: "oi", profile: "campos-do-agent" }],
  budget: { perRunUsd: 1.5, perDayUsd: 5, perRunTokens: 1000, perDayTokens: 5000 },
  layout: { ler: { x: 10, y: 20 } },
};
const AGENT = {
  id: "campos-do-agent",
  name: "Agent completo",
  description: "Uma frase",
  context: "O time",
  instructions: "Revise com calma",
  model: "claude-code/claude-sonnet-5",
  temperature: 0.4,
  toolsets: [],
  tools: [{ server: "jira", tool: "get_issue", class: "read" }],
  connections: [],
  skills: [{ skill: "estilo", when: { always: true } }],
  budget: { perRunUsd: 2, perRunTokens: 2000 },
  maxSteps: 7,
};

test("a fixture preenche todo campo do spec e do agent (menos as pendências, que não são do que se exporta)", () => {
  for (const campo of Object.keys(AgentSpec.shape)) if (campo !== "pendentes" && campo !== "rebaixados") assert.ok(campo in SPEC, `spec.${campo} sem valor na fixture`);
  for (const campo of Object.keys(AgentProfile.shape)) assert.ok(campo in AGENT, `agent.${campo} sem valor na fixture`);
});

test("todo campo portável do spec e do agent viaja no pacote e volta igual, sem o serviço conhecer o campo", async () => {
  const origem = maquina();
  await origem.library.saveProfile({ spec: AgentProfile.parse(AGENT), note: "", create: true });
  const spec = AgentSpec.parse(SPEC);
  await origem.automations.save({ spec, triggers: [], note: "", create: true });
  const { pacote, texto } = await origem.pacotes.exportar(spec.id);

  const destino = maquina();
  await destino.pacotes.importar(texto);
  const importado = (await destino.automations.get(spec.id))!.version.spec as unknown as Record<string, unknown>;
  const doPacote = { id: pacote.automacao.id, ...pacote.automacao.spec } as unknown as Record<string, unknown>;
  const original = spec as unknown as Record<string, unknown>;
  for (const [campo, marca] of Object.entries(MARCAS_DO_SPEC)) {
    if (!viaja(marca) || campo === "steps") continue;
    assert.deepEqual(doPacote[campo], original[campo], `spec.${campo} não viajou`);
    assert.deepEqual(importado[campo], original[campo], `spec.${campo} não voltou`);
  }

  const agentDoPacote = pacote.agents[0] as unknown as Record<string, unknown>;
  const agentImportado = (await destino.library.getProfile("campos-do-agent"))!.spec as unknown as Record<string, unknown>;
  const agentOriginal = AgentProfile.parse(AGENT) as unknown as Record<string, unknown>;
  for (const [campo, marca] of Object.entries(MARCAS_DO_AGENT)) {
    if (!viaja(marca)) continue;
    assert.deepEqual(agentDoPacote[campo], agentOriginal[campo], `agent.${campo} não viajou`);
    assert.deepEqual(agentImportado[campo], agentOriginal[campo], `agent.${campo} não voltou`);
  }
});
