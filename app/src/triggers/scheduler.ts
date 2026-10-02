import { and, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { type Authorship, type TriggerConfig } from "../config/types.js";
import { executionService, type ExecutionService } from "../services/execution-service.js";
import { matchesAuthorship } from "../services/github-service.js";
import { mcpService, type McpService } from "../services/mcp-service.js";
import { pollMcpServer } from "../sources/mcp-poll.js";
import { pollSlack, slackWatchFor, type SlackPollOutcome } from "../sources/slack.js";
import { pollSlackInbox, type SlackInboxOutcome } from "../sources/slack-inbox.js";
import { pollTeamsInbox } from "../sources/teams-inbox.js";
import { slackService, type SlackService } from "../services/slack-service.js";
import { triggerService, type TriggerEntry, type TriggerService } from "../services/trigger-service.js";
// So tipo: o servico de reconciliacao puxa o octokit pelo topo do modulo, e
// quem carrega este agendador nem sempre quer isso junto. O valor entra por
// import dinamico la embaixo.
import type { SweepOptions, SweepReport } from "../services/reconcile-service.js";
import type { PullRequestScan } from "../sources/github.js";

type Db = typeof defaultDb;

/** Fonte do cursor de tempo. Uma linha por gatilho, guardando o ultimo disparo. */
const CURSOR_SOURCE = "scheduler";

/**
 * Eventos que não abriram run, um registro por gatilho, para a próxima batida
 * tentar de novo. O cursor da fonte já andou por eles, e sem esta lista o
 * evento que bateu no teto do dia nunca mais voltaria.
 */
const RETRY_SOURCE = "scheduler-retry";

/** Depois disto o evento sai da lista: falha que dura um dia não é passageira. */
const RETRY_TTL_MS = 24 * 60 * 60 * 1000;

type Pendente = { eventId: string; since: number };

/**
 * De onde veio a batida. `wake` e o que o M3 vai mandar quando o Mac acordar,
 * e esta aqui desde ja para que o registro de uma batida longa depois de sono
 * nao pareca atraso do agendador.
 */
export type WakeReason = "manual" | "timer" | "wake";

export type TriggerStatus = "fired" | "waiting" | "skipped" | "failed";

export interface TriggerOutcome {
  triggerId: string;
  agentId: string;
  kind: TriggerConfig["kind"];
  status: TriggerStatus;
  /** Motivo de nao ter disparado, ou o erro de quem tentou e nao conseguiu. */
  detail?: string;
  /** Eventos novos que a varredura trouxe nesta batida. */
  events: number;
  /** Runs criados nesta batida. Vazio quando nao havia evento novo. */
  runs: string[];
  /** Quando este gatilho quer ser acordado de novo, em epoch de milissegundos. */
  nextDueAt: number | null;
}

export interface TickResult {
  at: number;
  reason: WakeReason;
  outcomes: TriggerOutcome[];
  /** A batida mais proxima que algum gatilho pediu. Nulo quando nao ha nenhum. */
  nextDueAt: number | null;
  /** O que a conferencia de pull request fechado fez nesta batida. */
  reconciled: SweepSummary;
}

export interface TickOptions {
  /** Relogio da batida. Existe para teste, e para reproduzir uma batida antiga. */
  at?: number;
  reason?: WakeReason;
  /** Verdadeiro segura a batida ate o pipeline acabar. Padrao e soltar. */
  wait?: boolean;
}

/** A varredura do GitHub entra como dependencia para poder ser trocada em teste. */
export type PollFn = (
  owner: string,
  repoFilter: RegExp,
  options?: { includeDrafts?: boolean },
) => Promise<PullRequestScan>;

/** A conferencia de pull request fechado, trocavel pelo mesmo motivo. */
export type SweepFn = (options?: SweepOptions) => Promise<SweepReport>;

/** Quem responde de quem e o token do GitHub, para o filtro de autoria. */
export type ViewerFn = () => Promise<string | null>;

/**
 * O que a conferencia fez numa batida.
 *
 * Contagem, e nao os relatorios inteiros: quem le uma batida quer saber se
 * alguma execucao ganhou desfecho, e o detalhe de cada achado ja esta no banco.
 */
export interface SweepSummary {
  checked: number;
  settled: number;
  stillOpen: number;
  unreadable: number;
  failed: number;
  /** Erro da propria conferencia, quando ela nem chegou a olhar execucao. */
  detail?: string;
}

/**
 * O que um gatilho respondeu quando alguem perguntou pelo relogio, sem bater.
 *
 * Existe porque a interface mostra cadastro e agenda na mesma linha, e as duas
 * coisas moram em lugares diferentes: a configuracao esta na tabela de
 * gatilhos, e a ultima batida no cursor deste agendador.
 */
export interface TriggerSchedule {
  triggerId: string;
  agentId: string;
  kind: TriggerConfig["kind"];
  enabled: boolean;
  /**
   * O cadastro inteiro, e nao so o tipo.
   *
   * Quem mostra agenda mostra do lado o que esta sendo observado, e separar as
   * duas metades em duas leituras obrigaria a tela a juntar por identificador
   * o que ja sai junto daqui.
   */
  config: TriggerConfig;
  /** Cadencia desejada. Nulo e gatilho que nao anda pelo relogio. */
  everyMinutes: number | null;
  /** Ultima batida deste gatilho, em epoch de milissegundos. */
  lastFireAt: number | null;
  /**
   * Quando o agendador vai acordar este gatilho.
   *
   * Nulo quando ninguem vai: gatilho desabilitado nao entra na batida, e
   * webhook espera chamada e nao relogio. Dizer uma data para esses dois seria
   * prometer na tela uma batida que nunca vem.
   */
  nextDueAt: number | null;
}

/**
 * A varredura de verdade entra por import dinamico, e nao pelo topo do modulo.
 *
 * Este agendador e carregado pela ponte na subida da janela, so para responder
 * quando foi a ultima batida de cada gatilho. O `octokit` que o source importa
 * viria junto nessa carona, e ele nao tem o que fazer ate alguem habilitar um
 * gatilho de varredura.
 */
const varrerNoGithub: PollFn = async (owner, repoFilter, options) => {
  const { scanOpenPullRequests } = await import("../sources/github.js");
  return scanOpenPullRequests(owner, repoFilter, options);
};

/** Pelo mesmo motivo do `varrerNoGithub`: o octokit so entra quando bate. */
const conferirFechados: SweepFn = async (options) => {
  const { reconcileService } = await import("../services/reconcile-service.js");
  return reconcileService.sweep(options);
};

/**
 * A conta do token, lida da conferência que já está guardada.
 *
 * Não fala com o GitHub: quem falou foi a tela de configuração quando alguém
 * guardou o token, e o login ficou gravado ali. Uma batida de varredura não
 * precisa perguntar de novo quem é o dono da conta.
 */
const contaConferida: ViewerFn = async () => {
  const { githubService } = await import("../services/github-service.js");
  return githubService.viewerLogin();
};

/**
 * Quem acorda os gatilhos habilitados.
 *
 * Anda por cursor de tempo, um por gatilho, e nao por janela fixa. A diferenca
 * aparece quando o Mac dorme: um `setInterval` de quinze minutos perde a janela
 * inteira e so volta a contar do zero ao acordar, enquanto o cursor guarda o
 * ultimo disparo e a primeira batida depois do sono ja encontra o gatilho
 * vencido. Por isso esta classe nao tem relogio proprio: ela e batida de fora,
 * pela linha de comando hoje e pelos eventos de energia do M3 depois, e devolve
 * em `nextDueAt` quando quer a proxima batida para quem a chama armar um
 * temporizador so.
 *
 * Disparar gatilho nao publica nada: o passo de acao continua parando na fila
 * de aprovacao, que segue fora de qualquer caminho automatico conforme o ADR
 * 0002.
 */
export class Scheduler {
  constructor(
    private readonly db: Db = defaultDb,
    private readonly triggers: TriggerService = triggerService,
    private readonly executions: ExecutionService = executionService,
    private readonly mcp: McpService = mcpService,
    private readonly slack: SlackService = slackService,
    private readonly poll: PollFn = varrerNoGithub,
    private readonly sweep: SweepFn = conferirFechados,
    private readonly viewer: ViewerFn = contaConferida,
    private readonly slackInbox: typeof pollSlackInbox = pollSlackInbox,
    private readonly teamsInbox: typeof pollTeamsInbox = pollTeamsInbox,
  ) {}

  /** Batida vinda do evento de acordar da maquina, que o M3 vai ligar. */
  async onWake(): Promise<TickResult> {
    return this.tick({ reason: "wake" });
  }

  async tick(options: TickOptions = {}): Promise<TickResult> {
    const at = options.at ?? Date.now();
    const reason = options.reason ?? "manual";
    const outcomes: TriggerOutcome[] = [];

    for (const trigger of await this.triggers.enabled()) {
      outcomes.push(await this.runTrigger(trigger, at, options.wait ?? false));
    }

    // Depois dos gatilhos, e fora do laco deles: a conferencia nao pertence a
    // gatilho nenhum. Ela olha execucao que ja existe, e roda mesmo numa
    // maquina onde ninguem habilitou nada.
    const reconciled = await this.reconcile(at);

    const due = outcomes.map((o) => o.nextDueAt).filter((v): v is number => v !== null);
    return {
      at,
      reason,
      outcomes,
      nextDueAt: due.length > 0 ? Math.min(...due) : null,
      reconciled,
    };
  }

  /**
   * A conferencia da batida, com o erro dela parando aqui.
   *
   * GitHub fora do ar nao pode derrubar a batida inteira: os gatilhos ja
   * dispararam quando isto roda, e deixar a excecao subir faria o chamador
   * achar que a batida nao aconteceu.
   */
  private async reconcile(at: number): Promise<SweepSummary> {
    const vazio: SweepSummary = {
      checked: 0,
      settled: 0,
      stillOpen: 0,
      unreadable: 0,
      failed: 0,
    };

    try {
      const report = await this.sweep({ at });
      return {
        checked: report.checked,
        settled: report.settled.length,
        stillOpen: report.stillOpen,
        unreadable: report.unreadable,
        failed: report.failed.length,
      };
    } catch (err) {
      return { ...vazio, detail: message(err) };
    }
  }

  /**
   * O que o agendador enxerga de cada gatilho cadastrado, sem bater em nenhum.
   *
   * Vem daqui e nao do `TriggerService` porque metade da resposta e o cursor,
   * que e estado desta classe: o cadastro sabe a cadencia desejada, e so o
   * agendador sabe quando o gatilho disparou pela ultima vez.
   *
   * Entra tambem o que esta desabilitado, que e o estado em que todo gatilho
   * nasce: quem acabou de cadastrar precisa ver a linha na tela para poder
   * habilita-la.
   */
  async schedule(at: number = Date.now()): Promise<TriggerSchedule[]> {
    const schedules: TriggerSchedule[] = [];

    for (const trigger of await this.triggers.list()) {
      const cadence = cadenceMs(trigger.config);
      const last = await this.lastFire(trigger.id);
      schedules.push({
        triggerId: trigger.id,
        agentId: trigger.agentId,
        kind: trigger.config.kind,
        enabled: trigger.enabled,
        config: trigger.config,
        everyMinutes: cadence === null ? null : cadence / 60_000,
        lastFireAt: last,
        // Gatilho que nunca disparou esta vencido, e a batida dele e a proxima
        // que acontecer. Nao e o mesmo que "daqui a uma cadencia": esperar um
        // ciclo inteiro depois de habilitar faria a primeira varredura demorar
        // sem que ninguem tivesse pedido isso.
        nextDueAt:
          !trigger.enabled || cadence === null ? null : last === null ? at : last + cadence,
      });
    }

    return schedules;
  }

  /**
   * Quando o agendador quer ser acordado, sem disparar nada agora.
   *
   * O relogio entra por parametro pelo mesmo motivo do `schedule`: gatilho que
   * nunca disparou esta vencido agora, e duas chamadas com dois `Date.now()`
   * respondem numeros diferentes para a mesma pergunta.
   */
  async nextDueAt(at: number = Date.now()): Promise<number | null> {
    const times = (await this.schedule(at))
      .map((s) => s.nextDueAt)
      .filter((v): v is number => v !== null);
    return times.length > 0 ? Math.min(...times) : null;
  }

  private async runTrigger(
    trigger: TriggerEntry,
    at: number,
    wait: boolean,
  ): Promise<TriggerOutcome> {
    const base = {
      triggerId: trigger.id,
      agentId: trigger.agentId,
      kind: trigger.config.kind,
      events: 0,
      runs: [] as string[],
    };

    const cadence = cadenceMs(trigger.config);
    if (cadence === null) {
      return {
        ...base,
        status: "skipped",
        detail: "gatilho de webhook nao depende do relogio, quem dispara e a chamada",
        nextDueAt: null,
      };
    }

    const { raw, last } = await this.readFire(trigger.id);
    if (last !== null && at < last + cadence) {
      return { ...base, status: "waiting", nextDueAt: last + cadence };
    }

    // A batida toma o gatilho antes de disparar, numa escrita condicional ao
    // valor que leu. O app serializa as próprias batidas, mas `locum tick` no
    // terminal bate no mesmo banco: as duas veriam o gatilho vencido e cada
    // uma abriria os seus runs. Quem perde a escrita espera a próxima janela.
    //
    // O cursor anda mesmo quando o disparo falha: o que protege evento de se
    // perder é o cursor da própria fonte, que não andou. Sem isso, um gatilho
    // quebrado tomaria todas as batidas seguintes tentando de novo e abafaria
    // os outros.
    if (!(await this.claim(trigger.id, raw, at))) {
      const depois = await this.lastFire(trigger.id);
      return { ...base, status: "waiting", nextDueAt: depois === null ? at + cadence : depois + cadence };
    }

    const nextDueAt = at + cadence;
    try {
      const fired = await this.fire(trigger, at, wait);
      return { ...base, ...fired, status: "fired", nextDueAt };
    } catch (err) {
      return { ...base, status: "failed", detail: message(err), nextDueAt };
    }
  }

  private async fire(
    trigger: TriggerEntry,
    at: number,
    wait: boolean,
  ): Promise<{ events: number; runs: string[]; detail?: string }> {
    const config = trigger.config;

    switch (config.kind) {
      case "schedule": {
        // Gatilho de relogio nao tem evento: o agent que roda por cadencia
        // busca o proprio contexto pelas ferramentas do passo.
        const { runId } = await this.executions.startForEvent({
          eventId: null,
          agentId: trigger.agentId,
          triggerId: trigger.id,
          wait,
        });
        return { events: 0, runs: [runId] };
      }

      case "poll": {
        if (config.source !== "github") {
          throw new Error(`fonte "${config.source}" nao tem varredura cadastrada`);
        }
        // O cadastro vem antes do ambiente, pela mesma razao do token: quem
        // escolheu o dono na tela espera que a varredura visite aquele, e nao
        // um `GITHUB_OWNER` esquecido no shell de onde o app subiu.
        const owner = config.owner ?? process.env.GITHUB_OWNER;
        if (!owner) {
          throw new Error("gatilho sem dono e sem GITHUB_OWNER, a varredura precisa da org");
        }

        const varredura = await this.poll(owner, new RegExp(config.repoMatch), {
          includeDrafts: config.includeDrafts,
        });
        // A varredura devolve a janela inteira, e o que este gatilho já rodou
        // sai antes do filtro de autoria, senão o mesmo descarte seria contado
        // de novo a cada batida em que o pull request continua na janela.
        const pendentes = await this.notYetRan(trigger.id, varredura.eventIds);
        const { eventIds, detail } = await this.byAuthorship(config.authorship, pendentes);
        const runs = await this.runsFor(trigger, eventIds, at, wait);
        const created = varredura.created;
        // A contagem de eventos continua sendo o que a varredura trouxe, e não
        // o que sobrou do filtro: quem lê a batida precisa ver que o pull
        // request chegou e foi descartado aqui, senão a única leitura possível
        // seria a de que a varredura não achou nada.
        return { events: created.length, runs, detail };
      }

      case "mcp-poll": {
        // Um gatilho apontado para o servidor que alguem cadastrou como o
        // Slack desta maquina nao esta pedindo varredura opaca: esta pedindo as
        // mensagens dos canais observados, um cursor por canal. O `tool` do
        // cadastro continua sendo o do gatilho, e a lista de canais e do
        // cadastro do Slack, porque ela muda sem que o gatilho mude.
        const watch = await slackWatchFor(config.server, { slack: this.slack });
        if (watch !== null) {
          const varredura = await pollSlack(
            { ...watch, tool: config.tool },
            { db: this.db, mcp: this.mcp },
          );
          // A janela inteira, pelo mesmo motivo da varredura genérica logo
          // abaixo: o canal do Slack e a caixa de menções dividem a chave da
          // mensagem, e o primeiro a bater não pode ficar com ela sozinho.
          const runs = await this.runsFor(trigger, varredura.inWindow, at, wait);
          return { events: varredura.eventIds.length, runs, detail: slackDetail(varredura) };
        }

        // A varredura mora na fonte, e nao aqui, pelo mesmo motivo da do
        // GitHub: cursor, normalizacao e deduplicacao sao a mesma decisao para
        // as tres formas de fonte do ADR 0001, e so o agendador sabe quando
        // bater.
        const { eventIds, inWindow, seen } = await pollMcpServer(
          { server: config.server, tool: config.tool, args: config.args },
          { db: this.db, mcp: this.mcp },
        );
        // A janela inteira, e não só o que entrou agora: o cursor é da
        // consulta, e não do gatilho, então dois gatilhos sobre a mesma
        // ferramenta dividem os eventos. `runsFor` deduplica pelo gatilho.
        const runs = await this.runsFor(trigger, inWindow, at, wait);
        // O que ja era conhecido aparece na diferenca, e nao some: sem isso a
        // unica leitura possivel de uma batida sem evento novo seria a de que a
        // consulta voltou vazia, que e outra coisa.
        const repetidos = seen - eventIds.length;
        return {
          events: eventIds.length,
          runs,
          detail: repetidos === 0 ? undefined : `${repetidos} item(ns) ja conhecido(s)`,
        };
      }

      case "slack-inbox": {
        const caixa = await this.slackInbox(config, { db: this.db });
        const runs = await this.runsFor(trigger, caixa.inWindow, at, wait);
        return { events: caixa.eventIds.length, runs, detail: slackInboxDetail(caixa) };
      }

      case "teams-inbox": {
        const caixa = await this.teamsInbox(config, { db: this.db });
        const runs = await this.runsFor(trigger, caixa.inWindow, at, wait);
        return { events: caixa.eventIds.length, runs, detail: slackInboxDetail(caixa) };
      }

      default:
        // `runTrigger` ja devolveu o webhook antes de chegar aqui. Se um tipo
        // novo entrar no zod e nao passar por este switch, e melhor estourar do
        // que acordar o agent de um jeito que ninguem desenhou.
        throw new Error(`gatilho do tipo "${(config as TriggerConfig).kind}" nao tem disparo`);
    }
  }

  /**
   * Só os eventos cuja autoria este gatilho quer acordar.
   *
   * Mora no agendador e não na varredura porque o evento é de todo mundo: dois
   * gatilhos apontados para a mesma organização, um para os pull requests de
   * quem usa o Locum e outro para os do time, leem a mesma tabela. Filtrar na
   * ingestão faria o primeiro a varrer decidir o que o segundo enxerga.
   *
   * A conta do token é lida uma vez por batida, e não por evento, porque ela
   * não muda no meio de uma varredura.
   */
  private async byAuthorship(
    wanted: Authorship,
    eventIds: string[],
  ): Promise<{ eventIds: string[]; detail?: string }> {
    if (wanted === "any" || eventIds.length === 0) return { eventIds };

    const viewer = await this.viewer();
    if (viewer === null) {
      // Recusar a batida inteira, e não deixar passar: o gatilho de `mine`
      // rodaria em cima de pull request do time e o de `others` no seu, que é
      // o contrário do que a pessoa cadastrou. O erro sobe para o `detail` do
      // gatilho, onde a tela mostra o que fazer.
      throw new Error(
        "gatilho filtra por autoria e a conta do GitHub nunca foi conferida, confira o token na configuração",
      );
    }

    const escolhidos: string[] = [];
    let descartados = 0;
    for (const eventId of eventIds) {
      if (matchesAuthorship(wanted, await this.authorOf(eventId), viewer)) {
        escolhidos.push(eventId);
      } else {
        descartados += 1;
      }
    }

    return {
      eventIds: escolhidos,
      detail:
        descartados === 0
          ? undefined
          : `${descartados} evento(s) fora do filtro de autoria "${wanted}"`,
    };
  }

  /** Quem abriu o pull request, do jeito que a varredura gravou no evento. */
  private async authorOf(eventId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ payload: schema.events.payload })
      .from(schema.events)
      .where(eq(schema.events.id, eventId))
      .limit(1);

    const author = (row?.payload as { author?: unknown } | undefined)?.author;
    return typeof author === "string" ? author : undefined;
  }

  /**
   * Um run por evento que este gatilho ainda nao rodou.
   *
   * A varredura ja deduplica por chave externa, mas a checagem contra `runs`
   * cobre o caso em que a batida anterior gravou o evento e morreu antes de
   * criar o run: o evento nao e novo, e ainda assim ninguem o processou.
   */
  private async runsFor(
    trigger: TriggerEntry,
    eventIds: string[],
    at: number,
    wait: boolean,
  ): Promise<string[]> {
    const runs: string[] = [];
    const falhas: string[] = [];
    // O prazo do retry conta no relógio da batida, como a cadência. Com
    // `Date.now()` aqui, quem passa `at` veria a cadência andar e o prazo
    // parado.
    const agora = at;
    const antes = new Map((await this.readRetry(trigger.id)).map((p) => [p.eventId, p.since]));
    const pendentes: Pendente[] = [];
    // Um evento que não abre run não segura os outros. O cursor da fonte já
    // andou quando chega aqui, e parar no primeiro erro deixaria o resto da
    // janela sem run e fora da próxima varredura. O que falhou fica anotado
    // e volta na batida seguinte, junto com a janela nova.
    for (const eventId of new Set([...antes.keys(), ...eventIds])) {
      if (await this.alreadyRan(trigger.id, eventId)) continue;
      try {
        const { runId } = await this.executions.startForEvent({
          eventId,
          agentId: trigger.agentId,
          triggerId: trigger.id,
          wait,
        });
        runs.push(runId);
      } catch (err) {
        falhas.push(message(err));
        const since = antes.get(eventId) ?? agora;
        if (agora - since < RETRY_TTL_MS) pendentes.push({ eventId, since });
      }
    }
    if (antes.size > 0 || pendentes.length > 0) await this.writeRetry(trigger.id, pendentes);
    if (falhas.length > 0) {
      const abertos = runs.length === 0 ? "" : `, ${runs.length} run(s) aberto(s)`;
      throw new Error(`${falhas.length} evento(s) sem run${abertos}: ${falhas[0]}`);
    }
    return runs;
  }

  private async notYetRan(triggerId: string, eventIds: string[]): Promise<string[]> {
    const pendentes: string[] = [];
    for (const eventId of eventIds) {
      if (!(await this.alreadyRan(triggerId, eventId))) pendentes.push(eventId);
    }
    return pendentes;
  }

  private async alreadyRan(triggerId: string, eventId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(and(eq(schema.runs.triggerId, triggerId), eq(schema.runs.eventId, eventId)))
      .limit(1);
    return row !== undefined;
  }

  private async lastFire(triggerId: string): Promise<number | null> {
    return (await this.readFire(triggerId)).last;
  }

  private async readRetry(triggerId: string): Promise<Pendente[]> {
    const [row] = await this.db
      .select({ value: schema.cursors.value })
      .from(schema.cursors)
      .where(and(eq(schema.cursors.source, RETRY_SOURCE), eq(schema.cursors.key, triggerId)));
    if (!row) return [];
    try {
      const lista = JSON.parse(row.value) as unknown;
      return Array.isArray(lista)
        ? lista.filter((p): p is Pendente => typeof p?.eventId === "string" && typeof p?.since === "number")
        : [];
    } catch {
      return [];
    }
  }

  private async writeRetry(triggerId: string, pendentes: Pendente[]): Promise<void> {
    if (pendentes.length === 0) {
      await this.db
        .delete(schema.cursors)
        .where(and(eq(schema.cursors.source, RETRY_SOURCE), eq(schema.cursors.key, triggerId)));
      return;
    }
    const value = JSON.stringify(pendentes);
    await this.db
      .insert(schema.cursors)
      .values({ source: RETRY_SOURCE, key: triggerId, value })
      .onConflictDoUpdate({
        target: [schema.cursors.source, schema.cursors.key],
        set: { value, updatedAt: Math.floor(Date.now() / 1000) },
      });
  }

  /** O valor gravado, para a escrita condicional, e o instante que ele diz. */
  private async readFire(triggerId: string): Promise<{ raw: string | null; last: number | null }> {
    const [row] = await this.db
      .select({ value: schema.cursors.value })
      .from(schema.cursors)
      .where(and(eq(schema.cursors.source, CURSOR_SOURCE), eq(schema.cursors.key, triggerId)));
    if (!row) return { raw: null, last: null };

    const parsed = Date.parse(row.value);
    return { raw: row.value, last: Number.isNaN(parsed) ? null : parsed };
  }

  /** Grava o disparo só se o cursor ainda é o que esta batida leu. */
  private async claim(triggerId: string, raw: string | null, at: number): Promise<boolean> {
    const value = new Date(at).toISOString();
    if (raw === null) {
      const inserted = await this.db
        .insert(schema.cursors)
        .values({ source: CURSOR_SOURCE, key: triggerId, value })
        .onConflictDoNothing()
        .returning({ key: schema.cursors.key });
      return inserted.length > 0;
    }
    const updated = await this.db
      .update(schema.cursors)
      .set({ value, updatedAt: Math.floor(at / 1000) })
      .where(
        and(
          eq(schema.cursors.source, CURSOR_SOURCE),
          eq(schema.cursors.key, triggerId),
          eq(schema.cursors.value, raw),
        ),
      )
      .returning({ key: schema.cursors.key });
    return updated.length > 0;
  }
}

