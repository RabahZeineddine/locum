import { and, count, desc, eq, inArray, isNotNull, notInArray, or, sql } from "drizzle-orm";
import { AgentSpec, TriggerConfig, type TriggerConfigInput } from "../config/types.js";
import { randomUUID } from "node:crypto";
import { limparPendenciasPreenchidas, recusaDeLigar, recusaDeRodar } from "../config/pendencia.js";
import { recursoExiste } from "./pendencia-recursos.js";
import { manterRebaixados } from "../config/rebaixado.js";
import { db as defaultDb, schema } from "../db/index.js";
import { AutomacaoArquivada } from "../db/arquivada.js";
import { esquecerRuns } from "../db/estado-do-run.js";
import { esquecerGatilho } from "../triggers/estado-do-gatilho.js";
import { comTrava } from "../triggers/trava.js";
import type { EscopoActor } from "./initiative-service.js";
import { agentService, ID_DE_AGENT, mensagemDeVersao, isReserved, type AgentService, type AgentVersion } from "./agent-service.js";
import { dependenciaDeEvento, recusaSemEvento, type MotivoDeEvento } from "../executor/dependencia-de-evento.js";
import { eventoManual, FONTE_MANUAL, type EventoManual, type EventoRecente } from "./evento-manual.js";
import { executionService, type ExecutionService } from "./execution-service.js";
import { esperaChats, MOTIVO_CHATS, recusaDaGravacao, triggerService, type TriggerEntry, type TriggerService } from "./trigger-service.js";

type Db = typeof defaultDb;

/** O que impede arquivar: runs em curso ou aprovações paradas, com a contagem. A frase vem de quem mostra. */
export type BloqueioDeArquivar = { kind: "running" | "pending" | "publishing"; count: number };

/** O que arquivar leva e o que deixa. Mesma resposta para a prévia e para o arquivar. */
export interface PreviaDeArquivamento {
  agentId: string;
  /** Saem: os gatilhos e o estado preso a eles. */
  triggers: number;
  /** Ficam: o histórico do que a automação publicou. */
  runs: number;
  approvals: number;
  findings: number;
  versions: number;
  /** A iniciativa a que a automação está ligada; o vínculo fica. */
  initiative: { slug: string; title: string } | null;
  /** Vazio quando pode arquivar. */
  blockers: BloqueioDeArquivar[];
}

/** O que impede deletar: o que impede arquivar, mais a automação ainda estar em uso. */
export type BloqueioDeDeletar = { kind: BloqueioDeArquivar["kind"] | "active"; count: number };

/** O que deletar leva. Tudo sai; só o agent da biblioteca e as skills, que são compartilhados, ficam. */
export interface PreviaDeDelecao {
  agentId: string;
  archived: boolean;
  triggers: number;
  /** As pendências da fila e as já decididas: a aprovação é do run. */
  approvals: number;
  runs: number;
  findings: number;
  versions: number;
  /** A iniciativa a que a automação está ligada; o vínculo sai com ela. */
  initiative: { slug: string; title: string } | null;
  /** Vazio quando pode deletar. */
  blockers: BloqueioDeDeletar[];
}

/** Deletar recusado pelos bloqueios que existiam na hora de apagar. */
export class DeletarRecusado extends Error {
  constructor(readonly blockers: BloqueioDeDeletar[]) {
    super(`deletar recusado: ${blockers.map((b) => `${b.kind}=${b.count}`).join(", ")}`);
    this.name = "DeletarRecusado";
  }
}

class GatilhosMudaram extends Error {}

const mensagemDeIniciativa = (agentId: string, slug: string, verbo = "arquivar"): string =>
  `automação "${agentId}" está ligada à iniciativa "${slug}"; ${verbo} é decisão de uma pessoa, na tela do Locum`;

/** Arquivar recusado pelos bloqueios que existiam na hora de gravar. */
export class ArquivarRecusado extends Error {
  constructor(readonly blockers: BloqueioDeArquivar[]) {
    super(`arquivar recusado: ${blockers.map((b) => `${b.kind}=${b.count}`).join(", ")}`);
    this.name = "ArquivarRecusado";
  }
}

