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

/** Skills no pacote: o conteúdo viaja limpo, a importação cria a que falta, e o pacote antigo deixa a ausência à vista. */

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

const HOME = "/Users/ana.souza";
const TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"; // formato de teste, montado por concatenação
const base = { needs: [] as string[], optional: false };

type Skills = Map<string, { descricao: string; corpo: string }>;

function maquina(skills: Skills) {
  const bd = bancoDeTeste();
  const agents = new AgentService(bd);
  const triggers = new TriggerService(bd);
  const automations = new AutomationService(agents, triggers, {} as never);
  const library = new LibraryService(bd, { servidoresDe: async () => [], ferramentasDe: async () => [] });
  const ambiente: AmbienteDoPacote = {
    conexoes: async () => [],
    servidores: async () => [],
    guardadas: async () => null,
    skills: async () => [...skills.keys()],
    conteudoDaSkill: async (nome) => skills.get(nome) ?? null,
    criarSkill: async ({ nome, descricao, corpo }) => void skills.set(nome, { descricao, corpo }),
    provedores: async () => [{ provedor: "claude-code", disponivel: true, modelos: ["claude-sonnet-5"] }],
  };
  return { agents, triggers, automations, pacotes: new PacoteService(agents, library, automations, ambiente, HOME) };
}

async function origem(skills: Skills) {
  const dono = maquina(skills);
  const spec = AgentSpec.parse({
    id: "com-skill",
    name: "Com skill",
    skills: [{ skill: "estilo-de-codigo", when: { always: true } }],
    steps: [{ ...base, type: "model", key: "ler", name: "Ler", prompt: "olhe", model: "claude-code/claude-sonnet-5" }],
  });
  await dono.automations.save({ spec, triggers: [], note: "", create: true });
  return dono.pacotes.exportar("com-skill");
}

test("o pacote leva o conteúdo da skill citada, limpo de credencial, e-mail e caminho de home", async () => {
  const { texto, pacote } = await origem(new Map([["estilo-de-codigo", { descricao: "Estilo", corpo: `Use ${TOKEN}\nfale com ana@empresa.com em ${HOME}/projetos` }]]));
  assert.equal(pacote.skills.length, 1);
  assert.ok(!texto.includes(TOKEN) && !texto.includes("ana@empresa.com") && !texto.includes(HOME));
});

test("importar cria a skill que não existe, e a que já é igual ou diferente fica como está", async () => {
  const conteudo = { descricao: "Estilo", corpo: "Prefira funções pequenas." };
  const { texto } = await origem(new Map([["estilo-de-codigo", conteudo]]));

  const limpa: Skills = new Map();
  const nova = maquina(limpa);
  const previa = await nova.pacotes.previa(texto);
  assert.deepEqual(previa.skills, [{ nome: "estilo-de-codigo", situacao: "nova" }]);
  assert.equal(previa.dependencias.find((d) => d.tipo === "skill")?.estado, "ok");
  await nova.pacotes.importar(texto);
  assert.deepEqual(limpa.get("estilo-de-codigo"), conteudo);
  assert.equal((await nova.automations.get("com-skill"))!.version.spec.pendentes, undefined);

  assert.deepEqual((await maquina(new Map([["estilo-de-codigo", conteudo]])).pacotes.previa(texto)).skills, [{ nome: "estilo-de-codigo", situacao: "igual" }]);

  const diferente: Skills = new Map([["estilo-de-codigo", { descricao: "Outro", corpo: "Texto daqui." }]]);
  const conflito = maquina(diferente);
  const p = await conflito.pacotes.previa(texto);
  assert.equal(p.skills[0]!.situacao, "conflito");
  assert.equal(p.skills[0]!.diferenca?.daqui, "Texto daqui.");
  await conflito.pacotes.importar(texto);
  assert.equal(diferente.get("estilo-de-codigo")!.corpo, "Texto daqui.");
});

test("pacote antigo, sem o conteúdo: a skill que falta vira pendência persistente no passo que a usa", async () => {
  const { pacote } = await origem(new Map([["estilo-de-codigo", { descricao: "Estilo", corpo: "x" }]]));
  const antigo = { ...pacote, versao: 1 } as Record<string, unknown>;
  delete antigo.skills;

  const vazia = maquina(new Map());
  const texto = JSON.stringify(antigo);
  const previa = await vazia.pacotes.previa(texto);
  assert.deepEqual(previa.skills, [{ nome: "estilo-de-codigo", situacao: "ausente" }]);
  await vazia.pacotes.importar(texto);
  const gravada = (await vazia.automations.get("com-skill"))!;
  assert.deepEqual(gravada.version.spec.pendentes, [{ onde: "ler", campo: "skills.estilo-de-codigo", motivo: "skill-ausente" }]);

  // Com a skill aqui, o pacote antigo entra sem pendência.
  const comSkill = maquina(new Map([["estilo-de-codigo", { descricao: "d", corpo: "c" }]]));
  await comSkill.pacotes.importar(texto);
  assert.equal((await comSkill.automations.get("com-skill"))!.version.spec.pendentes, undefined);
});