/**
 * O que uma batida do Slack tem a dizer alem da contagem de eventos.
 *
 * Mensagem ja conhecida e canal que falhou aparecem juntos porque as duas
 * respondem a mesma pergunta de quem le uma batida sem evento novo: a consulta
 * voltou vazia, ela so trouxe o que ja estava gravado, ou ninguem chegou a
 * perguntar.
 */
function slackDetail(varredura: SlackPollOutcome): string | undefined {
  const partes: string[] = [];
  const repetidos = varredura.seen - varredura.eventIds.length;
  if (repetidos > 0) partes.push(`${repetidos} mensagem(ns) ja conhecida(s)`);

  for (const canal of varredura.byChannel) {
    if (canal.error !== undefined) partes.push(`${canal.channel}: ${canal.error}`);
  }

  return partes.length === 0 ? undefined : partes.join("; ");
}

/** O mesmo que `slackDetail`, para a caixa de mencoes e mensagens diretas do Slack e do Teams. */
function slackInboxDetail(caixa: Pick<SlackInboxOutcome, "eventIds" | "seen"> & { errors: { kind: string; error: string }[] }): string | undefined {
  const partes: string[] = [];
  const repetidos = caixa.seen - caixa.eventIds.length;
  if (repetidos > 0) partes.push(`${repetidos} mensagem(ns) ja conhecida(s)`);
  for (const falha of caixa.errors) partes.push(`${falha.kind}: ${falha.error}`);
  return partes.length === 0 ? undefined : partes.join("; ");
}

/** Cadencia em milissegundos. Nulo e gatilho que nao anda pelo relogio. */
function cadenceMs(config: TriggerConfig): number | null {
  return config.kind === "webhook" ? null : config.everyMinutes * 60_000;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const scheduler = new Scheduler();
