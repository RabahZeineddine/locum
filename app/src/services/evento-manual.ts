import { desc, eq, ne, and } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { fetchPr as defaultFetchPr, type PrContext } from "../sources/github.js";
import { ExecutionService, executionService, parseTarget } from "./execution-service.js";

type Db = typeof defaultDb;

/** Fonte dos eventos montados por quem clica, e não por um gatilho. */
export const FONTE_MANUAL = "manual";

/** Um evento que um gatilho da automação já gravou, como o diálogo "Executar com" mostra. */
export interface EventoRecente {
  id: string;
  source: string;
  author: string | null;
  trecho: string;
  /** Segundos desde a época. */
  at: number;
}

const LIMITE_DE_EVENTOS = 10;
const TAMANHO_DO_TRECHO = 140;

/**
 * Os eventos que o "Executar agora" oferece, e o evento que um link colado vira.
 *
 * O evento do link sai como o gatilho do Teams o deixa depois de enriquecer um
 * `prLinks`: o contexto do PR por cima dos campos `prOwner`, `prRepo` e
 * `prNumber`. Os campos da conversa ficam vazios e `semConversa` avisa o
 * executor, que faz de toda ação que publica para fora um ensaio. Não passa pelos
 * descartes do gatilho (rascunho, PR já revisado): quem cola o link pediu aquele PR.
 */
export class EventoManual {
  constructor(
    private readonly db: Db = defaultDb,
    private readonly fetchPr: (owner: string, repo: string, pull: number) => Promise<PrContext> = defaultFetchPr,
    private readonly executions: ExecutionService = executionService,
  ) {}

  async doLink(link: string, agentId: string): Promise<{ eventId: string }> {
    const alvo = ((): ReturnType<typeof parseTarget> | null => {
      try {
        return parseTarget(link);
      } catch {
        return null;
      }
    })();
    if (alvo === null || alvo.kind !== "github") {
      throw new Error("cole o link de um pull request do GitHub, como https://github.com/dono/repo/pull/123");
    }
    const contexto = await this.fetchPr(alvo.owner, alvo.repo, alvo.pull);
    const payload = {
      kind: "pr",
      chatId: null,
      messageId: null,
      text: "",
      prOwner: alvo.owner,
      prRepo: alvo.repo,
      prNumber: alvo.pull,
      ...contexto,
      teamsAuthor: null,
      semConversa: true,
      // Para qual automação o link foi colado: só ela pode rodar com este evento.
      automacao: agentId,
    };
    const { id } = await this.executions.recordEvent(
      FONTE_MANUAL,
      `link:${agentId}:${alvo.owner}/${alvo.repo}#${alvo.pull}:sha:${contexto.headSha}`.toLowerCase(),
      payload,
    );
    return { eventId: id };
  }

  async existe(eventId: string): Promise<boolean> {
    return (await this.db.select({ id: schema.events.id }).from(schema.events).where(eq(schema.events.id, eventId))).length > 0;
  }

  /**
   * Se o evento é desta automação: virou run dela (a mesma consulta de
   * `recentes`, que mostra o que o diálogo oferece) ou é um link colado para
   * ela. Qualquer outro evento tem dado de quem a automação nunca recebeu.
   */
  async daAutomacao(eventId: string, agentId: string): Promise<boolean> {
    const [colado] = await this.db
      .select({ source: schema.events.source, payload: schema.events.payload })
      .from(schema.events)
      .where(eq(schema.events.id, eventId));
    if (colado?.source === FONTE_MANUAL && (colado.payload as { automacao?: unknown } | null)?.automacao === agentId) return true;
    const runs = await this.db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .innerJoin(schema.agentVersions, eq(schema.runs.agentVersionId, schema.agentVersions.id))
      .where(and(eq(schema.agentVersions.agentId, agentId), eq(schema.runs.eventId, eventId)))
      .limit(1);
    return runs.length > 0;
  }

  /** Os últimos eventos que os gatilhos da automação gravaram e que chegaram a virar run, do mais novo ao mais antigo. */
  async recentes(agentId: string): Promise<EventoRecente[]> {
    const linhas = await this.db
      .select({ id: schema.events.id, source: schema.events.source, payload: schema.events.payload, receivedAt: schema.events.receivedAt })
      .from(schema.runs)
      .innerJoin(schema.agentVersions, eq(schema.runs.agentVersionId, schema.agentVersions.id))
      .innerJoin(schema.events, eq(schema.runs.eventId, schema.events.id))
      .where(and(eq(schema.agentVersions.agentId, agentId), ne(schema.events.source, FONTE_MANUAL)))
      .orderBy(desc(schema.runs.createdAt), desc(schema.runs.id))
      .limit(200);

    const vistos = new Set<string>();
    const saida: EventoRecente[] = [];
    for (const l of linhas) {
      if (vistos.has(l.id)) continue;
      vistos.add(l.id);
      saida.push({ id: l.id, source: l.source, author: autorDe(l.payload), trecho: trechoDe(l.payload), at: l.receivedAt });
      if (saida.length === LIMITE_DE_EVENTOS) break;
    }
    return saida;
  }
}

function campo(payload: unknown, nome: string): string | null {
  const v = (payload as Record<string, unknown> | null)?.[nome];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function autorDe(payload: unknown): string | null {
  return campo(payload, "teamsAuthor") ?? campo(payload, "author");
}

function trechoDe(payload: unknown): string {
  const texto = campo(payload, "text") ?? campo(payload, "title") ?? campo(payload, "repo") ?? "";
  const reto = texto.replace(/\s+/g, " ").trim();
  return reto.length > TAMANHO_DO_TRECHO ? `${reto.slice(0, TAMANHO_DO_TRECHO - 1)}…` : reto;
}

export const eventoManual = new EventoManual();
