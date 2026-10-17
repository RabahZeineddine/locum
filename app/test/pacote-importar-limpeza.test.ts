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

/** A importação não limpa de novo o que a exportação já limpou; o escrito à mão segue conferido contra credencial, com aviso por campo. */

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

const HOME = "/Users/ana.souza";
const TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"; // formato de teste, montado por concatenação
const base = { needs: [] as string[], optional: false };
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
  return { agents, library, automations, pacotes: new PacoteService(agents, library, automations, ambiente, HOME) };
}

async function exportado(instrucoes: string): Promise<Record<string, any>> {
  const dono = maquina();
  await dono.library.saveProfile({ spec: { id: "revisor", name: "Revisor", description: "d", context: "", instructions: instrucoes, model: "claude-code/claude-sonnet-5" } as never, create: true });
  const spec = AgentSpec.parse({ id: "limpeza", name: "Limpeza", steps: [{ ...base, type: "model", key: "ler", name: "Ler", prompt: "olhe", model: "claude-code/claude-sonnet-5", profile: "revisor" }] });
  await dono.automations.save({ spec, triggers: [], note: "", create: true });
  return JSON.parse((await dono.pacotes.exportar("limpeza")).texto);
}

test("texto já limpo na exportação entra como veio, sem segunda limpeza nem aviso", async () => {
  const pacote = await exportado(`regra: token: ${TOKEN}\nfale com ana@exemplo.com em ${HOME}/x`);
  const limpo = pacote.agents[0].instructions as string;
  assert.ok(!limpo.includes(TOKEN) && limpo.includes("[segredo removido]"));
  const b = maquina();
  const r = await b.pacotes.importar(JSON.stringify(pacote));
  assert.equal((await b.library.getProfile("revisor"))!.spec.instructions, limpo);
  assert.deepEqual(r.pendencias.filter((p) => p.codigo === "texto-limpo" && p.onde.startsWith("agent:")), []);
});

test("pacote escrito à mão com credencial no texto entra limpo, e o aviso diz o campo", async () => {
  const pacote = await exportado("sem nada");
  pacote.agents[0].instructions = `use ${TOKEN} no cabeçalho`;
  pacote.agents[0].context = "contato: ana@exemplo.com";
  const b = maquina();
  const r = await b.pacotes.importar(JSON.stringify(pacote));
  const gravado = (await b.library.getProfile("revisor"))!.spec;
  assert.ok(!gravado.instructions.includes(TOKEN));
  assert.equal(gravado.instructions, "use [segredo removido] no cabeçalho");
  // E-mail não é credencial: quem escreveu à mão decide, e a exportação é que o limpa.
  assert.equal(gravado.context, "contato: ana@exemplo.com");
  assert.deepEqual(r.pendencias.filter((p) => p.codigo === "texto-limpo"), [{ codigo: "texto-limpo", onde: "agent:revisor", params: ["instructions"] }]);
});
