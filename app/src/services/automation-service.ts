import { TriggerConfig, type AgentSpec, type TriggerConfigInput } from "../config/types.js";
import { agentService, ID_DE_AGENT, mensagemDeVersao, isReserved, type AgentService, type AgentVersion } from "./agent-service.js";
import { dependenciaDeEvento, recusaSemEvento } from "../executor/dependencia-de-evento.js";
import { eventoManual, type EventoManual, type EventoRecente } from "./evento-manual.js";
import { executionService, type ExecutionService } from "./execution-service.js";
import { esperaChats, MOTIVO_CHATS, recusaDaGravacao, triggerService, type TriggerEntry, type TriggerService } from "./trigger-service.js";

/** Um gatilho como o canvas manda: com `id` quando já existia. */
export interface AutomationTriggerInput {
  id?: string;
  config: TriggerConfigInput;
  /** Ausente mantém o que estava, e gatilho novo nasce desligado. */
  enabled?: boolean;
  /**
   * O gatilho de pacote que esperava a escolha de chats passa a valer para
   * todos. Sem este aviso explícito, zerar a pendência com a lista vazia é recusado.
   */
  valerParaTodosOsChats?: boolean;
}

export interface AutomationSaveInput {
  spec: AgentSpec;
  triggers: AutomationTriggerInput[];
  /** O que mudou. Vira a nota da versão, como no editor em lista. */
  note: string;
  /** Verdadeiro para automação nova: recusa se o id já existir. */
  create?: boolean;
  /**
   * A versão gravada sobre a qual a edição começou. O canvas manda; o MCP e os
   * outros chamadores não precisam. Com ela, gravar sobre uma versão mais nova
   * é recusado em vez de passar por cima do que entrou no meio.
   */
  expectedVersion?: number;
  /**
   * Os gatilhos que quem grava tinha na mão. Com a lista, só esses podem ser
   * removidos por terem ficado de fora: um gatilho criado por fora depois que o
   * editor abriu fica. Sem ela, a lista de `triggers` é a lista inteira.
   */
  knownTriggerIds?: string[];
}

export interface Automation {
  version: AgentVersion;
  /** Quando o agent nasceu: um id reaproveitado depois de apagado tem outra data. */
  createdAt: number;
  triggers: TriggerEntry[];
}

/**
 * A automação: um agent e os gatilhos dele, editados juntos pelo canvas.
 *
 * Não tem tabela própria de propósito. O agent já é um grafo de passos e o
 * gatilho já aponta para ele; uma tabela de automação seria uma segunda
 * resposta para "o que roda quando chega mensagem no canal X". Este serviço
 * só junta as duas gravações na ordem que não deixa nada pela metade: valida
 * os gatilhos antes de gravar o spec, e só depois mexe na tabela de gatilhos.
 *
 * Gravar não liga nada. Gatilho novo nasce desligado, como em qualquer outro
 * caminho, e ligar é um clique de pessoa no interruptor da automação.
 */
export class AutomationService {
  constructor(
    private readonly agents: AgentService = agentService,
    private readonly triggers: TriggerService = triggerService,
    private readonly executions: ExecutionService = executionService,
    private readonly eventos: EventoManual = eventoManual,
  ) {}

  async get(agentId: string): Promise<Automation | null> {
    if (isReserved(agentId)) return null;
    const version = await this.agents.getLatestVersion(agentId);
    const agent = await this.agents.get(agentId);
    if (version === undefined || agent === undefined) return null;
    return { version, createdAt: agent.createdAt, triggers: await this.triggers.list(agentId) };
  }

