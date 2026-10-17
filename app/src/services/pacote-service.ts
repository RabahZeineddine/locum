import { basename } from "node:path";
import {
  AgentProfile,
  AgentSpec,
  TriggerConfig,
  type AgentConnection,
  type Step,
  type ToolRef,
  type TriggerConfigInput,
} from "../config/types.js";
import { CATALOG, conexaoDoServidor } from "./conexao-catalogo.js";
import { ID_DE_AGENT, agentService, type AgentService } from "./agent-service.js";
import { automationService, type AutomationService } from "./automation-service.js";
import { libraryService, type LibraryService } from "./library-service.js";
import { SERVIDOR_CONTA, SERVIDOR_NATIVO } from "../config/types.js";
import {
  NOME_DO_FORMATO,
  Pacote,
  VERSAO_DO_FORMATO,
  EXTENSAO_DO_PACOTE,
  lerPacote,
  type AgentDoPacote,
  type CodigoOmitido,
  type GatilhoDoPacote,
  type PassoDoPacote,
} from "../pacote/formato.js";
import { limparValor } from "../pacote/limpeza.js";
import { MARCAS_DOS_GATILHOS } from "../pacote/marcacao.js";
import { aplicarMarcas, origemDaUrl, paramsDoPacoteParaPasso, paramsParaPacote, type ParamsDoPacote } from "../pacote/params.js";
import { ehLeitura, ehLeituraDa, type FerramentaClassificavel } from "../config/leitura.js";

/**
 * Exportar e importar uma automação em pacote (ADR 0005, decisão 7).
 *
 * Exportar monta o pacote só com o que o formato permite carregar, e passa o
 * resultado por uma limpeza de texto: o que sai daqui vai para outra pessoa.
 * Importar não grava na primeira leitura. `previa` diz o que seria criado e o
 * que falta nesta máquina, e `importar` grava o que a pessoa decidiu, com as
 * dependências ligadas ao que ela tem.
 *
 * Importar nunca cadastra servidor MCP, nunca liga gatilho e nunca roda nada
 * do arquivo: o que o pacote diz de servidor é nome para achar o equivalente.
 */

/* ---------------------------------------------------------------- ambiente */

/** O que esta máquina tem, lido na hora da prévia. Injetável para o teste. */
export interface AmbienteDoPacote {
  conexoes(): Promise<{ id: string; nome: string; estado: string; tokenDoGithub?: boolean }[]>;
  /** Servidores MCP cadastrados. Só o que nomeia: nunca env, cabeçalho ou credencial. */
  servidores(): Promise<{ nome: string; ligado: boolean; url?: string; command?: string[] }[]>;
  /** Provedores conhecidos, com os modelos de quem está disponível. */
  provedores(): Promise<{ provedor: string; disponivel: boolean; modelos: string[] }[]>;
  /** A última lista boa de ferramentas do servidor, com as anotações dele. Nula sem cache. */
  guardadas(servidor: string): Promise<(FerramentaClassificavel & { inputSchema?: Record<string, unknown> })[] | null>;
  /** Como cada ação declara que seus params viajam. Padrão: o que os handlers registrados declaram. */
  acoes?(): Promise<Record<string, ParamsDoPacote>>;
  /** Nomes das skills que esta máquina tem. */
  skills(): Promise<string[]>;
}

const ambientePadrao: AmbienteDoPacote = {
  guardadas: async (servidor) => {
    const { mcpService } = await import("./mcp-service.js");
    const guardada = await mcpService.cachedTools(servidor);
    return guardada?.tools.map(({ name, readOnlyHint, destructiveHint, inputSchema }) => ({ name, readOnlyHint, destructiveHint, ...(inputSchema === undefined ? {} : { inputSchema }) })) ?? null;
  },
  acoes: async () => {
    const { buildGate } = await import("../executor/build.js");
    return Object.fromEntries(buildGate().describe().map((a) => [a.kind, a.paramsDoPacote ?? {}]));
  },
  skills: async () => {
    const { discoverSkills } = await import("../skills/loader.js");
    return [...discoverSkills().keys()];
  },
  conexoes: async () => {
    const { connectionService } = await import("./connection-service.js");
    return (await connectionService.list({ incluirInternos: true })).map((c) => ({
      id: c.id,
      nome: c.name,
      estado: c.state,
      ...(c.partes === null ? {} : { tokenDoGithub: c.partes.token === "ok" }),
    }));
  },
  servidores: async () => {
    const { mcpService } = await import("./mcp-service.js");
    return (await mcpService.list()).map((s) => ({
      nome: s.config.name,
      ligado: s.enabled,
      ...(s.config.url === undefined ? {} : { url: s.config.url }),
      ...(s.config.command === undefined ? {} : { command: s.config.command }),
    }));
  },
  provedores: async () => {
    const { providerService } = await import("./provider-service.js");
    return Promise.all(
      providerService.listProviders().map(async (p) => ({
        provedor: p.name,
        disponivel: p.available,
        modelos: p.available ? (await providerService.listModels(p.name)).modelos : [],
      })),
    );
  },
};

/* -------------------------------------------------------------------- tipos */

export type EstadoDaDependencia = "ok" | "falta-conectar" | "ausente";

export interface DependenciaDaPrevia {
  tipo: "conexao" | "servidor" | "provedor" | "skill";
  /** Id da conexão, nome do servidor ou nome do provedor, como o pacote os cita. */
  chave: string;
  nome: string;
  estado: EstadoDaDependencia;
  /** Pacote ou endereço que o pacote deu, para a pessoa reconhecer o servidor. */
  detalhe?: string;
  /** Quem usa: `agent:<id>`, `passo:<chave>` ou `gatilho:<tipo>`. */
  usadoPor: string[];
  /** Onde resolver quando falta. */
  atalho: "conexoes" | "importar-do-claude" | "modelos" | null;
  /** O que esta máquina tem que pode fazer o papel, para ligar. */
  candidatos: { valor: string; rotulo: string }[];
}

export type SituacaoDoAgent = "novo" | "mesmo-id" | "igual" | "nome-igual";

