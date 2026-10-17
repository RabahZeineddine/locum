import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { buildGate } from "../../src/executor/build.js";
import { AgentProfile, AgentSpec, TriggerConfig, type AgentProfileInput, type ToolsetInput, type TriggerConfigInput } from "../../src/config/types.js";
import { ehLocal, MARCAS_DO_AGENT, MARCAS_DO_PASSO_DE_ACAO, MARCAS_DOS_GATILHOS, temFilhos, type MapaDeMarcas } from "../../src/pacote/marcacao.js";
import { aplicarMarcas, paramsParaPacote, type ParamsDoPacote } from "../../src/pacote/params.js";
import { AgentService } from "../../src/services/agent-service.js";
import { AutomationService } from "../../src/services/automation-service.js";
import { LibraryService } from "../../src/services/library-service.js";
import { PacoteService, type AmbienteDoPacote } from "../../src/services/pacote-service.js";
import { TriggerService } from "../../src/services/trigger-service.js";
import { bancoDeTeste } from "./db.js";

/**
 * Ida e volta do pacote: exporta numa máquina, importa noutra, limpa, e compara o
 * que voltou com o que foi. A única diferença aceita é o que a marcação e a
 * declaração das ações dizem que é local, e cada campo local tem de ficar a
 * preencher em `pendentes`. O resto que difere falha, com o caminho.
 */

export const HOME = "/Users/ana.souza";

export interface Fluxo {
  spec: unknown;
  gatilhos?: TriggerConfigInput[];
  agents?: AgentProfileInput[];
  toolsets?: ToolsetInput[];
  /** Skills da máquina de origem, pelo nome. */
  skills?: Record<string, { descricao: string; corpo: string }>;
}

type Skills = Map<string, { descricao: string; corpo: string }>;

/** Os kinds de gatilho que o esquema e a marcação conhecem. */
export const kindsDeGatilho = (): string[] => Object.keys(MARCAS_DOS_GATILHOS);

/** As ações registradas no gate, com o que cada uma declara para o pacote. */
export const acoesRegistradas = (): { kind: string; declaracao: ParamsDoPacote }[] =>
  buildGate()
    .describe()
    .map((a) => ({ kind: a.kind, declaracao: a.paramsDoPacote ?? {} }));

function maquina(skills: Skills) {
  const db = bancoDeTeste();
  const agents = new AgentService(db);
  const triggers = new TriggerService(db);
  const automations = new AutomationService(agents, triggers, {} as never);
  const library = new LibraryService(db, { servidoresDe: async () => [], ferramentasDe: async () => [] });
  const ambiente: AmbienteDoPacote = {
    conexoes: async () => [],
    servidores: async () => [],
    // As ferramentas de leitura do servidor de exemplo: sem isto a importação as trataria como escrita.
    guardadas: async (servidor) => (servidor === "ms365" ? ["listar", "ler", "buscar"].map((name) => ({ name, readOnlyHint: true })) : null),
    skills: async () => [...skills.keys()],
    conteudoDaSkill: async (nome) => skills.get(nome) ?? null,
    criarSkill: async ({ nome, descricao, corpo }) => void skills.set(nome, { descricao, corpo }),
    provedores: async () => [{ provedor: "claude-code", disponivel: true, modelos: ["claude-sonnet-5"] }],
  };
  return { agents, triggers, automations, library, skills, pacotes: new PacoteService(agents, library, automations, ambiente, HOME) };
}

/* --------------------------------------------------------------- diferença */

interface Diferenca {
  caminho: string;
  original: unknown;
  importado: unknown;
}

const ehObjeto = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function diferencas(original: unknown, importado: unknown, caminho: string, saida: Diferenca[] = []): Diferenca[] {
  if (ehObjeto(original) && ehObjeto(importado)) {
    for (const chave of new Set([...Object.keys(original), ...Object.keys(importado)])) {
      diferencas(original[chave], importado[chave], caminho === "" ? chave : `${caminho}.${chave}`, saida);
    }
  } else if (!isDeepStrictEqual(original, importado)) {
    saida.push({ caminho, original, importado });
  }
  return saida;
}

const mostrar = (v: unknown): string => (v === undefined ? "ausente" : JSON.stringify(v));

