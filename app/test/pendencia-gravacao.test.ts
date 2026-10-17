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

/** A regra "gravar mantém o que não foi resolvido" vale no AgentService, para todo caminho. */

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

const HOME = "/Users/ana.souza";
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

test("gravar mantém pendência e rebaixado em todo caminho de gravação do agent, não só pela automação", async () => {
  const m = maquina();
  const spec = AgentSpec.parse({
    id: "todo-caminho",
    name: "X",
    steps: [
      { ...base, type: "model", key: "ler", name: "Ler", model: "", prompt: "", maxSteps: 3 },
      { ...base, type: "action", key: "avisar", name: "Avisar", action: "teams.post", mode: "approve" },
    ],
    pendentes: [{ onde: "ler", campo: "prompt", motivo: "argumentos" }],
    rebaixados: [{ passo: "avisar", motivo: "rebaixado-na-importacao" }],
  });
  const criada = await m.automations.save({ spec, triggers: [], note: "importada", create: true });
  const { pendentes: _p, rebaixados: _r, ...sem } = criada.version.spec;
  const resumo = (s: AgentSpec) => ({ pendentes: s.pendentes?.map((p) => p.campo), rebaixados: s.rebaixados?.map((r) => r.passo) });
  const esperado = { pendentes: ["prompt"], rebaixados: ["avisar"] };

  const porUpsertHumano = await m.agents.upsert(AgentSpec.parse({ ...sem, name: "Y" }), "pela pessoa", "human");
  assert.deepEqual(resumo(porUpsertHumano.spec), esperado);

  const porSaveEdited = await m.agents.saveEdited("todo-caminho", AgentSpec.parse({ ...sem, name: "Z" }), "editado");
  assert.deepEqual(resumo(porSaveEdited.spec), esperado);

  const porImportSpec = await m.agents.importSpec(JSON.stringify({ ...sem, name: "W" }), "arquivo");
  assert.equal(porImportSpec.created, false);
  assert.deepEqual(resumo(porImportSpec.version.spec), esperado);

  const antiga = (await m.agents.listVersions("todo-caminho")).find((v) => v.spec.name === "X")!;
  await m.agents.upsert(AgentSpec.parse({ ...sem, name: "V" }), "limpo de novo", "human");
  const restaurada = await m.agents.restoreVersion("todo-caminho", antiga.version);
  assert.deepEqual(resumo(restaurada.spec), esperado);

  const copia = await m.agents.duplicate("todo-caminho", "todo-caminho-copia", "Cópia");
  assert.deepEqual(resumo(copia.spec), esperado);
});