/** Uma ferramenta que o pacote liga a um agent ou passo, com a classe calculada aqui. */
export interface FerramentaNaPrevia {
  /** `agent:<id>` ou `passo:<chave>`. */
  dono: string;
  servidor: string | null;
  ferramenta: string;
  /** Calculada nesta máquina, pela anotação do servidor ou pelo nome. O que o arquivo declara não vale. */
  classe: "leitura" | "escrita";
  /** `conexao`: ferramenta ligada na conexão do agent. `avulsa`: lista de ferramentas do agent, do passo ou da automação. */
  origem: "conexao" | "avulsa";
  /** Escrita avulsa não entra na importação: fica de fora e vira pendência. Na conexão ela entra e pede confirmação. */
  removida: boolean;
  /** O que o arquivo declarava, quando divergia da calculada. */
  declarada?: "leitura";
}

/** Um campo do agent que difere entre o do pacote e o daqui. Texto, já resumido a um tamanho que cabe na tela. */
export interface DiferencaDoAgent {
  campo: "description" | "context" | "instructions" | "model" | "temperature" | "tools" | "connections" | "skills" | "budget" | "maxSteps";
  daqui: string;
  pacote: string;
}

export interface ModeloNaPrevia {
  /** Chave da escolha: `agent:<id>` ou `passo:<chave>`. */
  chave: string;
  rotulo: string;
  sugerido: string;
  /** O modelo sugerido existe aqui. Falso pede que a pessoa escolha. */
  disponivel: boolean;
  /** O que a tela pré-seleciona: o sugerido, ou o primeiro do mesmo provedor. */
  padrao: string | null;
}

export interface AgentNaPrevia {
  id: string;
  nome: string;
  situacao: SituacaoDoAgent;
  /** Versão que existe aqui, quando o id já existe. */
  versaoAtual?: number;
  /** O agent daqui com o mesmo nome e outro id, em `nome-igual`. */
  existente?: { id: string; nome: string };
  /** Automações daqui que usam o agent, e que passariam a rodar o texto do pacote em `atualizar`. */
  usadoPor: string[];
  idSugerido: string;
  modelo: ModeloNaPrevia;
  /** Em `mesmo-id`: o que muda se a pessoa escolher atualizar o dela. */
  diferencas: DiferencaDoAgent[];
}

export interface PreviaDoPacote {
  automacao: { id: string; nome: string; existe: boolean; idSugerido: string };
  agents: AgentNaPrevia[];
  /** Passos de IA que não usam agent: o modelo é deles. */
  passosDeIA: ModeloNaPrevia[];
  dependencias: DependenciaDaPrevia[];
  /** Toda ferramenta que o pacote liga, com a classe calculada aqui. Escrita vem destacada pela tela. */
  ferramentas: FerramentaNaPrevia[];
  /** Passos `http.request`: o endereço não vem no pacote, só o host como dica. */
  urlsAPreencher: { passo: string; origem?: string }[];
  /** Os modelos que esta máquina oferece, como `provedor/modelo`, para ligar cada agent. */
  modelosAqui: string[];
  /** Todos entram desligados; `precisaCanal` fica de fora até a pessoa escolher. */
  gatilhos: { tipo: string; precisaCanal: boolean; precisaChats: boolean }[];
  /** O que o pacote deixou de fora de propósito, para a pessoa escolher aqui. */
  omitidos: Pacote["omitidos"];
  /** Passos de ação que o pacote trazia em modo `auto` e entram em `approve`. */
  acoesRebaixadas: string[];
}

export interface EscolhasDaImportacao {
  automacaoId?: string;
  /** Por id do agent no pacote. */
  /**
   * O padrão, sem escolha, é `criar-novo`: agent de mesmo id nunca é reescrito
   * por omissão. `atualizar` só vale em `mesmo-id` e só por escolha explícita.
   */
  agents?: Record<string, { acao: "atualizar" | "criar-novo" | "usar-existente" }>;
  /** Nome do servidor no pacote para o nome do equivalente cadastrado aqui. */
  servidores?: Record<string, string>;
  /** Id de conexão no pacote para o id da conexão daqui. */
  conexoes?: Record<string, string>;
  /** `agent:<id>` ou `passo:<chave>` para `provedor/modelo`. */
  modelos?: Record<string, string>;
}

export interface ResultadoDaImportacao {
  automacaoId: string;
  agents: { id: string; acao: "criado" | "atualizado" | "igual" | "existente"; versao: number }[];
  gatilhos: number;
  /** O que a pessoa ainda precisa escolher na automação criada. */
  pendencias: { codigo: CodigoOmitido; onde: string; dica?: string; params?: string[] }[];
}

/** Falta decisão da pessoa: a mensagem diz sobre o quê. */
export class DecisaoPendenteError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "DecisaoPendenteError";
  }
}

/** O pacote exportado: o texto do arquivo e o nome sugerido para ele. */
export interface PacoteExportado {
  texto: string;
  nomeDoArquivo: string;
  pacote: Pacote;
}

/* ------------------------------------------------------------------ ajudas */

const INTERNOS = new Set([SERVIDOR_NATIVO, SERVIDOR_CONTA]);
const CATALOGO = new Map(CATALOG.map((c) => [c.id, c]));

const CONEXAO_DA_ACAO: Readonly<Record<string, string>> = {
  "slack.post": "slack",
  "teams.post": "teams",
  "github.review_comment": "github",
};

const CONEXAO_DO_GATILHO: Readonly<Record<string, string>> = {
  poll: "github",
  "teams-inbox": "teams",
  "slack-inbox": "slack",
  "slack-channel": "slack",
};

function provedorDe(modelo: string): string {
  const corte = modelo.indexOf("/");
  return corte < 0 ? "desconhecido" : modelo.slice(0, corte);
}