/** Falha com o caminho do que difere fora do declarado, e do que está declarado local e mesmo assim viajou. */
function conferir(que: string, diffs: Diferenca[], locais: ReadonlySet<string>): void {
  for (const d of diffs) {
    assert.ok(locais.has(d.caminho), `${que}: diferença fora do declarado local em ${d.caminho} (original ${mostrar(d.original)}, importado ${mostrar(d.importado)})`);
  }
  const diferentes = new Set(diffs.map((d) => d.caminho));
  for (const l of locais) assert.ok(diferentes.has(l), `${que}: ${l} está declarado local e viajou no pacote`);
}

/** Os caminhos de uma marcação que são locais, sem olhar valor: `filters.authors`, `channels`. */
export function camposLocais(marcas: MapaDeMarcas, prefixo = ""): string[] {
  return Object.entries(marcas).flatMap(([campo, m]) => (ehLocal(m) ? [`${prefixo}${campo}`] : temFilhos(m) ? camposLocais(m.filhos, `${prefixo}${campo}.`) : []));
}

function semCaminho(valor: unknown, caminho: string): unknown {
  const [cabeca, ...resto] = caminho.split(".");
  if (!ehObjeto(valor) || cabeca === undefined || !(cabeca in valor)) return valor;
  const copia = { ...valor };
  if (resto.length === 0) delete copia[cabeca];
  else copia[cabeca] = semCaminho(copia[cabeca], resto.join("."));
  return copia;
}

/* ------------------------------------------------------------------- volta */

export interface Volta {
  texto: string;
  origem: ReturnType<typeof maquina>;
  destino: ReturnType<typeof maquina>;
  /** O que a importação gravou na automação, sem `pendentes`. */
  importada: AgentSpec;
  pendentes: NonNullable<AgentSpec["pendentes"]>;
  /** Os gatilhos criados na máquina de destino. */
  gatilhos: { id: string; enabled: boolean; config: TriggerConfig }[];
}

export async function idaEVolta(fluxo: Fluxo): Promise<Volta> {
  const origem = maquina(new Map(Object.entries(fluxo.skills ?? {})));
  for (const ts of fluxo.toolsets ?? []) await origem.library.saveToolset({ toolset: ts, create: true });
  for (const agent of fluxo.agents ?? []) await origem.library.saveProfile({ spec: agent, note: "", create: true });
  const spec = AgentSpec.parse(fluxo.spec);
  await origem.automations.save({ spec, triggers: (fluxo.gatilhos ?? []).map((config) => ({ config })), note: "", create: true });
  const { texto } = await origem.pacotes.exportar(spec.id);

  const destino = maquina(new Map());
  await destino.pacotes.importar(texto);

  const original = (await origem.automations.get(spec.id))!;
  const volta = (await destino.automations.get(spec.id))!;
  const { pendentes = [], ...importada } = volta.version.spec;
  const gatilhos = volta.triggers.map((g) => ({ id: g.id, enabled: g.enabled, config: TriggerConfig.parse(g.config) }));
  const resultado: Volta = { texto, origem, destino, importada: importada as AgentSpec, pendentes, gatilhos };

  await conferirSpec(original.version.spec, resultado);
  await conferirGatilhos(original.triggers.map((g) => TriggerConfig.parse(g.config)), resultado);
  await conferirAgents(fluxo, resultado);
  conferirSkills(origem.skills, destino.skills);
  return resultado;
}

const porChave = (spec: AgentSpec): unknown => ({ ...spec, steps: Object.fromEntries(spec.steps.map((p) => [p.key, p])) });

async function conferirSpec(original: AgentSpec, v: Volta): Promise<void> {
  const declaracoes = Object.fromEntries(acoesRegistradas().map((a) => [a.kind, a.declaracao]));
  const locais = new Set<string>();
  const esperadas: { onde: string; campo: string; caminho: string }[] = [];
  const registrar = (chave: string, campo: string): void => {
    locais.add(`steps.${chave}.${campo}`);
    esperadas.push({ onde: chave, campo, caminho: `steps.${chave}.${campo}` });
  };
  // `auto` entra em aprovação na volta: publicar sozinho, sem ninguém ter dito que pode, é regra do importador.
  const aposImportar: AgentSpec = {
    ...original,
    steps: original.steps.map((p) => (p.type === "action" && p.mode === "auto" ? { ...p, mode: "approve" as const } : p)),
  };
  for (const p of original.steps) {
    if (p.type !== "action") continue;
    for (const campo of camposLocais(MARCAS_DO_PASSO_DE_ACAO)) if (p[campo as keyof typeof p] !== undefined) registrar(p.key, campo);
    for (const nome of paramsParaPacote(declaracoes[p.action] ?? {}, p.params ?? {}).omitidos) registrar(p.key, `params.${nome}`);
  }
  conferir("spec", diferencas(porChave(aposImportar), porChave(v.importada), ""), locais);
  for (const e of esperadas) {
    assert.ok(v.pendentes.some((p) => p.onde === e.onde && p.campo === e.campo), `spec: ${e.caminho} não ficou em pendentes (${JSON.stringify(v.pendentes)})`);
  }
}

