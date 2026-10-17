import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ACOES_DE_CONVERSA_REGISTRO, destinoDoPasso } from "../acao/destino.js";
import type { ApprovalGate } from "../approval/gate.js";
import { PREFIXO_DO_PASSO_AVULSO, type PropostoPor } from "../config/types.js";
import { recusarSeArquivada } from "../db/arquivada.js";
import { db as defaultDb, schema } from "../db/index.js";
import { buildGate } from "../executor/build.js";
import { alvoDoEvento, aplicarCamposDoEvento, camposDoAlvo, destinoDoEvento, type EventPayload } from "../executor/executor.js";

type Db = typeof defaultDb;

/** Prefixo do erro de uma proposta que o handler recusou: a tela o traduz. */
export const PROPOSTA_RECUSADA = "proposta_recusada";

export type PropostaAvulsa = {
  kind: string;
  /** O que a ação aceita, no formato do `inputSchema` do handler. O alvo não entra: vem do evento do run. */
  conteudo: unknown;
  /** O passo do fluxo de que esta ação deriva. Reexecutá-lo expira a pendência. */
  derivaDe?: string;
  /** Quem propõe. Ausente, a pessoa: só a conversa do run diz o contrário. */
  propostoPor?: PropostoPor;
};

/**
 * Propõe uma ação nova sobre um run que já rodou (ADR 0007).
 *
 * O passo nasce `avulso`, sempre em `approve`, e o run não muda de estado:
 * quem decide a pendência não retoma nada além dela.
 */
export class PassoAvulsoService {
  constructor(
    private readonly db: Db = defaultDb,
    private readonly gate: ApprovalGate = buildGate(),
  ) {}

  /** As ações que se propõem à mão, com o esquema do conteúdo de cada uma: só as que declaram `inputSchema` e aceitam `approve`. */
  acoesAvulsas(): { kind: string; inputSchema: object }[] {
    return this.gate
      .describe()
      .flatMap((a) => (a.inputSchema !== undefined && this.gate.aceitaModo(a.kind, "approve") ? [{ kind: a.kind, inputSchema: a.inputSchema }] : []));
  }

