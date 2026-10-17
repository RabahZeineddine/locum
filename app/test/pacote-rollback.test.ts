import { before, test } from "node:test";
import assert from "node:assert/strict";
import { AgentSpec } from "../src/config/types.js";
import { migrateDb } from "../src/db/migrate.js";
import { transacaoDoBanco } from "../src/db/transacao.js";
import { AgentService } from "../src/services/agent-service.js";
import { AutomationService } from "../src/services/automation-service.js";
import { LibraryService } from "../src/services/library-service.js";
import { PacoteService, type AmbienteDoPacote } from "../src/services/pacote-service.js";
import { TriggerService } from "../src/services/trigger-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/** Importar é tudo ou nada: falha em qualquer etapa não deixa skill, agent, versão nem gatilho, e reimportar funciona. */

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

const HOME = "/Users/ana.souza";
const base = { needs: [] as string[], optional: false };
const MODELO = "claude-code/claude-sonnet-5";
type Etapa = "skill" | "agent-novo" | "agent-atualizado" | "automacao" | "gatilho";
type Skills = Map<string, { descricao: string; corpo: string }>;

const perfil = (id: string, instrucoes: string) => ({ id, name: id, description: "d", context: "", instructions: instrucoes, model: MODELO });

function maquina(skills: Skills, falha: { etapa: Etapa | null } = { etapa: null }) {
  const bd = bancoDeTeste();
  const agents = new AgentService(bd);
  const triggers = new TriggerService(bd);
  const automations = new AutomationService(agents, triggers, {} as never);
  const library = new LibraryService(bd, { servidoresDe: async () => [], ferramentasDe: async () => [] });
  const quebrar = (etapa: Etapa): void => {
    if (falha.etapa === etapa) throw new Error(`queda em ${etapa}`);
  };
  const salvarPerfil = library.saveProfile.bind(library);
  library.saveProfile = async (input) => {
    quebrar(input.spec.id === "revisor-antigo" ? "agent-atualizado" : "agent-novo");
    return salvarPerfil(input);
  };
  const ligar = triggers.set.bind(triggers);
  triggers.set = async (...args) => {
    quebrar("gatilho");
    return ligar(...args);
  };
  const salvarAutomacao = automations.save.bind(automations);
  automations.save = async (input) => {
    quebrar("automacao");
    return salvarAutomacao(input);
  };
  const ambiente: AmbienteDoPacote = {
    conexoes: async () => [],
    servidores: async () => [],
    guardadas: async () => null,
    skills: async () => [...skills.keys()],
    conteudoDaSkill: async (nome) => skills.get(nome) ?? null,
    criarSkill: async ({ nome, descricao, corpo }) => {
      quebrar("skill");
      skills.set(nome, { descricao, corpo });
    },
    removerSkill: async (nome) => void skills.delete(nome),
    provedores: async () => [{ provedor: "claude-code", disponivel: true, modelos: ["claude-sonnet-5"] }],
  };
  return { bd, agents, triggers, automations, library, pacotes: new PacoteService(agents, library, automations, ambiente, HOME, transacaoDoBanco(bd)) };
}

async function pacoteCompleto(): Promise<string> {
  const dono = maquina(new Map([["estilo", { descricao: "Estilo", corpo: "Prefira funções pequenas." }]]));
  await dono.library.saveProfile({ spec: perfil("revisor-novo", "novo") as never, create: true });
  await dono.library.saveProfile({ spec: perfil("revisor-antigo", "texto do pacote") as never, create: true });
  const spec = AgentSpec.parse({
    id: "tudo-ou-nada",
    name: "Tudo ou nada",
    skills: [{ skill: "estilo", when: { always: true } }],
    steps: [
      { ...base, type: "model", key: "a", name: "A", prompt: "olhe", model: MODELO, profile: "revisor-novo" },
      { ...base, type: "model", key: "b", name: "B", prompt: "olhe", model: MODELO, profile: "revisor-antigo" },
    ],
  });
  await dono.automations.save({ spec, triggers: [{ config: { kind: "poll", source: "github", owner: "empresa-ana", repoMatch: "x-.*", authorship: "others" } }], note: "", create: true });
  return (await dono.pacotes.exportar("tudo-ou-nada")).texto;
}

for (const etapa of ["skill", "agent-novo", "agent-atualizado", "automacao", "gatilho"] as const) {
  test(`falha em "${etapa}": nada fica gravado e reimportar funciona`, async () => {
    const texto = await pacoteCompleto();
    const skills: Skills = new Map();
    const falha: { etapa: Etapa | null } = { etapa: null };
    const m = maquina(skills, falha);
    // O agent de mesmo id que já existe aqui, com outro texto: o pacote o atualiza por escolha explícita.
    await m.library.saveProfile({ spec: perfil("revisor-antigo", "texto daqui") as never, create: true });
    falha.etapa = etapa;
    const escolhas = { agents: { "revisor-antigo": { acao: "atualizar" as const } } };

    await assert.rejects(() => m.pacotes.importar(texto, escolhas), new RegExp(`queda em ${etapa}`));
    assert.equal(skills.size, 0, "a skill nova ficou");
    assert.equal(await m.library.getProfile("revisor-novo"), null, "o agent novo ficou");
    assert.equal((await m.library.getProfile("revisor-antigo"))!.version, 1, "o agent atualizado ganhou versão");
    assert.equal(await m.agents.get("tudo-ou-nada"), undefined, "a automação ficou");
    assert.deepEqual(await m.triggers.list("tudo-ou-nada"), [], "o gatilho ficou");
    assert.equal(m.bd.$client.inTransaction, false, "a transação ficou aberta");

    falha.etapa = null;
    const r = await m.pacotes.importar(texto, escolhas);
    assert.equal(r.automacaoId, "tudo-ou-nada");
    assert.equal((await m.library.getProfile("revisor-antigo"))!.version, 2);
    assert.equal((await m.triggers.list("tudo-ou-nada")).length, 1);
    assert.ok(skills.has("estilo"));
  });
}
