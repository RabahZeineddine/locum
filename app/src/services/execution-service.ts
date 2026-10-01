import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { buildExecutor } from "../executor/build.js";
import { demoCleanPr, demoPr } from "../examples/demo-event.js";
import { fetchPr, type PrContext } from "../sources/github.js";
import { agentService, AgentService, isReserved, type AgentVersion } from "./agent-service.js";

type Db = typeof defaultDb;

export type RunStatus = "queued" | "done" | "paused" | "failed";

/** Alvo real do GitHub ou o evento sintetico, que nao precisa de credencial. */
export type RunTarget =
  | { kind: "github"; owner: string; repo: string; pull: number }
  | { kind: "synthetic"; variant?: "clean" };

export interface StartInput {
  /** Objeto ja resolvido ou o texto "owner/repo#123", "sintetico" ou "sintetico-limpo". */
  target: RunTarget | string;
  /** Ausente usa o agent semente, que e o unico cadastrado por padrao. */
  agentId?: string;
  /** Falso devolve assim que o run existe e deixa a execucao correndo atras. */
  wait?: boolean;
  /** Gatilho que pediu a execucao, quando nao foi gente que pediu. */
  triggerId?: string;
}

/** Disparo a partir de um evento que ja esta no banco, ou sem evento nenhum. */
export interface StartForEventInput {
  /** Nulo roda o agent sem evento, que e o caso do gatilho de relogio. */
  eventId: string | null;
  agentId?: string;
  triggerId?: string;
  wait?: boolean;
}

export interface StartedRun {
  runId: string;
  agentId: string;
  agentVersion: number;
  eventId: string;
  source: string;
  repo: string;
  pull: number;
  status: RunStatus;
}

/** O minimo do executor que este servico usa, para poder trocar em teste. */
export interface RunStarter {
  createRun(agentVersionId: string, eventId: string | null, triggerId?: string | null): Promise<string>;
  execute(runId: string): Promise<"done" | "paused" | "failed">;
}

const SINTETICO = new Set(["demo", "sintetico", "synthetic"]);
const SINTETICO_LIMPO = new Set(["demo-limpo", "sintetico-limpo", "synthetic-clean"]);

/**
 * Disparo de execucao a partir de um alvo.
 *
 * Linha de comando e servidor MCP passam por aqui porque a sequencia de ingerir
 * o evento, achar a versao do agent e criar o run tem uma armadilha no meio: o
 * evento e deduplicado pela origem, entao o mesmo pull request no mesmo commit
 * nao gera linha nova e o run precisa apontar para a que ja existe.
 *
 * Disparar execucao nao publica nada. O passo de acao continua parando na fila
 * de aprovacao, que segue fora do servidor MCP conforme o ADR 0002.
 */
export class ExecutionService {
  constructor(
    private readonly db: Db = defaultDb,
    private readonly agents: AgentService = agentService,
    private readonly makeRunner: () => Promise<RunStarter> = buildExecutor,
  ) {}

  async start(input: StartInput): Promise<StartedRun> {
    const target = typeof input.target === "string" ? parseTarget(input.target) : input.target;
    const version = await this.versionFor(input.agentId);

    const source = target.kind === "github" ? "github" : "demo";
    const context =
      target.kind === "github"
        ? await fetchPr(target.owner, target.repo, target.pull)
        : target.variant === "clean"
          ? demoCleanPr
          : demoPr;
    const { id: eventId } = await this.recordEvent(source, externalId(source, context), context);

    const { runId, status } = await this.startForEvent({ ...input, eventId, version });

    return {
      runId,
      agentId: version.agentId,
      agentVersion: version.version,
      eventId,
      source,
      repo: context.repo,
      pull: context.pull,
      status,
    };
  }