  async save(input: AutomationSaveInput): Promise<Automation> {
    const agentId = input.spec.id;
    // Primeiro, para a recusa por versão valer sobre as dos gatilhos (um gatilho que sumiu junto com a versão
    // nova é efeito dela). A conferência que vale é a de dentro da transação que grava, em `saveEdited`.
    if (input.expectedVersion !== undefined && input.create !== true) {
      const gravada = (await this.agents.getLatestVersion(agentId))?.version;
      if (gravada !== undefined && gravada !== input.expectedVersion) throw new Error(mensagemDeVersao(input.expectedVersion, gravada));
    }
    // Antes de qualquer escrita: um gatilho inválido não pode deixar para
    // trás um spec novo gravado com os gatilhos antigos.
    for (const gatilho of input.triggers) TriggerConfig.parse(gatilho.config);
    const atuais = await this.triggers.list(agentId);
    const triggers = herdarPendenciaDeChats(atuais, input.triggers);
    // Também antes de gravar: tudo o que a gravação dos gatilhos vai recusar
    // (ligar um que espera chats, zerar a pendência sem o aviso) recusa a
    // gravação inteira, e não deixa o spec novo para trás.
    for (const gatilho of triggers) {
      const parsed = TriggerConfig.parse(gatilho.config);
      const existente =
        gatilho.id === undefined
          ? atuais.find((a) => JSON.stringify(a.config) === JSON.stringify(parsed))
          : atuais.find((a) => a.id === gatilho.id);
      if (gatilho.id !== undefined && existente === undefined) throw new Error(`gatilho ${gatilho.id} nao cadastrado`);
      const recusa = recusaDaGravacao(existente, parsed, {
        ...(gatilho.enabled === undefined ? {} : { enabled: gatilho.enabled }),
        ...(gatilho.valerParaTodosOsChats === true ? { valerParaTodosOsChats: true } : {}),
      });
      if (recusa !== null) throw new Error(recusa);
    }

    let version: AgentVersion;
    if (input.create === true) {
      if (!ID_DE_AGENT.test(agentId)) {
        throw new Error("identificador em minúsculas, números e hífen, de 2 a 63 caracteres");
      }
      if ((await this.agents.get(agentId)) !== undefined) throw new Error(`já existe uma automação "${agentId}"`);
      const nota = input.note.trim() || "criada no canvas";
      version = await this.agents.upsert(input.spec, nota, "human");
    } else {
      // A versão esperada é conferida dentro da transação que grava a versão nova.
      version = await this.agents.saveEdited(agentId, input.spec, input.note, input.expectedVersion);
    }

    const mantidos = new Set<string>();
    for (const gatilho of triggers) {
      const salvo = await this.triggers.set(agentId, gatilho.config, {
        ...(gatilho.id === undefined ? {} : { id: gatilho.id }),
        ...(gatilho.enabled === undefined ? {} : { enabled: gatilho.enabled }),
        ...(gatilho.valerParaTodosOsChats === true ? { valerParaTodosOsChats: true } : {}),
      });
      mantidos.add(salvo.id);
    }
    for (const antigo of atuais) {
      if (mantidos.has(antigo.id)) continue;
      if (input.knownTriggerIds !== undefined && !input.knownTriggerIds.includes(antigo.id)) continue;
      await this.triggers.remove(antigo.id);
    }

    return { version, createdAt: (await this.agents.get(agentId))!.createdAt, triggers: await this.triggers.list(agentId) };
  }

  /**
   * Liga ou desliga a automação inteira: todos os gatilhos dela.
   *
   * O agent continua podendo rodar pelo botão. O que o interruptor controla é
   * se ela acorda sozinha, que é a pergunta que a pessoa faz ao olhar a lista.
   */
  async setEnabled(agentId: string, enabled: boolean): Promise<TriggerEntry[]> {
    const gatilhos = await this.triggers.list(agentId);
    // Confere antes de ligar o primeiro: um gatilho barrado no meio deixaria a automação meio ligada.
    if (enabled && gatilhos.some((g) => !g.enabled && esperaChats(g.config))) throw new Error(MOTIVO_CHATS);
    for (const gatilho of gatilhos) {
      if (gatilho.enabled !== enabled) await this.triggers.setEnabled(gatilho.id, enabled);
    }
    return this.triggers.list(agentId);
  }

  /**
   * O que o "Executar com" precisa para abrir: se a automação depende de
   * evento, e os últimos que os gatilhos dela já gravaram.
   */
  async eventsForRun(agentId: string): Promise<{ precisaDeEvento: string | null; recentes: EventoRecente[] }> {
    const version = await this.agents.getLatestVersion(agentId);
    if (version === undefined) throw new Error(`agent "${agentId}" não existe`);
    return { precisaDeEvento: dependenciaDeEvento(version.spec), recentes: await this.eventos.recentes(agentId) };
  }