function hostDe(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export { origemDaUrl };

const EXECUTORES_DE_PACOTE = new Set(["npx", "bunx", "pnpx", "uvx", "pipx"]);
const GERENTES = new Set(["npm", "pnpm", "yarn", "bun"]);

/**
 * O nome do pacote de um servidor stdio, para a pessoa reconhecer o servidor.
 * Nunca o comando: caminho, argumento e variável ficam no cadastro local.
 */
export function pacoteDoComando(command: readonly string[] | undefined): string | undefined {
  if (command === undefined || command.length === 0) return undefined;
  const exe = basename(command[0]!);
  const args = command.slice(1);
  let alvo: string | undefined;
  if (EXECUTORES_DE_PACOTE.has(exe)) alvo = args.find((a) => !a.startsWith("-"));
  else if (GERENTES.has(exe) && ["dlx", "exec", "x"].includes(args[0] ?? "")) alvo = args.slice(1).find((a) => !a.startsWith("-"));
  else return /^[\w.-]+$/.test(exe) ? exe : undefined;
  if (alvo === undefined) return undefined;
  const semVersao = alvo.replace(/(?<=.)@[^@/]+$/, "");
  return /^(?:@[\w.-]+\/)?[\w.-]+$/.test(semVersao) ? semVersao : undefined;
}

function chaveDaFerramenta(t: ToolRef): string {
  return `${t.server}/${t.tool}`;
}

function semRepetir(tools: readonly ToolRef[]): ToolRef[] {
  const vistas = new Map<string, ToolRef>();
  for (const t of tools) if (!vistas.has(chaveDaFerramenta(t))) vistas.set(chaveDaFerramenta(t), t);
  return [...vistas.values()];
}

function norm(nome: string): string {
  return nome.trim().toLowerCase();
}

/* ----------------------------------------------------------------- serviço */

export class PacoteService {
  constructor(
    private readonly agents: AgentService = agentService,
    private readonly library: LibraryService = libraryService,
    private readonly automations: AutomationService = automationService,
    private readonly ambiente: AmbienteDoPacote = ambientePadrao,
    /** O home a esconder do texto livre. Padrão: o da máquina. */
    private readonly home?: string,
  ) {}

  /* --------------------------------------------------------------- exportar */

  async exportar(agentId: string): Promise<PacoteExportado> {
    const automacao = await this.automations.get(agentId);
    if (automacao === null) throw new Error(`a automação "${agentId}" não existe`);
    const spec = automacao.version.spec;
    const omitidos: Pacote["omitidos"] = [];
    const omitir = (codigo: CodigoOmitido, onde: string, quantos?: number, params?: string[]): void => {
      omitidos.push({ codigo, onde, ...(quantos === undefined ? {} : { quantos }), ...(params === undefined ? {} : { params }) });
    };
    const declaracoes = await this.declaracoes();

    // Agents que o fluxo usa, na ordem em que aparecem.
    const idsDosAgents = [...new Set(spec.steps.flatMap((p) => (p.type === "model" && p.profile !== undefined ? [p.profile] : [])))];
    const agents: AgentDoPacote[] = [];
    for (const id of idsDosAgents) agents.push(await this.agentParaPacote(id));

    const passos: PassoDoPacote[] = [];
    for (const p of spec.steps) passos.push(await this.passoParaPacote(p, omitir, declaracoes));
    const gatilhos: GatilhoDoPacote[] = [];
    for (const g of automacao.triggers) gatilhos.push(await this.gatilhoParaPacote(g.config, omitir));

    const base = {
      formato: NOME_DO_FORMATO,
      versao: VERSAO_DO_FORMATO,
      automacao: {
        id: spec.id,
        spec: {
          name: spec.name,
          defaultTools: spec.defaultTools,
          skills: spec.skills,
          steps: passos,
          budget: spec.budget,
          ...(spec.layout === undefined ? {} : { layout: spec.layout }),
        },
        gatilhos,
      },
      agents,
      requisitos: await this.requisitos(spec, agents, gatilhos),
      omitidos,
    };

    const limpo = limparValor(base, this.home);
    const pacote = Pacote.parse(limpo.valor);
    if (limpo.removidos > 0) pacote.omitidos.push({ codigo: "texto-limpo", onde: "automacao", quantos: limpo.removidos });
    return {
      pacote,
      texto: `${JSON.stringify(pacote, null, 2)}\n`,
      nomeDoArquivo: `${spec.id}${EXTENSAO_DO_PACOTE}`,
    };
  }

  private async agentParaPacote(id: string): Promise<AgentDoPacote> {
    const versao = await this.library.getProfile(id);
    if (versao === null) throw new Error(`o agent "${id}", usado pela automação, não existe`);
    return this.perfilParaPacote(versao.spec);
  }

  /** O agent na forma do pacote: o toolset vira ferramentas avulsas dele. */
  private async perfilParaPacote(s: AgentProfile): Promise<AgentDoPacote> {
    const id = s.id;
    // O toolset vira ferramentas do próprio agent: o pacote não carrega conjuntos compartilhados.
    const doToolset: ToolRef[] = [];
    for (const toolsetId of s.toolsets) {
      const toolset = await this.library.getToolset(toolsetId);
      if (toolset === null) throw new Error(`o agent "${id}" usa o toolset "${toolsetId}", que não existe mais`);
      doToolset.push(...toolset.tools);
    }
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      context: s.context,
      instructions: s.instructions,
      model: s.model,
      ...(s.temperature === undefined ? {} : { temperature: s.temperature }),
      tools: semRepetir([...doToolset, ...s.tools]),
      connections: s.connections,
      skills: s.skills.map((k) => (typeof k === "string" ? { skill: k, when: { always: true } } : k)),
      budget: s.budget,
      maxSteps: s.maxSteps,
    };
  }

  /** O que cada ação declara sobre a viagem dos params; a de uma ação desconhecida é vazia (nada viaja). */
  private async declaracoes(): Promise<Record<string, ParamsDoPacote>> {
    return (this.ambiente.acoes ?? ambientePadrao.acoes!)();
  }

  private async passoParaPacote(
    passo: Step,
    omitir: (c: CodigoOmitido, onde: string, q?: number, params?: string[]) => void,
    declaracoes: Record<string, ParamsDoPacote>,
  ): Promise<PassoDoPacote> {
    if (passo.type !== "action") return passo;
    const { target, params, ...resto } = passo;
    if (target !== undefined) omitir("tracker", passo.key);
    const sensivel = await this.sensivelDaFerramenta(params);
    const r = paramsParaPacote(declaracoes[passo.action] ?? {}, params ?? {}, { ...(this.home === undefined ? {} : { home: this.home }), sensivel });
    const urls = new Set(r.urls.map((u) => u.param));
    const fixos = new Set(r.destinosFixos);
    const faltou = r.omitidos.filter((n) => !urls.has(n) && !fixos.has(n));
    if (faltou.length > 0) omitir("argumentos", passo.key, faltou.length, faltou);
    if (fixos.size > 0) omitir("destino-a-escolher", passo.key, fixos.size, [...fixos]);
    if (urls.size > 0) omitir("url-a-preencher", passo.key, undefined, [...urls]);
    if (r.limpos > 0) omitir("texto-limpo", passo.key, r.limpos);
    return { ...resto, ...(Object.keys(r.params).length === 0 ? {} : { params: r.params }) };
  }

  /** Diz se um argumento de `server`/`tool` é sensível pelo esquema da ferramenta (`writeOnly` ou `format: password`). */
  private async sensivelDaFerramenta(params: Record<string, unknown> | undefined): Promise<(caminho: string[]) => boolean> {
    const { server, tool } = params ?? {};
    if (typeof server !== "string" || typeof tool !== "string") return () => false;
    const esquema = (await this.ambiente.guardadas(server).catch(() => null))?.find((f) => f.name === tool)?.inputSchema;
    return (caminho) => {
      let no: unknown = esquema;
      for (const parte of caminho) {
        no = (no as { properties?: Record<string, unknown> } | undefined)?.properties?.[parte];
        if (no === undefined) return false;
      }
      const n = no as { writeOnly?: unknown; format?: unknown };
      return n.writeOnly === true || n.format === "password";
    };
  }

  /** O gatilho no pacote: um só código aplica `MARCAS_DOS_GATILHOS`; o que é da pessoa sai e vira pendência. */
  private async gatilhoParaPacote(
    config: GatilhoConfig,
    omitir: (c: CodigoOmitido, onde: string, q?: number, params?: string[]) => void,
  ): Promise<GatilhoDoPacote> {
    const sensivel = await this.sensivelDaFerramenta(config as unknown as Record<string, unknown>);
    const r = aplicarMarcas(MARCAS_DOS_GATILHOS[config.kind], config as unknown as Record<string, unknown>, {
      ...(this.home === undefined ? {} : { home: this.home }),
      sensivel,
    });
    for (const [codigo, d] of r.omitidos) omitir(codigo, config.kind, d.quantos, d.nomes);
    if (r.limpos > 0) omitir("texto-limpo", config.kind, r.limpos);
    if (config.kind !== "teams-inbox") return r.valor as GatilhoDoPacote;
    // Quantos chats restringiam o gatilho, sem os ids; chats ainda por escolher contam também.
    const restritos = config.chats.length > 0 ? config.chats.length : config.chatsPendentes;
    return (restritos === 0 ? r.valor : { ...r.valor, chatsRestritos: restritos }) as GatilhoDoPacote;
  }

  private async requisitos(spec: AgentSpec, agents: readonly AgentDoPacote[], gatilhos: readonly GatilhoDoPacote[]): Promise<Pacote["requisitos"]> {
    const servidores = new Set<string>();
    const conexoes = new Set<string>();
    const modelos = new Map<string, Set<string>>();
    const citarServidor = (nome: string): void => {
      if (!INTERNOS.has(nome)) servidores.add(nome);
    };
    const citarConexao = (id: string): void => {
      if (CATALOGO.has(id)) conexoes.add(id);
      else citarServidor(id);
    };
    const citarModelo = (modelo: string): void => {
      const prov = provedorDe(modelo);
      const set = modelos.get(prov) ?? new Set<string>();
      set.add(prov === "desconhecido" ? modelo : modelo.slice(prov.length + 1));
      modelos.set(prov, set);
    };

    for (const t of spec.defaultTools) citarServidor(t.server);
    for (const passo of spec.steps) {
      if (passo.type === "model") {
        for (const t of passo.tools ?? []) citarServidor(t.server);
        for (const s of passo.requiresServers) citarServidor(s);
        if (passo.profile === undefined) citarModelo(passo.model);
      } else if (passo.type === "action") {
        const dona = CONEXAO_DA_ACAO[passo.action];
        if (dona !== undefined) conexoes.add(dona);
        const server = passo.params?.server;
        if (passo.action === "mcp.call" && typeof server === "string") citarServidor(server);
      }
    }
    for (const g of gatilhos) {
      const dona = CONEXAO_DO_GATILHO[g.kind];
      if (dona !== undefined) conexoes.add(dona);
      if (g.kind === "mcp-poll") citarServidor(g.server);
    }
    for (const agent of agents) {
      citarModelo(agent.model);
      for (const t of agent.tools) citarServidor(t.server);
      for (const c of agent.connections) {
        citarConexao(c.connectionId);
        for (const chave of Object.keys(c.tools)) {
          const corte = chave.indexOf("/");
          if (corte > 0) citarServidor(chave.slice(0, corte));
        }
      }
    }

    const skills = new Set<string>();
    for (const k of spec.skills) skills.add(k.skill);
    for (const agent of agents) for (const k of agent.skills) skills.add(k.skill);

    const cadastrados = new Map((await this.ambiente.servidores()).map((s) => [s.nome, s]));
    const requeridos: Pacote["requisitos"]["servidores"] = [];
    for (const nome of [...servidores].sort()) {
      const cad = cadastrados.get(nome);
      const dono = conexaoDoServidor({ name: nome, ...(cad?.url === undefined ? {} : { url: cad.url }), ...(cad?.command === undefined ? {} : { command: cad.command }) });
      if (dono !== undefined) conexoes.add(dono.id);
      const pacote = pacoteDoComando(cad?.command);
      const host = hostDe(cad?.url);
      requeridos.push({
        nome,
        ...(pacote === undefined ? {} : { pacote }),
        ...(host === undefined ? {} : { host }),
        ...(dono === undefined ? {} : { conexao: dono.id }),
      });
    }

    return {
      conexoes: [...conexoes].sort().map((id) => ({ id, nome: CATALOGO.get(id)?.name ?? id })),
      servidores: requeridos,
      provedores: [...modelos].sort(([a], [b]) => a.localeCompare(b)).map(([provedor, lista]) => ({ provedor, modelos: [...lista].sort() })),
      skills: [...skills].sort().map((nome) => ({ nome })),
    };
  }

  /* ----------------------------------------------------------------- prévia */

  async previa(texto: string): Promise<PreviaDoPacote> {
    const pacote = lerPacote(texto);
    const declaracoes = await this.declaracoes();
    const [conexoes, servidores, provedores, existentes, skills] = await Promise.all([
      this.ambiente.conexoes(),
      this.ambiente.servidores(),
      this.ambiente.provedores(),
      this.library.listProfiles(),
      this.ambiente.skills(),
    ]);
    const disponiveis = new Set(provedores.flatMap((p) => p.modelos.map((m) => `${p.provedor}/${m}`)));
    const provedorDaMaquina = new Map(provedores.map((p) => [p.provedor, p]));

    const modeloNaPrevia = (chave: string, rotulo: string, sugerido: string): ModeloNaPrevia => {
      const disponivel = disponiveis.has(sugerido);
      const doMesmo = provedorDaMaquina.get(provedorDe(sugerido))?.modelos[0];
      return {
        chave,
        rotulo,
        sugerido,
        disponivel,
        padrao: disponivel ? sugerido : doMesmo === undefined ? null : `${provedorDe(sugerido)}/${doMesmo}`,
      };
    };

    const automacaoExiste = (await this.agents.get(pacote.automacao.id)) !== undefined;
    const idSugerido = automacaoExiste ? await this.automations.suggestId(pacote.automacao.spec.name) : pacote.automacao.id;

    const agents: AgentNaPrevia[] = [];
    for (const agent of pacote.agents) {
      const atual = await this.library.getProfile(agent.id);
      const mesmoNome = existentes.find((e) => e.id !== agent.id && norm(e.name) === norm(agent.name));
      const diferencas =
        atual === null
          ? []
          : diferencasDoAgent(await this.perfilParaPacote(atual.spec), { ...agent, connections: await this.library.normalizarConexoes(agent.connections) });
      let situacao: SituacaoDoAgent = "novo";
      if (atual !== null) situacao = diferencas.length === 0 ? "igual" : "mesmo-id";
      else if (mesmoNome !== undefined) situacao = "nome-igual";
      agents.push({
        id: agent.id,
        nome: agent.name,
        situacao,
        diferencas,
        ...(atual === null ? {} : { versaoAtual: atual.version }),
        ...(situacao === "nome-igual" && mesmoNome !== undefined ? { existente: { id: mesmoNome.id, nome: mesmoNome.name } } : {}),
        usadoPor: existentes.find((e) => e.id === agent.id)?.usedBy ?? [],
        idSugerido: atual === null && mesmoNome === undefined ? agent.id : await this.library.suggestId(agent.name, "profile"),
        modelo: modeloNaPrevia(`agent:${agent.id}`, agent.name, agent.model),
      });
    }

    const passosDeIA = pacote.automacao.spec.steps.flatMap((p) =>
      p.type === "model" && p.profile === undefined ? [modeloNaPrevia(`passo:${p.key}`, p.name, p.model)] : [],
    );

    return {
      automacao: { id: pacote.automacao.id, nome: pacote.automacao.spec.name, existe: automacaoExiste, idSugerido },
      agents,
      passosDeIA,
      dependencias: this.dependencias(pacote, { conexoes, servidores, provedores, disponiveis, skills }),
      ferramentas: await this.ferramentasDoPacote(pacote),
      urlsAPreencher: pacote.automacao.spec.steps.flatMap((p) =>
        p.type === "action" && Object.values(declaracoes[p.action] ?? {}).includes("url")
          ? [{ passo: p.key, ...(typeof p.params?.origem === "string" ? { origem: p.params.origem } : {}) }]
          : [],
      ),
      modelosAqui: [...disponiveis].sort(),
      gatilhos: pacote.automacao.gatilhos.map((g) => ({
        tipo: g.kind,
        precisaCanal: g.kind === "slack-channel",
        precisaChats: g.kind === "teams-inbox" && g.chatsRestritos !== undefined,
      })),
      omitidos: pacote.omitidos,
      acoesRebaixadas: pacote.automacao.spec.steps.flatMap((p) => (p.type === "action" && p.mode === "auto" ? [p.key] : [])),
    };
  }

  /** Toda ferramenta que o pacote liga, com a classe calculada aqui, nunca a do arquivo. */
  private async ferramentasDoPacote(pacote: Pacote): Promise<FerramentaNaPrevia[]> {
    const lista: FerramentaNaPrevia[] = [];
    const cache = new Map<string, FerramentaClassificavel[] | null>();
    const adicionar = async (dono: string, servidor: string | null, ferramenta: string, declaradaLeitura: boolean, origem: "conexao" | "avulsa" = "avulsa"): Promise<void> => {
      const classe = await this.classificar(servidor, ferramenta, cache);
      lista.push({ dono, servidor, ferramenta, classe, origem, removida: origem === "avulsa" && classe === "escrita", ...(declaradaLeitura && classe === "escrita" ? { declarada: "leitura" as const } : {}) });
    };
    for (const t of pacote.automacao.spec.defaultTools) await adicionar("automacao", t.server, t.tool, t.class === "read");
    for (const p of pacote.automacao.spec.steps) {
      if (p.type !== "model") continue;
      for (const t of p.tools ?? []) await adicionar(`passo:${p.key}`, t.server, t.tool, t.class === "read");
    }
    for (const a of pacote.agents) {
      for (const t of a.tools) await adicionar(`agent:${a.id}`, t.server, t.tool, t.class === "read");
      for (const c of a.connections) {
        for (const [chave, escolha] of Object.entries(c.tools)) {
          if (escolha === false) continue;
          const corte = chave.indexOf("/");
          await adicionar(`agent:${a.id}`, corte > 0 ? chave.slice(0, corte) : null, chave.slice(corte + 1), escolha === "read", "conexao");
        }
      }
    }
    return lista;
  }

  /**
   * Leitura ou escrita desta ferramenta nesta máquina: a anotação do servidor
   * quando há cache, senão o nome. O que o arquivo declara não entra.
   */
  private async classificar(servidor: string | null, ferramenta: string, cache: Map<string, FerramentaClassificavel[] | null>): Promise<"leitura" | "escrita"> {
    if (servidor !== null) {
      if (!cache.has(servidor)) cache.set(servidor, await this.ambiente.guardadas(servidor));
      const achada = cache.get(servidor)?.find((f) => f.name === ferramenta);
      if (achada !== undefined) return ehLeituraDa(achada) ? "leitura" : "escrita";
    }
    return ehLeitura(ferramenta) ? "leitura" : "escrita";
  }

  /** A classe de cada ferramenta recalculada: ou leitura, ou escrita externa, que passa pela aprovação. */
  private async reclassificar(tools: readonly ToolRef[], servidor: (nome: string) => string): Promise<ToolRef[]> {
    const cache = new Map<string, FerramentaClassificavel[] | null>();
    const saida: ToolRef[] = [];
    for (const t of tools) {
      const server = servidor(t.server);
      const classe = await this.classificar(server, t.tool, cache);
      saida.push({ server, tool: t.tool, class: classe === "leitura" ? "read" : "external_write" });
    }
    return saida;
  }

  private dependencias(
    pacote: Pacote,
    local: {
      conexoes: Awaited<ReturnType<AmbienteDoPacote["conexoes"]>>;
      servidores: Awaited<ReturnType<AmbienteDoPacote["servidores"]>>;
      provedores: Awaited<ReturnType<AmbienteDoPacote["provedores"]>>;
      disponiveis: Set<string>;
      skills: string[];
    },
  ): DependenciaDaPrevia[] {
    const usos = usosDasDependencias(pacote);
    const lista: DependenciaDaPrevia[] = [];

    for (const req of pacote.requisitos.conexoes) {
      const aqui = local.conexoes.find((c) => c.id === req.id);
      const semToken = req.id === "github" && aqui?.tokenDoGithub === false;
      const ok = aqui?.estado === "connected" && !semToken;
      lista.push({
        tipo: "conexao",
        chave: req.id,
        nome: req.nome,
        estado: ok ? "ok" : aqui === undefined ? "ausente" : "falta-conectar",
        usadoPor: usos.conexoes.get(req.id) ?? [],
        atalho: ok ? null : "conexoes",
        candidatos: ok
          ? []
          : local.conexoes
              .filter((c) => c.id !== req.id && c.estado === "connected" && !INTERNOS.has(c.id))
              .map((c) => ({ valor: c.id, rotulo: c.nome })),
      });
    }

    for (const req of pacote.requisitos.servidores) {
      const aqui = local.servidores.find((s) => s.nome === req.nome);
      const parecidos = local.servidores
        .filter((s) => s.nome !== req.nome)
        .sort((a, b) => parecido(b, req) - parecido(a, req) || a.nome.localeCompare(b.nome));
      lista.push({
        tipo: "servidor",
        chave: req.nome,
        nome: req.nome,
        estado: aqui === undefined ? "ausente" : aqui.ligado ? "ok" : "falta-conectar",
        ...(req.pacote !== undefined || req.host !== undefined ? { detalhe: req.pacote ?? req.host } : {}),
        usadoPor: usos.servidores.get(req.nome) ?? [],
        atalho: aqui === undefined ? "importar-do-claude" : aqui.ligado ? null : "conexoes",
        candidatos: parecidos.map((s) => ({ valor: s.nome, rotulo: s.ligado ? s.nome : `${s.nome} (desligado)` })),
      });
    }

    for (const req of pacote.requisitos.provedores) {
      const aqui = local.provedores.find((p) => p.provedor === req.provedor);
      const disponivel = aqui?.disponivel === true;
      lista.push({
        tipo: "provedor",
        chave: req.provedor,
        nome: req.provedor,
        estado: disponivel ? "ok" : aqui === undefined ? "ausente" : "falta-conectar",
        detalhe: req.modelos.join(", "),
        usadoPor: usos.provedores.get(req.provedor) ?? [],
        atalho: disponivel ? null : "modelos",
        candidatos: disponivel ? [] : [...local.disponiveis].sort().map((m) => ({ valor: m, rotulo: m })),
      });
    }

    for (const req of pacote.requisitos.skills) {
      const aqui = local.skills.includes(req.nome);
      lista.push({
        tipo: "skill",
        chave: req.nome,
        nome: req.nome,
        estado: aqui ? "ok" : "ausente",
        usadoPor: usos.skills.get(req.nome) ?? [],
        atalho: null,
        candidatos: [],
      });
    }
    return lista;
  }

  /* --------------------------------------------------------------- importar */

  async importar(texto: string, escolhas: EscolhasDaImportacao = {}): Promise<ResultadoDaImportacao> {
    const pacote = lerPacote(texto);
    const declaracoes = await this.declaracoes();
    const previa = await this.previa(texto);
    const servidor = (nome: string): string => escolhas.servidores?.[nome] ?? nome;
    const conexao = (id: string): string => escolhas.conexoes?.[id] ?? (CATALOGO.has(id) ? id : servidor(id));
    const modelo = (chave: string, sugerido: string): string => escolhas.modelos?.[chave] ?? sugerido;

    // Toda decisão que falta aparece antes da primeira gravação.
    const destino = new Map<string, { id: string; acao: ResultadoDaImportacao["agents"][number]["acao"] }>();
    const ocupados = new Set<string>();
    const adiados: AgentNaPrevia[] = [];
    for (const agent of previa.agents) {
      const escolha = escolhas.agents?.[agent.id]?.acao;
      if (agent.situacao === "nome-igual" && escolha === undefined) {
        throw new DecisaoPendenteError(
          `já existe o agent "${agent.existente?.nome ?? agent.nome}" com o mesmo nome e outro id: escolha usar o que existe ou criar um novo`,
        );
      }
      if (agent.situacao === "novo") {
        if (escolha === "usar-existente") throw new DecisaoPendenteError(`o agent "${agent.nome}" não existe aqui para ser usado`);
        destino.set(agent.id, { id: agent.id, acao: "criado" });
      } else if (agent.situacao === "igual") {
        destino.set(agent.id, { id: agent.id, acao: "igual" });
      } else if (agent.situacao === "nome-igual") {
        if (escolha === "atualizar") throw new DecisaoPendenteError(`o agent "${agent.nome}" tem outro id aqui: só dá para usar o que existe ou criar um novo`);
        if (escolha === "usar-existente") destino.set(agent.id, { id: agent.existente!.id, acao: "existente" });
        else adiados.push(agent);
      } else {
        // Mesmo id com conteúdo diferente: o padrão é criar ao lado, e reescrever o dele só por escolha explícita.
        if (escolha === "atualizar") destino.set(agent.id, { id: agent.id, acao: "atualizado" });
        else if (escolha === "usar-existente") destino.set(agent.id, { id: agent.id, acao: "existente" });
        else adiados.push(agent);
      }
    }
    for (const { id } of destino.values()) ocupados.add(id);
    for (const agent of adiados) {
      let id = agent.idSugerido;
      for (let n = 2; ocupados.has(id) || (await this.library.getProfile(id)) !== null; n++) id = `${agent.idSugerido}-${n}`;
      ocupados.add(id);
      destino.set(agent.id, { id, acao: "criado" });
    }

    const automacaoId = escolhas.automacaoId ?? previa.automacao.idSugerido;
    if (!ID_DE_AGENT.test(automacaoId)) throw new Error("identificador em minúsculas, números e hífen, de 2 a 63 caracteres");
    if ((await this.agents.get(automacaoId)) !== undefined) throw new Error(`já existe uma automação "${automacaoId}"`);

    const pendencias: ResultadoDaImportacao["pendencias"] = pacote.omitidos
      .filter((o) => o.codigo !== "texto-limpo" && o.codigo !== "url-a-preencher")
      .map((o) => ({ codigo: o.codigo, onde: o.onde, ...(o.params === undefined ? {} : { params: o.params }) }));

    // Validação completa antes de gravar qualquer agent. A classe das
    // ferramentas é recalculada aqui: a do arquivo nunca vale.
    const specsDosAgents = new Map<string, AgentProfile>();
    for (const agent of pacote.agents) {
      const alvo = destino.get(agent.id)!;
      if (alvo.acao === "existente" || alvo.acao === "igual") continue;
      const todas = await this.reclassificar(agent.tools, servidor);
      const leituras = todas.filter((t) => t.class === "read");
      if (leituras.length < todas.length) pendencias.push({ codigo: "escrita-removida", onde: `agent:${alvo.id}` });
      let toolsets: string[] = [];
      let tools = leituras;
      if (alvo.acao === "atualizado") {
        // Atualizar o agent daqui não congela o toolset dele em ferramentas avulsas.
        const atual = (await this.library.getProfile(alvo.id))!.spec;
        toolsets = atual.toolsets;
        const doToolset = new Set<string>();
        for (const id of toolsets) for (const t of (await this.library.getToolset(id))?.tools ?? []) doToolset.add(chaveDaFerramenta(t));
        tools = leituras.filter((t) => !doToolset.has(chaveDaFerramenta(t)));
      }
      specsDosAgents.set(
        alvo.id,
        AgentProfile.parse({
          ...agent,
          id: alvo.id,
          model: modelo(`agent:${agent.id}`, agent.model),
          toolsets,
          tools,
          connections: agent.connections.map((c) => mapearConexao(c, conexao, servidor)),
        }),
      );
    }

    // Escrita avulsa (passo, automação) não entra: a execução a recusaria na primeira vez.
    const soLeitura = async (tools: readonly ToolRef[], onde: string): Promise<ToolRef[]> => {
      const todas = await this.reclassificar(tools, servidor);
      const leituras = todas.filter((t) => t.class === "read");
      if (leituras.length < todas.length) pendencias.push({ codigo: "escrita-removida", onde });
      return leituras;
    };
    const passos: Step[] = [];
    for (const p of pacote.automacao.spec.steps) {
      if (p.type === "model") {
        const { profile, ...resto } = p;
        passos.push({
          ...resto,
          model: modelo(`passo:${p.key}`, p.model),
          ...(p.tools === undefined ? {} : { tools: await soLeitura(p.tools, `passo:${p.key}`) }),
          requiresServers: p.requiresServers.map(servidor),
          ...(profile === undefined ? {} : { profile: destino.get(profile)!.id }),
        });
      } else if (p.type === "action") {
        const declaracao = declaracoes[p.action] ?? {};
        const { params: viajantes, origem, descartados } = paramsDoPacoteParaPasso(declaracao, p.params ?? {});
        if (Object.values(declaracao).includes("url")) pendencias.push({ codigo: "url-a-preencher", onde: p.key, ...(origem === undefined ? {} : { dica: origem }) });
        // O que o arquivo traz e a ação não deixa viajar (pacote mexido à mão) não entra, e fica dito.
        if (descartados.length > 0) pendencias.push({ codigo: "argumentos", onde: p.key, params: descartados });
        const params = { ...viajantes, ...(typeof viajantes.server === "string" ? { server: servidor(viajantes.server) } : {}) };
        // Ação em `auto` publicaria sem que ninguém tenha dito que pode: entra em aprovação.
        passos.push({ ...p, mode: p.mode === "auto" ? "approve" : p.mode, ...(p.params === undefined ? {} : { params }) });
      } else {
        passos.push(p);
      }
    }
    const spec = AgentSpec.parse({
      id: automacaoId,
      name: pacote.automacao.spec.name,
      defaultTools: await soLeitura(pacote.automacao.spec.defaultTools, "automacao"),
      skills: pacote.automacao.spec.skills,
      steps: passos,
      budget: pacote.automacao.spec.budget,
      ...(pacote.automacao.spec.layout === undefined ? {} : { layout: pacote.automacao.spec.layout }),
    });

    const gatilhos: { config: TriggerConfigInput; enabled: false }[] = [];
    for (const g of pacote.automacao.gatilhos) {
      const config = gatilhoParaCadastro(g, servidor);
      if (config === null) {
        pendencias.push({ codigo: "gatilho-sem-canal", onde: g.kind });
        continue;
      }
      TriggerConfig.parse(config);
      if (g.kind === "teams-inbox" && g.chatsRestritos !== undefined) {
        pendencias.push({ codigo: "chats-a-escolher", onde: g.kind });
      }
      gatilhos.push({ config, enabled: false });
    }

    // Gravação: agents primeiro, a automação por último, que é o que referencia.
    const resultado: ResultadoDaImportacao["agents"] = [];
    for (const agent of pacote.agents) {
      const alvo = destino.get(agent.id)!;
      const antes = await this.library.getProfile(alvo.id);
      const novoSpec = specsDosAgents.get(alvo.id);
      if (novoSpec === undefined) {
        resultado.push({ id: alvo.id, acao: alvo.acao === "igual" ? "igual" : "existente", versao: antes?.version ?? 0 });
        continue;
      }
      const salvo = await this.library.saveProfile({ spec: novoSpec, note: "importado de pacote", ...(antes === null ? { create: true } : {}) });
      resultado.push({ id: alvo.id, acao: antes === null ? "criado" : salvo.version === antes.version ? "igual" : "atualizado", versao: salvo.version });
    }
    await this.automations.save({ spec, triggers: gatilhos, note: "importada de pacote", create: true });

    return { automacaoId, agents: resultado, gatilhos: gatilhos.length, pendencias };
  }
}