  async proporAcao(runId: string, proposta: PropostaAvulsa): Promise<{ approvalId: string; stepKey: string }> {
    const { kind } = proposta;
    const esquema = this.gate.inputSchema(kind);
    if (esquema === undefined) throw new Error(`a acao "${kind}" nao e oferecida como avulsa: o handler nao declara inputSchema`);
    if (!this.gate.aceitaModo(kind, "approve")) throw new Error(`a acao "${kind}" nao aceita o modo approve, e o passo avulso so nasce em approve`);
    const conteudo = validarConteudo(kind, esquema, proposta.conteudo);

    const { evento } = this.conferir(this.db, runId);

    // O mesmo caminho do executor para passo de ação: o conteúdo vem da proposta,
    // e o alvo e os campos do evento valem por cima dele.
    const alvo = alvoDoEvento(evento);
    const doEvento = Object.fromEntries(this.gate.camposDoEvento(kind).map((campo) => [campo, (evento as Record<string, unknown>)[campo]]));
    // O alvo é garantido aqui, e não pelo esquema do handler: chave de alvo no conteúdo é recusada, mesmo que o esquema a aceite.
    const reservados = new Set([...camposDoAlvo(), ...this.gate.camposDoEvento(kind), ...(ACOES_DE_CONVERSA_REGISTRO[kind] === undefined ? [] : ["destino"])]);
    const invadidos = Object.keys(proposta.conteudo as object).filter((chave) => reservados.has(chave));
    if (invadidos.length > 0) throw new Error(`conteudo nao define o alvo da acao: ${invadidos.join(", ")} vem do evento do run`);
    const doConteudo = { ...conteudo, ...alvo, ...destinoDoEvento(alvo) };
    const payload = aplicarCamposDoEvento(
      ACOES_DE_CONVERSA_REGISTRO[kind] === undefined ? doConteudo : { ...doConteudo, destino: destinoDoPasso(kind, undefined) },
      doEvento,
    );

    const preparado = await this.gate.prepare(kind, payload, "approve");
    if (preparado.payload === null || preparado.payload === undefined) throw new Error(`${PROPOSTA_RECUSADA}:${kind}: a acao recusou a proposta, por exemplo review em pull request da propria pessoa`);

    return this.db.transaction(
      (tx) => {
        // As recusas valem de novo aqui: entre a leitura e a gravação o run pode ter voltado a rodar.
        this.conferir(tx, runId);
        const passos = tx
          .select({ chave: schema.steps.stepKey, idx: schema.steps.idx, origem: schema.steps.origem })
          .from(schema.steps)
          .where(eq(schema.steps.runId, runId))
          .all();
        if (proposta.derivaDe !== undefined && !passos.some((p) => p.chave === proposta.derivaDe && p.origem === "fluxo")) {
          throw new Error(`derivaDe "${proposta.derivaDe}" nao e um passo do fluxo deste run`);
        }
        const numeros = passos
          .map((p) => new RegExp(`^${PREFIXO_DO_PASSO_AVULSO}(\\d+)$`).exec(p.chave)?.[1])
          .filter((n): n is string => n !== undefined)
          .map(Number);
        const stepKey = `${PREFIXO_DO_PASSO_AVULSO}${Math.max(0, ...numeros) + 1}`;
        const stepId = randomUUID();
        tx.insert(schema.steps)
          .values({
            id: stepId,
            runId,
            idx: Math.max(-1, ...passos.map((p) => p.idx)) + 1,
            stepKey,
            name: kind,
            origem: "avulso",
            status: "awaiting_approval",
            input: { kind, conteudo, derivaDe: proposta.derivaDe ?? null, mode: "approve", propostoPor: proposta.propostoPor ?? "pessoa" },
            startedAt: Math.floor(Date.now() / 1000),
          })
          .run();
        const { id } = this.gate.enqueue(tx, { runId, stepId, kind, payload: preparado.payload, attempt: 0 }, preparado);
        return { approvalId: id, stepKey };
      },
      { behavior: "immediate" },
    );
  }

  /** As recusas, síncronas para valerem também dentro da transação. Devolve o evento do run. */
  private conferir(leitor: Pick<Db, "select">, runId: string): { evento: EventPayload } {
    const run = leitor
      .select({ status: schema.runs.status, eventId: schema.runs.eventId, agentId: schema.agentVersions.agentId })
      .from(schema.runs)
      .innerJoin(schema.agentVersions, eq(schema.runs.agentVersionId, schema.agentVersions.id))
      .where(eq(schema.runs.id, runId))
      .get();
    if (run === undefined) throw new Error(`run ${runId} nao encontrado`);
    recusarSeArquivada(leitor, run.agentId);
    const evento = run.eventId === null ? undefined : leitor.select().from(schema.events).where(eq(schema.events.id, run.eventId)).get();
    const payload = (evento?.payload ?? { repo: "", changedFiles: [] }) as EventPayload;
    if (payload.semConversa === true) throw new Error("run de ensaio (link colado) nao recebe acao: nada sai dele");
    if (run.status === "queued" || run.status === "running") {
      throw new Error(`run ${runId} ainda esta em andamento; espere terminar para propor uma acao`);
    }
    return { evento: payload };
  }
}

function validarConteudo(kind: string, esquema: object, conteudo: unknown): Record<string, unknown> {
  const lido = z.fromJSONSchema(esquema as never).safeParse(conteudo);
  if (!lido.success) throw new Error(`conteudo fora do esquema da acao "${kind}": ${z.prettifyError(lido.error)}`);
  if (lido.data === null || typeof lido.data !== "object" || Array.isArray(lido.data)) {
    throw new Error(`conteudo da acao "${kind}" precisa ser um objeto`);
  }
  return lido.data as Record<string, unknown>;
}

export const passoAvulsoService = new PassoAvulsoService();