  /**
   * Cria e dispara o run de um evento que ja esta gravado.
   *
   * O agendador entra por aqui, e nao por `start`, porque o evento dele veio da
   * varredura que ja passou pela deduplicacao da fonte: refazer o caminho do
   * alvo iria buscar o pull request de novo so para reencontrar a mesma linha.
   */
  async startForEvent(
    input: StartForEventInput & { version?: AgentVersion },
  ): Promise<{ runId: string; status: RunStatus }> {
    const version = input.version ?? (await this.versionFor(input.agentId));
    const runner = await this.makeRunner();
    const runId = await runner.createRun(version.id, input.eventId, input.triggerId ?? null);

    if (input.wait === false) {
      // O executor grava o desfecho no banco mesmo quando falha, entao soltar a
      // promessa nao perde informacao: quem chamou acompanha pelo run. Um
      // cliente MCP nao pode ficar minutos preso esperando o pipeline acabar.
      void runner.execute(runId).catch(() => undefined);
      return { runId, status: "queued" };
    }

    return { runId, status: await runner.execute(runId) };
  }

  /**
   * A versão do agent pedido, ou do único que existe quando ninguém pediu.
   *
   * Não há agent de fábrica para cair por padrão: com mais de um cadastrado,
   * adivinhar qual rodaria gastaria modelo no agent errado.
   */
  private async versionFor(agentId?: string) {
    let id = agentId;
    if (id !== undefined && isReserved(id)) {
      throw new Error(`"${id}" e um agent do sistema e nao aceita escrita`);
    }
    if (id === undefined) {
      const todos = await this.agents.list();
      if (todos.length === 0) {
        throw new Error("nenhum agent cadastrado: importe um, por exemplo de examples/agents/");
      }
      if (todos.length > 1) {
        throw new Error(`diga qual agent roda: ${todos.map((a) => a.id).join(", ")}`);
      }
      id = todos[0]!.id;
    }
    const version = await this.agents.getLatestVersion(id);
    if (!version) throw new Error(`agent "${id}" não existe; importe antes de rodar`);
    return version;
  }

  /**
   * Grava o evento e devolve o identificador que vale, seja o novo ou o da
   * linha que ja estava la. Apontar o run para um identificador descartado pela
   * deduplicacao quebraria a chave estrangeira de `runs`.
   *
   * O `created` e o que separa evento novo de repetido, e e disso que o
   * agendador vive: resultado igual ao da varredura anterior nao vira run.
   */
  async recordEvent(
    source: string,
    external: string,
    payload: object,
  ): Promise<{ id: string; created: boolean }> {
    const [inserted] = await this.db
      .insert(schema.events)
      .values({ id: randomUUID(), source, externalId: external, payload })
      .onConflictDoNothing()
      .returning();
    if (inserted) return { id: inserted.id, created: true };

    const [existing] = await this.db
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(and(eq(schema.events.source, source), eq(schema.events.externalId, external)));
    if (!existing) throw new Error(`evento ${source}/${external} nao pode ser gravado`);
    return { id: existing.id, created: false };
  }
}

/**
 * Aceita "owner/repo#123", o link do pull request como o navegador mostra, e
 * os apelidos do evento sintetico. O link entra porque e o que a pessoa tem na
 * mao quando abre o Locum para revisar um PR.
 */
export function parseTarget(text: string): RunTarget {
  const trimmed = text.trim();
  if (SINTETICO.has(trimmed.toLowerCase())) return { kind: "synthetic" };
  if (SINTETICO_LIMPO.has(trimmed.toLowerCase())) return { kind: "synthetic", variant: "clean" };

  const link = trimmed.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/);
  if (link) return { kind: "github", owner: link[1]!, repo: link[2]!, pull: Number(link[3]) };

  const match = trimmed.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (!match) {
    throw new Error(`alvo invalido "${text}", use "owner/repo#123" ou "sintetico"`);
  }
  return { kind: "github", owner: match[1]!, repo: match[2]!, pull: Number(match[3]) };
}

/**
 * O commit entra na chave do evento real para que um push novo no mesmo pull
 * request valha como evento novo. O sintetico usa o relogio, porque ele existe
 * justamente para ser disparado de novo.
 */
function externalId(source: string, context: PrContext): string {
  return source === "github"
    ? `pr:${context.repo}#${context.pull}:sha:${context.headSha}`
    : `demo:${Date.now()}`;
}

export const executionService = new ExecutionService();