/* ----------------------------------------------------------------- funções */

type GatilhoConfig = import("../config/types.js").TriggerConfig;

/** JSON com as chaves em ordem, para comparar dois valores sem depender de como foram montados. */
function canonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    return `{${Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonico(x)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

const LIMITE_DA_DIFERENCA = 1500;
const resumir = (texto: string): string => (texto.length > LIMITE_DA_DIFERENCA ? `${texto.slice(0, LIMITE_DA_DIFERENCA)}…` : texto);

/**
 * O que difere entre o agent daqui e o do pacote, nos campos que mudam o que
 * ele faz. Os dois já vêm na forma do pacote (toolset expandido), e a classe da
 * ferramenta fica de fora: ela é recalculada na importação.
 */
export function diferencasDoAgent(daqui: AgentDoPacote, pacote: AgentDoPacote): DiferencaDoAgent[] {
  const ferramentas = (a: AgentDoPacote): string =>
    [...new Set(a.tools.map((t) => `${t.server}/${t.tool}`))].sort().join("\n");
  const campos: [DiferencaDoAgent["campo"], (a: AgentDoPacote) => string][] = [
    ["description", (a) => a.description],
    ["context", (a) => a.context],
    ["instructions", (a) => a.instructions],
    ["model", (a) => a.model],
    ["temperature", (a) => (a.temperature === undefined ? "" : String(a.temperature))],
    ["tools", ferramentas],
    // Na lista explícita `false` e ausente são coisas diferentes (ausente é "nova"): o `false` do pacote para ferramenta que aqui não consta conta, porque aplicar grava a escolha. A linha de base é bookkeeping e fica de fora.
    ["connections", (a) => canonico(a.connections.map(({ linhaDeBase: _base, ...c }) => ({ ...c, tools: Object.fromEntries(Object.entries(c.tools).map(([k, v]) => [k, v === "read" ? true : v])) })))],
    ["skills", (a) => [...new Set(a.skills.map((k) => k.skill))].sort().join(", ")],
    ["budget", (a) => canonico(a.budget)],
    ["maxSteps", (a) => String(a.maxSteps)],
  ];
  return campos.flatMap(([campo, ler]) => {
    const a = ler(daqui);
    const b = ler(pacote);
    return a === b ? [] : [{ campo, daqui: resumir(a), pacote: resumir(b) }];
  });
}

function parecido(servidor: { nome: string; url?: string; command?: string[] }, req: { nome: string; pacote?: string; host?: string; conexao?: string }): number {
  let pontos = 0;
  const dono = conexaoDoServidor({ name: servidor.nome, ...(servidor.url === undefined ? {} : { url: servidor.url }), ...(servidor.command === undefined ? {} : { command: servidor.command }) });
  if (req.conexao !== undefined && dono?.id === req.conexao) pontos += 4;
  if (req.pacote !== undefined && pacoteDoComando(servidor.command) === req.pacote) pontos += 4;
  if (req.host !== undefined && hostDe(servidor.url) === req.host) pontos += 4;
  if (servidor.nome.toLowerCase().includes(req.nome.toLowerCase()) || req.nome.toLowerCase().includes(servidor.nome.toLowerCase())) pontos += 1;
  return pontos;
}

function mapearConexao(c: AgentConnection, conexao: (id: string) => string, servidor: (nome: string) => string): AgentConnection {
  const tools: AgentConnection["tools"] = {};
  for (const [chave, valor] of Object.entries(c.tools)) {
    const corte = chave.indexOf("/");
    // "read" é a pessoa declarando que a ferramenta só lê, e declaração de arquivo não vale: liga como qualquer outra.
    tools[corte > 0 ? `${servidor(chave.slice(0, corte))}${chave.slice(corte)}` : chave] = valor === "read" ? true : valor;
  }
  return { ...c, connectionId: conexao(c.connectionId), tools };
}

/** Quem usa cada dependência, para a prévia dizer "usado por" em cada uma. */
function usosDasDependencias(pacote: Pacote): {
  conexoes: Map<string, string[]>;
  servidores: Map<string, string[]>;
  provedores: Map<string, string[]>;
  skills: Map<string, string[]>;
} {
  const conexoes = new Map<string, string[]>();
  const servidores = new Map<string, string[]>();
  const provedores = new Map<string, string[]>();
  const skills = new Map<string, string[]>();
  const somar = (mapa: Map<string, string[]>, chave: string, quem: string): void => {
    const lista = mapa.get(chave) ?? [];
    if (!lista.includes(quem)) mapa.set(chave, [...lista, quem]);
  };
  const servidorDe = (nome: string, quem: string): void => {
    if (!INTERNOS.has(nome)) somar(servidores, nome, quem);
  };
  for (const passo of pacote.automacao.spec.steps) {
    const quem = `passo:${passo.key}`;
    if (passo.type === "model") {
      for (const t of passo.tools ?? []) servidorDe(t.server, quem);
      for (const s of passo.requiresServers) servidorDe(s, quem);
      if (passo.profile === undefined) somar(provedores, provedorDe(passo.model), quem);
    } else if (passo.type === "action") {
      const dona = CONEXAO_DA_ACAO[passo.action];
      if (dona !== undefined) somar(conexoes, dona, quem);
      if (passo.action === "mcp.call" && typeof passo.params?.server === "string") servidorDe(passo.params.server, quem);
    }
  }
  for (const t of pacote.automacao.spec.defaultTools) servidorDe(t.server, "automacao");
  for (const k of pacote.automacao.spec.skills) somar(skills, k.skill, "automacao");
  for (const g of pacote.automacao.gatilhos) {
    const quem = `gatilho:${g.kind}`;
    const dona = CONEXAO_DO_GATILHO[g.kind];
    if (dona !== undefined) somar(conexoes, dona, quem);
    if (g.kind === "mcp-poll") servidorDe(g.server, quem);
  }
  for (const agent of pacote.agents) {
    const quem = `agent:${agent.id}`;
    somar(provedores, provedorDe(agent.model), quem);
    for (const k of agent.skills) somar(skills, k.skill, quem);
    for (const t of agent.tools) servidorDe(t.server, quem);
    for (const c of agent.connections) {
      if (CATALOGO.has(c.connectionId)) somar(conexoes, c.connectionId, quem);
      else servidorDe(c.connectionId, quem);
      for (const chave of Object.keys(c.tools)) {
        const corte = chave.indexOf("/");
        if (corte > 0) servidorDe(chave.slice(0, corte), quem);
      }
    }
  }
  return { conexoes, servidores, provedores, skills };
}

/** O gatilho do pacote como o cadastro o pede, ou nulo quando falta o que só a pessoa escolhe. */
function gatilhoParaCadastro(g: GatilhoDoPacote, servidor: (nome: string) => string): TriggerConfigInput | null {
  // O que o arquivo não traz (marcado local) volta pelo padrão do esquema; sem o que é obrigatório, como o canal, o cadastro recusa.
  const { chatsRestritos, ...resto } = g as GatilhoDoPacote & { chatsRestritos?: number };
  const config: Record<string, unknown> = { ...resto, ...(chatsRestritos === undefined ? {} : { chatsPendentes: chatsRestritos }) };
  if (config.kind === "mcp-poll" && typeof config.server === "string") config.server = servidor(config.server);
  return TriggerConfig.safeParse(config).success ? (config as TriggerConfigInput) : null;
}

export const pacoteService = new PacoteService();