/** Um gatilho como o canvas manda: com `id` quando já existia. */
export interface AutomationTriggerInput {
  id?: string;
  /**
   * O id do gatilho que nasce agora, quando quem grava precisa dele antes (a
   * pendência de um gatilho de pacote aponta para ele). Vale só para gatilho novo.
   */
  idNovo?: string;
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
  /**
   * As pendências que a pessoa dispensa, por nome (`onde` e `campo`). Gravar mantém as
   * da versão anterior que não foram preenchidas nem dispensadas aqui: spec remontado
   * sem `pendentes` não apaga nada em silêncio.
   */
  dispensadas?: { onde: string; campo: string }[];
}

/** O que a gravação conseguiu, mas a pessoa precisa saber. */
export type AvisoDaAutomacao = { codigo: "evento-sem-gatilho"; motivo: MotivoDeEvento; gatilhos: string[] };

/** Gatilhos que acordam a automação sem evento: o relógio busca o próprio contexto. */
const GATILHOS_SEM_EVENTO = new Set(["schedule", "cron"]);

export interface Automation {
  version: AgentVersion;
  /** Quando o agent nasceu: um id reaproveitado depois de apagado tem outra data. */
  createdAt: number;
  /** Quando foi arquivada (segundos), ou nulo. */
  archivedAt: number | null;
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
    private readonly db: Db = defaultDb,
  ) {}

  async get(agentId: string): Promise<Automation | null> {
    if (isReserved(agentId)) return null;
    const version = await this.agents.getLatestVersion(agentId);
    const agent = await this.agents.get(agentId);
    if (version === undefined || agent === undefined) return null;
    return { version, createdAt: agent.createdAt, archivedAt: agent.archivedAt, triggers: await this.triggers.list(agentId) };
  }

  async save(input: AutomationSaveInput): Promise<Automation & { avisos: AvisoDaAutomacao[] }> {
    const agentId = input.spec.id;
    if (input.create !== true) await this.recusarSeArquivada(agentId);
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

    // O gatilho que passou a ter o campo preenchido tira a pendência dele; o que sobra trava o ligar.
    const identificados = triggers.map((g) => {
      const config = TriggerConfig.parse(g.config);
      const id = g.id ?? atuais.find((a) => JSON.stringify(a.config) === JSON.stringify(config))?.id ?? g.idNovo;
      return { id, config, ligar: g.enabled === true };
    });
    const ficam = new Set(identificados.flatMap((g) => (g.id === undefined ? [] : [g.id])));
    const removidos = new Set(atuais.filter((a) => !ficam.has(a.id) && (input.knownTriggerIds === undefined || input.knownTriggerIds.includes(a.id))).map((a) => a.id));
    const comPendencias = await this.mantendoPendencias(input, agentId);
    const spec = limparPendenciasPreenchidas(comPendencias, { gatilhos: identificados, removidos, existe: recursoExiste });
    if (identificados.some((g) => g.ligar)) {
      const recusa = recusaDeLigar(spec.pendentes, identificados.flatMap((g) => (g.ligar && g.id !== undefined ? [g.id] : [])));
      if (recusa !== null) throw new Error(recusa);
    }

    let version: AgentVersion;
    if (input.create === true) {
      if (!ID_DE_AGENT.test(agentId)) {
        throw new Error("identificador em minúsculas, números e hífen, de 2 a 63 caracteres");
      }
      const existente = await this.agents.get(agentId);
      if (existente !== undefined) {
        throw new Error(
          existente.archivedAt === null ? `já existe uma automação "${agentId}"` : `o id "${agentId}" é de uma automação arquivada; desarquive a automação ou escolha outro id`,
        );
      }
      const nota = input.note.trim() || "criada no canvas";
      version = await this.agents.upsert(spec, nota, "human");
    } else {
      // A versão esperada é conferida dentro da transação que grava a versão nova.
      version = await this.agents.saveEdited(agentId, spec, input.note, input.expectedVersion, { dispensadas: input.dispensadas ?? [], limpeza: { gatilhos: identificados, removidos } });
    }

    const mantidos = new Set<string>();
    for (const gatilho of triggers) {
      const salvo = await this.triggers.set(agentId, gatilho.config, {
        ...(gatilho.id === undefined ? {} : { id: gatilho.id }),
        ...(gatilho.id === undefined && gatilho.idNovo !== undefined ? { idNovo: gatilho.idNovo } : {}),
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

    const gravados = await this.triggers.list(agentId);
    return { version, createdAt: (await this.agents.get(agentId))!.createdAt, archivedAt: null, triggers: gravados, avisos: avisosDaGravacao(version.spec, gravados) };
  }

  /**
   * O spec com as pendências da versão anterior que a gravação não preencheu nem dispensou
   * por nome. Quem remonta o spec sem `pendentes` (a tela, o MCP) não as apaga por omissão.
   */
  private async mantendoPendencias(input: AutomationSaveInput, agentId: string): Promise<AgentSpec> {
    const ultima = input.create === true ? undefined : await this.agents.getLatestVersion(agentId);
    const anteriores = ultima?.spec.pendentes ?? [];
    const trazidas = input.spec.pendentes ?? [];
    const dispensadas = input.dispensadas ?? [];
    const chave = (p: { onde: string; campo: string }): string => `${p.onde}\u0000${p.campo}`;
    const conhecidas = new Set([...anteriores, ...trazidas].map(chave));
    for (const d of dispensadas) if (!conhecidas.has(chave(d))) throw new Error(`não há pendência "${d.onde}: ${d.campo}" para dispensar`);
    const dispensa = new Set(dispensadas.map(chave));
    const vistas = new Set<string>();
    const pendentes = [...trazidas, ...anteriores].filter((p) => {
      if (dispensa.has(chave(p)) || vistas.has(chave(p))) return false;
      vistas.add(chave(p));
      return true;
    });
    const { pendentes: _antes, ...resto } = input.spec;
    // O rebaixamento da importação também não some por omissão: só a pessoa pondo o passo em `auto`.
    return manterRebaixados(pendentes.length === 0 ? (resto as AgentSpec) : { ...resto, pendentes }, ultima?.spec.rebaixados ?? []);
  }

  /**
   * Liga ou desliga a automação inteira: todos os gatilhos dela.
   *
   * O agent continua podendo rodar pelo botão. O que o interruptor controla é
   * se ela acorda sozinha, que é a pergunta que a pessoa faz ao olhar a lista.
   */
  async setEnabled(agentId: string, enabled: boolean): Promise<TriggerEntry[]> {
    await this.recusarSeArquivada(agentId);
    const gatilhos = await this.triggers.list(agentId);
    // Confere antes de ligar o primeiro: um gatilho barrado no meio deixaria a automação meio ligada.
    if (enabled && gatilhos.some((g) => !g.enabled && esperaChats(g.config))) throw new Error(MOTIVO_CHATS);
    if (enabled) {
      const recusa = recusaDeLigar((await this.agents.getLatestVersion(agentId))?.spec.pendentes, gatilhos.map((g) => g.id));
      if (recusa !== null) throw new Error(recusa);
    }
    for (const gatilho of gatilhos) {
      if (gatilho.enabled !== enabled) await this.triggers.setEnabled(gatilho.id, enabled);
    }
    return this.triggers.list(agentId);
  }

  /**
   * O que o "Executar com" precisa para abrir: se a automação depende de
   * evento, e os últimos que os gatilhos dela já gravaram.
   */
  async eventsForRun(agentId: string): Promise<{ precisaDeEvento: MotivoDeEvento | null; recentes: EventoRecente[]; acoesAuto: string[] }> {
    const version = await this.agents.getLatestVersion(agentId);
    if (version === undefined) throw new Error(`agent "${agentId}" não existe`);
    // O evento recente roda de verdade: a ação em modo auto publica sem passar pela Fila.
    const acoesAuto = [...new Set(version.spec.steps.flatMap((p) => (p.type === "action" && p.mode === "auto" ? [p.action] : [])))];
    return { precisaDeEvento: dependenciaDeEvento(version.spec), recentes: await this.eventos.recentes(agentId), acoesAuto };
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
    await this.recusarSeArquivada(agentId);
    if (isReserved(agentId)) throw new Error(`"${agentId}" e um agent do sistema e nao aceita escrita`);
    if (evento.eventId !== undefined && evento.prUrl !== undefined) throw new Error("diga eventId ou prUrl, não os dois");

    let eventId: string | null = null;
    if (evento.eventId !== undefined) {
      if (!(await this.eventos.existe(evento.eventId))) throw new Error(`evento ${evento.eventId} nao encontrado`);
      if (!(await this.eventos.daAutomacao(evento.eventId, agentId))) {
        throw new Error(`o evento ${evento.eventId} não é um evento desta automação: escolha um dos recentes dela ou cole o link de um pull request`);
      }
      eventId = evento.eventId;
    } else if (evento.prUrl !== undefined) {
      eventId = (await this.eventos.doLink(evento.prUrl, agentId)).eventId;
    } else {
      const version = await this.agents.getLatestVersion(agentId);
      const motivo = version === undefined ? null : dependenciaDeEvento(version.spec);
      if (motivo !== null) throw new Error(recusaSemEvento(motivo));
    }
    // Sem link colado a execução é de verdade: nó incompleto recusa antes de abrir o run.
    if (evento.prUrl === undefined) {
      const recusa = recusaDeRodar((await this.agents.getLatestVersion(agentId))?.spec.pendentes);
      if (recusa !== null) throw new Error(recusa);
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
   * O que `archive` levaria e o que deixa, sem gravar nada. A tela mostra o
   * mesmo dado que a ferramenta MCP devolve.
   */
  async archivePreview(agentId: string): Promise<PreviaDeArquivamento> {
    await this.recusarSeNaoExiste(agentId);
    return this.inspecionar(this.db, agentId);
  }

  /**
   * Arquiva a automação: ela some das listas e do agendador, e os gatilhos
   * saem com o estado preso a eles. Runs, aprovações, achados e versões ficam,
   * porque são o que foi publicado em nome da pessoa e a dedupe de review
   * (`carregarRevisados`) lê as aprovações. O id continua ocupado.
   *
   * Pelo MCP (`actor` diferente de `human`), automação ligada a iniciativa é
   * recusada: sair do escopo dela é decisão de uma pessoa.
   */
  async archive(agentId: string, actor: EscopoActor = "human"): Promise<{ agentId: string; archived: true; triggers: number }> {
    await this.recusarSeNaoExiste(agentId);
    // Antes de qualquer escrita: com bloqueio ou iniciativa, nada é gravado, nem a limpeza das pendências.
    const previa = this.inspecionar(this.db, agentId);
    if (actor !== "human" && previa.initiative !== null) throw new Error(mensagemDeIniciativa(agentId, previa.initiative.slug));
    if (previa.blockers.length > 0) throw new ArquivarRecusado(previa.blockers);

    // A lista de gatilhos é relida depois das travas: um que nasceu enquanto esperava pede nova rodada.
    for (let tentativa = 0; ; tentativa++) {
      const ids = (await this.triggers.list(agentId)).map((g) => g.id);
      try {
        const triggers = await ids.reduceRight<() => Promise<number>>(
          (dentro, id) => () => comTrava(`gatilho:${id}`, dentro),
          async () => this.gravarArquivamento(agentId, actor, ids),
        )();
        return { agentId, archived: true, triggers };
      } catch (erro) {
        if (!(erro instanceof GatilhosMudaram) || tentativa >= 3) throw erro;
      }
    }
  }

  /** A transação do arquivar. Síncrona: confere, esquece o estado dos gatilhos, apaga os gatilhos e marca. */
  private gravarArquivamento(agentId: string, actor: EscopoActor, travados: string[]): number {
    return this.db.transaction(
      (tx) => {
        const agent = tx.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
        if (agent === undefined) throw new Error(`automacao "${agentId}" nao cadastrada`);
        if (agent.archivedAt !== null) throw new Error(`automacao "${agentId}" ja esta arquivada`);
        const previa = this.inspecionar(tx, agentId);
        if (actor !== "human" && previa.initiative !== null) throw new Error(mensagemDeIniciativa(agentId, previa.initiative.slug));
        if (previa.blockers.length > 0) throw new ArquivarRecusado(previa.blockers);

        const ids = tx.select({ id: schema.triggers.id }).from(schema.triggers).where(eq(schema.triggers.agentId, agentId)).all().map((g) => g.id);
        if (ids.length !== travados.length || ids.some((id) => !travados.includes(id))) throw new GatilhosMudaram();
        for (const id of ids) esquecerGatilho(tx, id);
        this.tirarPendenciasDeGatilho(tx, agentId);
        tx.delete(schema.triggers).where(eq(schema.triggers.agentId, agentId)).run();
        tx.update(schema.agents).set({ archivedAt: Math.floor(Date.now() / 1000), enabled: false }).where(eq(schema.agents.id, agentId)).run();
        return ids.length;
      },
      { behavior: "immediate" },
    );
  }

  /**
   * A pendência de um gatilho que vai sair não tem mais a quem apontar. Entra na transação do arquivar, como
   * versão nova (a versão é imutável), e só quando há uma pendência dessas; recusado o arquivar, nada fica.
   */
  private tirarPendenciasDeGatilho(tx: Pick<Db, "select" | "insert">, agentId: string): void {
    const ultima = tx.select().from(schema.agentVersions).where(eq(schema.agentVersions.agentId, agentId)).orderBy(desc(schema.agentVersions.version)).limit(1).get();
    if (ultima === undefined) return;
    const spec = AgentSpec.parse(ultima.spec);
    if (!(spec.pendentes ?? []).some((p) => p.onde.startsWith("gatilho:"))) return;
    const limpo = limparPendenciasPreenchidas(spec, { gatilhos: [], descartarOrfas: true, existe: recursoExiste });
    tx.insert(schema.agentVersions)
      .values({ id: randomUUID(), agentId, version: ultima.version + 1, spec: limpo as unknown as object, note: "arquivada: saem as pendências dos gatilhos removidos" })
      .run();
  }

  /** O que `delete` apagaria, sem gravar nada. A tela e a ferramenta MCP mostram o mesmo dado. */
  async deletePreview(agentId: string): Promise<PreviaDeDelecao> {
    await this.recusarSeNaoExiste(agentId);
    return this.inspecionarDelecao(this.db, agentId);
  }

  /**
   * Deleta a automação arquivada e tudo que pertence a ela: versões, gatilhos e o
   * estado de cada um, runs com passos, aprovações e achados, orçamento, gasto e
   * os eventos manuais dela. Uma transação só, que confere dentro dela que a
   * automação ainda está arquivada e sem run em curso. O agent da biblioteca e as
   * skills ficam: são compartilhados. Irreversível. Pelo MCP, automação ligada a
   * iniciativa é recusada, como no arquivar.
   */
  async delete(agentId: string, actor: EscopoActor = "human"): Promise<{ agentId: string; deleted: true; runs: number; versions: number }> {
    await this.recusarSeNaoExiste(agentId);
    return this.db.transaction(
      (tx) => {
        const agent = tx.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
        if (agent === undefined) throw new Error(`automacao "${agentId}" nao cadastrada`);
        const previa = this.inspecionarDelecao(tx, agentId);
        if (actor !== "human" && previa.initiative !== null) throw new Error(mensagemDeIniciativa(agentId, previa.initiative.slug, "deletar"));
        if (previa.blockers.length > 0) throw new DeletarRecusado(previa.blockers);

        const versoes = tx.select({ id: schema.agentVersions.id }).from(schema.agentVersions).where(eq(schema.agentVersions.agentId, agentId));
        const runs = tx.select({ id: schema.runs.id }).from(schema.runs).where(inArray(schema.runs.agentVersionId, versoes));
        const passos = tx.select({ id: schema.steps.id }).from(schema.steps).where(inArray(schema.steps.runId, runs));
        const achados = tx.select({ id: schema.findings.id }).from(schema.findings).where(inArray(schema.findings.runId, runs));

        // Gatilho que ainda existe, e o que só os runs lembram: o estado preso a ele sai junto.
        const gatilhos = new Set([
          ...tx.select({ id: schema.triggers.id }).from(schema.triggers).where(eq(schema.triggers.agentId, agentId)).all().map((g) => g.id),
          ...tx.selectDistinct({ id: schema.runs.triggerId }).from(schema.runs).where(and(inArray(schema.runs.agentVersionId, versoes), isNotNull(schema.runs.triggerId))).all().flatMap((g) => (g.id === null ? [] : [g.id])),
        ]);
        for (const id of gatilhos) esquecerGatilho(tx, id);
        esquecerRuns(tx, runs);

        // Evento colado à mão para esta automação; o de uma fonte externa é a dedupe da fonte e fica.
        const manuais = tx
          .select({ id: schema.events.id })
          .from(schema.events)
          .where(and(eq(schema.events.source, FONTE_MANUAL), sql`json_extract(${schema.events.payload}, '$.automacao') = ${agentId}`))
          .all()
          .map((e) => e.id);

        tx.delete(schema.findingOutcomes).where(inArray(schema.findingOutcomes.findingId, achados)).run();
        tx.delete(schema.approvals).where(or(inArray(schema.approvals.runId, runs), inArray(schema.approvals.stepId, passos))).run();
        tx.delete(schema.findings).where(inArray(schema.findings.runId, runs)).run();
        tx.delete(schema.steps).where(inArray(schema.steps.runId, runs)).run();
        tx.delete(schema.agentMetrics).where(inArray(schema.agentMetrics.agentVersionId, versoes)).run();
        tx.delete(schema.runs).where(inArray(schema.runs.agentVersionId, versoes)).run();
        if (manuais.length > 0) {
          // O run de outra automação que aponte para o evento o segura.
          const emUso = tx.select({ id: schema.runs.eventId }).from(schema.runs).where(inArray(schema.runs.eventId, manuais));
          tx.delete(schema.events).where(and(inArray(schema.events.id, manuais), notInArray(schema.events.id, emUso))).run();
        }
        tx.delete(schema.triggers).where(eq(schema.triggers.agentId, agentId)).run();
        tx.delete(schema.budgets).where(eq(schema.budgets.agentId, agentId)).run();
        tx.delete(schema.usageDaily).where(eq(schema.usageDaily.agentId, agentId)).run();
        tx.delete(schema.agentVersions).where(eq(schema.agentVersions.agentId, agentId)).run();
        tx.delete(schema.agents).where(eq(schema.agents.id, agentId)).run();
        return { agentId, deleted: true as const, runs: previa.runs, versions: previa.versions };
      },
      { behavior: "immediate" },
    );
  }

  /** Tira do arquivo: volta para a lista, sem gatilhos e desligada. A pessoa recria os gatilhos e liga. */
  async unarchive(agentId: string): Promise<{ agentId: string; archived: false }> {
    await this.recusarSeNaoExiste(agentId);
    const feito = await this.db
      .update(schema.agents)
      .set({ archivedAt: null, enabled: false })
      .where(and(eq(schema.agents.id, agentId), isNotNull(schema.agents.archivedAt)))
      .returning({ id: schema.agents.id });
    if (feito.length === 0) throw new Error(`automacao "${agentId}" nao esta arquivada`);
    return { agentId, archived: false };
  }

  private async recusarSeArquivada(agentId: string): Promise<void> {
    // Conferência de entrada, com a mensagem pronta; quem garante é a transação que grava (AgentService.write).
    if ((await this.agents.get(agentId))?.archivedAt != null) throw new AutomacaoArquivada(agentId);
  }

  private async recusarSeNaoExiste(agentId: string): Promise<void> {
    if ((await this.agents.get(agentId)) === undefined) throw new Error(`automacao "${agentId}" nao cadastrada`);
    if (isReserved(agentId)) throw new Error(`"${agentId}" e um agent do sistema e nao aceita escrita`);
  }

  /** A prévia da exclusão: as contagens de `inspecionar`, mais se está arquivada. Síncrona, para a transação do `delete`. */
  private inspecionarDelecao(leitor: Pick<Db, "select">, agentId: string): PreviaDeDelecao {
    const { runs, approvals, findings, versions, triggers, initiative, blockers } = this.inspecionar(leitor, agentId);
    const arquivada = leitor.select({ archivedAt: schema.agents.archivedAt }).from(schema.agents).where(eq(schema.agents.id, agentId)).get()?.archivedAt != null;
    const bloqueios: BloqueioDeDeletar[] = arquivada ? blockers : [{ kind: "active", count: 1 }, ...blockers];
    return { agentId, archived: arquivada, triggers, approvals, runs, findings, versions, initiative, blockers: bloqueios };
  }

  /** Contagens e bloqueios. Síncrona, para rodar dentro da transação do `archive` com o mesmo resultado da prévia. */
  private inspecionar(leitor: Pick<Db, "select">, agentId: string): PreviaDeArquivamento {
    const versoes = leitor.select({ id: schema.agentVersions.id }).from(schema.agentVersions).where(eq(schema.agentVersions.agentId, agentId));
    const runsIds = leitor.select({ id: schema.runs.id }).from(schema.runs).where(inArray(schema.runs.agentVersionId, versoes));
    const stepsIds = leitor.select({ id: schema.steps.id }).from(schema.steps).where(inArray(schema.steps.runId, runsIds));
    const contar = (n: { n: number } | undefined): number => n?.n ?? 0;

    const daAprovacao = or(inArray(schema.approvals.runId, runsIds), inArray(schema.approvals.stepId, stepsIds));
    const aprovacoes = (status?: string): number =>
      contar(leitor.select({ n: count() }).from(schema.approvals).where(and(status === undefined ? undefined : eq(schema.approvals.status, status), daAprovacao)).get());
    const emCurso = contar(
      leitor.select({ n: count() }).from(schema.runs).where(and(inArray(schema.runs.agentVersionId, versoes), inArray(schema.runs.status, ["queued", "running"]))).get(),
    );

    const blockers: BloqueioDeArquivar[] = [
      { kind: "running" as const, count: emCurso },
      { kind: "pending" as const, count: aprovacoes("pending") },
      { kind: "publishing" as const, count: aprovacoes("publishing") },
    ].filter((b) => b.count > 0);

    const agent = leitor.select({ initiativeId: schema.agents.initiativeId }).from(schema.agents).where(eq(schema.agents.id, agentId)).get();
    const iniciativa =
      agent?.initiativeId == null
        ? undefined
        : leitor.select({ slug: schema.initiatives.slug, title: schema.initiatives.title }).from(schema.initiatives).where(eq(schema.initiatives.id, agent.initiativeId)).get();
    return {
      agentId,
      triggers: contar(leitor.select({ n: count() }).from(schema.triggers).where(eq(schema.triggers.agentId, agentId)).get()),
      runs: contar(leitor.select({ n: count() }).from(schema.runs).where(inArray(schema.runs.agentVersionId, versoes)).get()),
      approvals: aprovacoes(),
      findings: contar(leitor.select({ n: count() }).from(schema.findings).where(inArray(schema.findings.runId, runsIds)).get()),
      versions: contar(leitor.select({ n: count() }).from(schema.agentVersions).where(eq(schema.agentVersions.agentId, agentId)).get()),
      initiative: iniciativa ?? null,
      blockers,
    };
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
 * O fluxo que usa o evento e tem gatilho de relógio: o run do relógio chega sem
 * evento, e o `{{event.*}}` sai vazio. Grava mesmo assim, e a pessoa decide.
 */
function avisosDaGravacao(spec: AgentSpec, gatilhos: TriggerEntry[]): AvisoDaAutomacao[] {
  const motivo = dependenciaDeEvento(spec);
  const semEvento = gatilhos.map((g) => g.config.kind).filter((k) => GATILHOS_SEM_EVENTO.has(k));
  return motivo === null || semEvento.length === 0 ? [] : [{ codigo: "evento-sem-gatilho", motivo, gatilhos: semEvento }];
}

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