  /**
   * "Executar agora". Sem evento, como o gatilho de relógio, e aponta o run
   * para o gatilho manual quando a automação tem um, para a lista de
   * execuções dizer de onde ele veio.
   *
   * A automação que depende de evento (`{{event.*}}` ou ação de conversa) pede
   * um: `eventId` de um evento recente, ou `prUrl` com o link de um PR, que
   * vira o evento como o gatilho do Teams o montaria. Sem nenhum dos dois
   * recusa aqui, antes de abrir o run e de gastar o primeiro passo de modelo.
   */
  async runNow(
    agentId: string,
    evento: { eventId?: string; prUrl?: string } = {},
  ): Promise<{ runId: string; eventId: string | null; aviso?: { provedor: string; ate: number } }> {
    if (isReserved(agentId)) throw new Error(`"${agentId}" e um agent do sistema e nao aceita escrita`);
    if (evento.eventId !== undefined && evento.prUrl !== undefined) throw new Error("diga eventId ou prUrl, não os dois");

    let eventId: string | null = null;
    if (evento.eventId !== undefined) {
      if (!(await this.eventos.existe(evento.eventId))) throw new Error(`evento ${evento.eventId} nao encontrado`);
      eventId = evento.eventId;
    } else if (evento.prUrl !== undefined) {
      eventId = (await this.eventos.doLink(evento.prUrl)).eventId;
    } else {
      const version = await this.agents.getLatestVersion(agentId);
      const motivo = version === undefined ? null : dependenciaDeEvento(version.spec);
      if (motivo !== null) throw new Error(recusaSemEvento(motivo));
    }

    const manual = (await this.triggers.list(agentId)).find((g) => g.config.kind === "manual");
    const { runId } = await this.executions.startForEvent({
      eventId,
      agentId,
      ...(manual === undefined ? {} : { triggerId: manual.id }),
      wait: false,
    });
    // Manual sempre roda. Com o provedor no limite, só avisa: pode falhar ou gastar o que resta.
    const bloqueio = await (await import("./limites-padrao.js")).pausaPadrao(agentId).catch(() => null);
    return bloqueio === null ? { runId, eventId } : { runId, eventId, aviso: { provedor: bloqueio.provedor, ate: bloqueio.ate } };
  }

  /**
   * Um identificador livre a partir do nome, para a automação nova não pedir
   * que a pessoa invente um slug.
   */
  async suggestId(nome: string): Promise<string> {
    const base =
      nome
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50) || "automacao";
    const raiz = base.length < 2 ? `${base}-automacao` : base;
    for (let n = 1; n < 1000; n++) {
      const id = n === 1 ? raiz : `${raiz}-${n}`;
      // `legacy` é a rota das automações do modelo antigo (`automations/legacy`).
      if (id !== "legacy" && !isReserved(id) && (await this.agents.get(id)) === undefined) return id;
    }
    throw new Error("não achei identificador livre para esse nome");
  }
}

export const automationService = new AutomationService();

/**
 * A pendência de chats vale pela automação, e não pelo id do gatilho. Um
 * gatilho do Teams que o pacote deixou esperando chats e some da lista (ou é
 * trocado por outro, sem id) passa a pendência ao gatilho novo que escuta todos
 * os chats; sem isso, salvar sem id seria o caminho para ligar o que a pessoa
 * ainda não escolheu. O aviso explícito de valer para todos desfaz a herança.
 */
function herdarPendenciaDeChats(atuais: TriggerEntry[], novos: AutomationSaveInput["triggers"]): AutomationSaveInput["triggers"] {
  const mantidos = new Set(novos.flatMap((g) => (g.id === undefined ? [] : [g.id])));
  const perdidas = atuais.filter((g) => !mantidos.has(g.id) && esperaChats(g.config));
  const pendentes = Math.max(0, ...perdidas.map((g) => (g.config.kind === "teams-inbox" ? g.config.chatsPendentes : 0)));
  if (pendentes === 0) return novos;
  return novos.map((g) => {
    if (g.id !== undefined || g.valerParaTodosOsChats === true) return g;
    const config = TriggerConfig.parse(g.config);
    if (config.kind !== "teams-inbox" || config.chats.length > 0 || config.chatsPendentes > 0) return g;
    return { ...g, config: { ...config, chatsPendentes: pendentes } as TriggerConfigInput };
  });
}