async function conferirGatilhos(originais: TriggerConfig[], v: Volta): Promise<void> {
  const usados = new Set<string>();
  for (const [i, config] of originais.entries()) {
    const marcas = MARCAS_DOS_GATILHOS[config.kind] as MapaDeMarcas;
    const locais = new Set([...aplicarMarcas(marcas, config as Record<string, unknown>).omitidos.values()].flatMap((d) => d.nomes));
    const quem = `gatilho ${config.kind}#${i}`;
    // O que o cadastro recusa sem o campo local não chega a ser criado: a pendência fica na automação, no lugar.
    const criado = TriggerConfig.safeParse([...locais].reduce(semCaminho, config)).success;
    // O que viaja por outro campo (`dobrado`) fica fora da comparação campo a campo.
    const dobrados = Object.entries(marcas).filter(([, m]) => m === "dobrado").map(([campo]) => campo);
    if (!criado) {
      for (const campo of locais) {
        const achada = v.pendentes.find((p) => p.onde.startsWith("gatilho:") && p.campo === campo && !v.gatilhos.some((g) => p.onde === `gatilho:${g.id}`));
        assert.ok(achada !== undefined, `${quem}: não criado, e ${campo} não ficou em pendentes (${JSON.stringify(v.pendentes)})`);
      }
      continue;
    }
    const importado = v.gatilhos.find((g) => g.config.kind === config.kind && !usados.has(g.id) && diferencas(dobrados.concat([...locais]).reduce(semCaminho, config), dobrados.reduce(semCaminho, g.config), "").length === 0);
    const achado = importado ?? v.gatilhos.filter((g) => g.config.kind === config.kind && !usados.has(g.id))[0];
    assert.ok(achado !== undefined, `${quem}: não foi criado na importação`);
    usados.add(achado.id);
    assert.equal(achado.enabled, false, `${quem}: a importação não liga gatilho`);
    conferir(quem, diferencas(dobrados.reduce(semCaminho, config), dobrados.reduce(semCaminho, achado.config), ""), locais);
    for (const campo of locais) {
      // Os chats do Teams esperam a escolha no próprio gatilho: `chatsPendentes` conta quantos eram.
      if (config.kind === "teams-inbox" && campo === "chats") {
        assert.equal((achado.config as { chatsPendentes: number }).chatsPendentes, (config as { chats: unknown[] }).chats.length, `${quem}: chatsPendentes não guardou quantos chats eram`);
        continue;
      }
      assert.ok(v.pendentes.some((p) => p.onde === `gatilho:${achado.id}` && p.campo === campo), `${quem}: ${campo} não ficou em pendentes (${JSON.stringify(v.pendentes)})`);
    }
  }
}

async function conferirAgents(fluxo: Fluxo, v: Volta): Promise<void> {
  for (const bruto of fluxo.agents ?? []) {
    const original = (await v.origem.library.getProfile(bruto.id))!.spec;
    // O toolset vira ferramentas do próprio agent: o pacote não carrega conjuntos compartilhados.
    const doToolset = (await Promise.all(original.toolsets.map((id) => v.origem.library.getToolset(id)))).flatMap((t) => t?.tools ?? []);
    const vistas = new Set<string>();
    const tools = [...doToolset, ...original.tools].filter((t) => !vistas.has(`${t.server}/${t.tool}`) && vistas.add(`${t.server}/${t.tool}`));
    const esperado = AgentProfile.parse({ ...original, toolsets: [], tools });
    const importado = (await v.destino.library.getProfile(bruto.id))?.spec;
    assert.ok(importado !== undefined, `agent ${bruto.id}: não foi importado`);
    conferir(`agent ${bruto.id}`, diferencas(esperado, importado, ""), new Set(camposLocais(MARCAS_DO_AGENT)));
  }
}

function conferirSkills(origem: Skills, destino: Skills): void {
  for (const [nome, conteudo] of origem) {
    assert.ok(destino.has(nome), `skill ${nome}: não foi criada na importação`);
    conferir(`skill ${nome}`, diferencas(conteudo, destino.get(nome), ""), new Set());
  }
}
