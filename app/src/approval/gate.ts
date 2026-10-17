import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { EsquemaJson } from "../config/referencias.js";
import type { ActionMode } from "../config/types.js";
import type { ParamsDoPacote } from "../pacote/params.js";

/**
 * Quanto tempo em `publishing` faz a pendência contar como parada. Publicar
 * leva segundos; passado isso, quem publicava caiu e a pendência espera alguém.
 */
export const STUCK_AFTER_SECONDS = 300;

/**
 * O `db` de fora de transacao, ou o `tx` de uma transacao sincrona em
 * andamento (como a de `InitiativeService.proposeContextUpdate`). `enqueue`
 * so usa `insert`, presente nos dois.
 */
type Db = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Publicar bateu num estado que a proposta não previa: o arquivo mudou por
 * fora entre propor e decidir. Não é bug do agent nem do handler, então a
 * gate fecha a pendência como `conflict` em vez de deixar o erro subir como
 * falha comum.
 */
export class PublishConflict extends Error {
  /**
   * Código do motivo, gravado no passo e na pendência para a tela traduzir
   * (`publish_conflict:<causa>:<parâmetros>`). Sem ele, vale `publish_conflict`.
   */
  constructor(message: string, readonly motivo?: string) {
    super(message);
  }
}

/** Motivo de conflito quando o handler não deu um código. */
export const MOTIVO_DE_CONFLITO = "publish_conflict";

/** A saída de uma ação que não devolve resposta: só o estado em que a publicação ficou. */
export const SAIDA_PADRAO_DA_ACAO: EsquemaJson = {
  type: "object",
  properties: { state: { type: "string", enum: ["pending", "drafted", "published"], description: "Where the publication stands." } },
  required: ["state"],
};

export type ActionRequest = {
  runId: string;
  stepId: string;
  kind: string;
  payload: unknown;
  /** O `target` do passo, quando ele declarou um. */
  target?: string | null;
  /**
   * A tentativa do passo (`steps.attempt`). Reexecutar o passo mantém o id e
   * soma uma tentativa: sem ela no `externalId`, a marca da publicação antiga
   * faria a nova parecer já publicada. Ausente vale 0.
   */
  attempt?: number;
};

export type ActionHandler = {
  /**
   * Os modos que esta acao aceita. Ausente vale pelos tres.
   *
   * Existe para a acao que nao pode nascer em outro modo, e a trava ser de
   * codigo e nao de configuracao: quem escreve o agent escolhe o modo, e um
   * campo de spec nao e lugar de decidir se uma tarefa pode ser aberta sem
   * ninguem ver.
   */
  modes?: readonly ActionMode[];
  /**
   * O formato da saída do passo desta ação (JSON Schema), para a tela e o MCP
   * oferecerem `{{steps.x.campo}}`. Ausente vale `SAIDA_PADRAO_DA_ACAO`: a ação
   * que não devolve resposta guarda só `{ state }`.
   */
  outputSchema?: EsquemaJson;
  /**
   * O que o conteúdo da ação aceita (JSON Schema), para propor um passo avulso:
   * a tela monta o formulário e o MCP valida por ele. Só o conteúdo, nunca o
   * alvo (dono, repositório, pull, conversa), que vem do evento do run.
   * Ausente, a ação não é oferecida como avulsa.
   */
  inputSchema?: EsquemaJson;
  /**
   * O que da pendência desta ação se pode editar antes do clique (JSON Schema de
   * objeto): só os campos listados em `properties`, cada um validado pelo esquema
   * dele. O resto do payload (alvo, conversa, commit) é o que o executor gravou e
   * nunca muda por edição. Ausente, a pendência não se edita.
   */
  camposEditaveis?: EsquemaJson;
  /**
   * Campos do payload que só o evento do run pode dizer: o executor os põe por
   * cima da saída do modelo, e ausentes no evento ficam ausentes. A review do
   * GitHub declara `headSha`: o commit avaliado não é escolha do modelo.
   */
  camposDoEvento?: readonly string[];
  /**
   * Como cada param do passo desta ação viaja no pacote (`.locum.json`): portátil,
   * texto limpo, destino, url ou local. Param que a ação não declara não viaja, e
   * vira pendência na importação. Todo handler declara, mesmo vazio: um teste cobra.
   */
  paramsDoPacote?: ParamsDoPacote;
  /**
   * Monta o que vai para a fila a partir da saida do passo.
   *
   * O que este metodo devolve e o que fica gravado na pendencia, e e o que
   * `publish` vai receber depois do clique. Handler que nao implementa manda a
   * saida do passo como ela veio.
   */
  propose?(payload: unknown, target: string | null): Promise<unknown>;
  /**
   * Diz se esta proposta em particular precisa do clique, qualquer que seja o
   * modo do passo. Verdadeiro transforma `auto` em `approve`.
   *
   * Complementa `modes`, que trava a ação inteira: aqui a trava depende do que
   * vai sair, como a review que aprova um pull request, que não pode sair
   * sozinha mesmo quando o comentário da mesma ação pode.
   */
  holdForApproval?(payload: unknown): boolean;
  /**
   * Publica de verdade. Recebe o externalId ja gravado, para ser idempotente.
   * Pode devolver `{ output }`, a resposta que vira a saida do passo; sem ela a
   * saida e `{ state }`.
   */
  publish(payload: unknown, externalId: string): Promise<void | { output: unknown }>;
  /** Prepara sem publicar. No GitHub, review em estado pendente. */
  draft?(payload: unknown, externalId: string): Promise<void>;
  /**
   * A proposta não vai sair: rejeitada na fila, em conflito, ou recusada pelo
   * `propose`. Para o handler desfazer o que anunciou ao pegar o trabalho.
   * Falha aqui é engolida: a decisão já foi tomada.
   */
  discard?(payload: unknown): Promise<void>;
};

/**
 * Porta unica de saida. Nada que escreve fora passa por outro lugar.
 *
 * `approve` e o padrao. `auto` existe, mas nasce desligado e escopado, e a UI
 * so deve oferece-lo quando as metricas sustentarem. Ha acao que nao aceita os
 * tres, e quem diz isso e o handler, em `modes`: entregar digest nunca e
 * automatico, e uma regra dessas nao pode depender de o modo certo estar
 * escrito na spec.
 */
export class ApprovalGate {
  constructor(private handlers: Map<string, ActionHandler>) {}

  /**
   * Os modos que cada ação aceita, perguntados ao próprio handler.
   *
   * A tela de edição precisa saber que criar tarefa só aceita aprovação. Copiar
   * essa regra para a janela seria a segunda fonte da verdade, e as duas
   * divergem na primeira ação nova. A gate continua recusando o modo errado na
   * hora de publicar, com ou sem a tela ter avisado.
   */
  /**
   * A ação responde com algo que a gate não conhece (declara `outputSchema`
   * próprio): dada por publicada à mão, a pendência não tem essa resposta.
   */
  semResposta(kind: string): boolean {
    return this.handlers.get(kind)?.outputSchema !== undefined;
  }

  /** Os campos que o handler da ação declarou como do evento (ver `ActionHandler.camposDoEvento`). */
  camposDoEvento(kind: string): readonly string[] {
    return this.handlers.get(kind)?.camposDoEvento ?? [];
  }

  /** Se a ação tem handler, e o esquema do conteúdo que ela aceita como avulsa, quando declarou. */
  existe(kind: string): boolean {
    return this.handlers.has(kind);
  }

  inputSchema(kind: string): EsquemaJson | undefined {
    return this.handlers.get(kind)?.inputSchema;
  }

  /** O esquema dos campos que a pendência desta ação aceita editar, quando ela os declara. */
  camposEditaveis(kind: string): EsquemaJson | undefined {
    return this.handlers.get(kind)?.camposEditaveis;
  }

  /** O modo é aceito pela ação (ver `ActionHandler.modes`). */
  aceitaModo(kind: string, mode: ActionMode): boolean {
    const modes = this.handlers.get(kind)?.modes;
    return modes === undefined || modes.includes(mode);
  }

  describe(): { kind: string; modes: readonly ActionMode[]; holdsByContent: boolean; outputSchema: EsquemaJson; inputSchema?: EsquemaJson; camposEditaveis?: EsquemaJson; paramsDoPacote?: ParamsDoPacote }[] {
    return [...this.handlers.entries()].map(([kind, handler]) => ({
      kind,
      modes: handler.modes ?? (["approve", "draft", "auto"] as const),
      holdsByContent: typeof handler.holdForApproval === "function",
      outputSchema: handler.outputSchema ?? SAIDA_PADRAO_DA_ACAO,
      ...(handler.inputSchema === undefined ? {} : { inputSchema: handler.inputSchema }),
      ...(handler.camposEditaveis === undefined ? {} : { camposEditaveis: handler.camposEditaveis }),
      ...(handler.paramsDoPacote === undefined ? {} : { paramsDoPacote: handler.paramsDoPacote }),
    }));
  }

  /**
   * A parte assíncrona de submeter: valida o modo, deixa o handler montar o
   * que vai para a fila e decide se o conteúdo precisa mesmo de clique.
   *
   * Separada de `enqueue` porque quem propõe fora do executor, como
   * `InitiativeService.proposeContextUpdate`, precisa terminar isto antes de
   * abrir a transação síncrona que grava run, passo e pendência juntos: nada
   * async entra no callback de `db.transaction`.
   */
  async prepare(
    kind: string,
    payload: unknown,
    mode: ActionMode,
    target: string | null = null,
  ): Promise<{ payload: unknown; mode: ActionMode }> {
    const handler = this.handlers.get(kind);

    // Antes de gravar qualquer coisa: modo recusado nao deixa pendencia orfa na
    // fila, e quem escreveu o agent ve o erro no passo que errou.
    if (handler?.modes !== undefined && !handler.modes.includes(mode)) {
      throw new Error(`a acao "${kind}" so aceita o modo ${handler.modes.join(", ")}, e o passo pediu "${mode}"`);
    }

    const prepared = handler?.propose ? await handler.propose(payload, target) : payload;
    if (prepared === null || prepared === undefined) await handler?.discard?.(payload).catch(() => undefined);
    const finalMode = mode === "auto" && handler?.holdForApproval?.(prepared) ? "approve" : mode;
    return { payload: prepared, mode: finalMode };
  }

  /**
   * A parte síncrona de submeter: só a gravação da pendência. Recebe o
   * escritor (o `db` de fora de transação, ou o `tx` de uma transação em
   * andamento) porque quem propõe fora do executor grava run, passo e
   * pendência na mesma transação, e as três inserções têm que terminar juntas
   * ou nenhuma.
   */
  enqueue(
    writer: Db,
    req: ActionRequest,
    prepared: { payload: unknown; mode: ActionMode },
  ): { id: string; externalId: string } {
    const id = randomUUID();
    const externalId = `${req.runId}:${req.stepId}:${req.attempt ?? 0}`;
    writer
      .insert(schema.approvals)
      .values({
        id,
        runId: req.runId,
        stepId: req.stepId,
        kind: req.kind,
        payload: prepared.payload as object,
        // Rascunho e publicação direta não entram na fila: aprovar um rascunho
        // que falhou publicaria em público o que o passo pedia só rascunhar.
        status: prepared.mode === "approve" ? "pending" : prepared.mode === "draft" ? "drafting" : "auto",
        externalId,
      })
      .run();
    return { id, externalId };
  }

  async submit(req: ActionRequest, mode: ActionMode): Promise<"pending" | "drafted" | "published"> {
    return (await this.submitComSaida(req, mode)).state;
  }

  /** Como `submit`, e devolve também a resposta que a publicação trouxe, quando trouxe. */
  async submitComSaida(
    req: ActionRequest,
    mode: ActionMode,
  ): Promise<{ state: "pending" | "drafted" | "published"; output?: unknown }> {
    const prepared = await this.prepare(req.kind, req.payload, mode, req.target ?? null);
    const { id, externalId } = this.enqueue(db, req, prepared);

    if (prepared.mode === "approve") return { state: "pending" };

    const handler = this.handlers.get(req.kind);
    if (!handler) throw new Error(`acao "${req.kind}" sem handler registrado`);

    try {
      if (prepared.mode === "draft") {
        if (!handler.draft) throw new Error(`acao "${req.kind}" nao suporta modo rascunho`);
        await handler.draft(prepared.payload, externalId);
        await this.close(id, "drafted");
        return { state: "drafted" };
      }

      const publicada = await handler.publish(prepared.payload, externalId);
      await this.close(id, "approved", { output: publicada?.output ?? { state: "published" } });
      return { state: "published", ...(publicada ? { output: publicada.output } : {}) };
    } catch (err) {
      await this.close(id, "failed");
      throw err;
    }
  }

  /**
   * Chamado pela inbox quando você clica. Devolve o run da pendência, que quem
   * chamou precisa retomar: a gate só fecha a pendência e o passo, e rodar o
   * resto do pipeline é trabalho do executor.
   */
  async decide(
    approvalId: string,
    decision: "approved" | "rejected",
  ): Promise<{ runId: string; status: "approved" | "rejected" | "conflict"; motivo?: string }> {
    const [row] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
    if (!row) throw new Error(`aprovacao ${approvalId} nao encontrada`);
    if (row.status !== "pending") throw new Error(`aprovacao ${approvalId} ja resolvida: ${row.status}`);

    let status: "approved" | "rejected" | "conflict" = decision;
    let resposta: { output: unknown } | undefined;
    let motivo: string | undefined;
    if (decision === "approved") {
      const handler = this.handlers.get(row.kind);
      if (!handler) throw new Error(`acao "${row.kind}" sem handler registrado`);
      // Tomar a pendência antes de publicar, numa escrita só. Dois cliques
      // (a tela de revisão e a inbox, ou a janela e a linha de comando) liam
      // `pending` ao mesmo tempo e publicavam duas vezes no nome de alguém.
      // Quem cai no meio da publicação deixa a pendência em `publishing`, e
      // ela não volta para a fila sozinha: melhor uma pessoa conferir do que
      // sair uma segunda resposta.
      const tomada = db
        .update(schema.approvals)
        .set({ status: "publishing", decidedAt: Math.floor(Date.now() / 1000) })
        .where(and(eq(schema.approvals.id, approvalId), eq(schema.approvals.status, "pending")))
        .run();
      if (tomada.changes !== 1) throw new Error(`aprovacao ${approvalId} ja esta sendo resolvida`);
      try {
        resposta = (await handler.publish(row.payload, row.externalId!)) || undefined;
      } catch (err) {
        if (!(err instanceof PublishConflict)) {
          // Falha antes de sair qualquer coisa: a pendência volta para quem
          // decide tentar de novo.
          await db
            .update(schema.approvals)
            .set({ status: "pending", decidedAt: null })
            .where(and(eq(schema.approvals.id, approvalId), eq(schema.approvals.status, "publishing")));
          throw err;
        }
        status = "conflict";
        motivo = err.motivo;
      }
    } else {
      const fechada = db
        .update(schema.approvals)
        .set({ status: "rejected", decidedAt: Math.floor(Date.now() / 1000) })
        .where(and(eq(schema.approvals.id, approvalId), eq(schema.approvals.status, "pending")))
        .run();
      if (fechada.changes !== 1) throw new Error(`aprovacao ${approvalId} ja esta sendo resolvida`);
    }
    // A resposta vai para a pendência antes de o passo ser atualizado: uma
    // queda entre os dois não a perde.
    await this.close(
      approvalId,
      status,
      status === "approved"
        ? { output: resposta?.output ?? { state: "published" } }
        : motivo === undefined ? undefined : { output: { conflito: motivo } },
    );
    await settleStep(row.stepId, status, status === "approved" ? { output: resposta?.output } : { motivo });
    if (status !== "approved") {
      await this.handlers.get(row.kind)?.discard?.(row.payload).catch(() => undefined);
    }
    return { runId: row.runId, status, ...(motivo === undefined ? {} : { motivo }) };
  }

  /**
   * Resolve à mão a pendência que ficou em `publishing`.
   *
   * O app caiu, ou a rede sumiu, no meio da publicação, e não há como saber
   * daqui se a mensagem saiu. Quem sabe é a pessoa, olhando o pull request ou a
   * conversa: `published` fecha a pendência como aprovada e o run segue,
   * `retry` devolve a pendência para a fila para ela decidir de novo.
   *
   * Só vale para a que está parada há mais de `STUCK_AFTER_SECONDS`. Uma
   * publicação em andamento leva segundos, e devolver para a fila a que ainda
   * está saindo abriria de novo a porta da publicação em dobro.
   */
  async settleStuck(
    approvalId: string,
    outcome: "published" | "retry",
  ): Promise<{ runId: string; status: "approved" | "pending" }> {
    const [row] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
    if (!row) throw new Error(`aprovacao ${approvalId} nao encontrada`);
    const limite = Math.floor(Date.now() / 1000) - STUCK_AFTER_SECONDS;
    const parada = and(
      eq(schema.approvals.id, approvalId),
      eq(schema.approvals.status, "publishing"),
      lte(schema.approvals.decidedAt, limite),
    );
    // Dada por publicada à mão, a pendência não tem a resposta da ferramenta.
    const saida = { state: "published", ...(this.semResposta(row.kind) ? { semResposta: true } : {}) };
    const escrita = db
      .update(schema.approvals)
      .set(
        outcome === "published"
          ? { status: "approved", decidedAt: Math.floor(Date.now() / 1000), output: saida }
          : { status: "pending", decidedAt: null },
      )
      .where(parada)
      .run();
    if (escrita.changes !== 1) {
      throw new Error(`aprovacao ${approvalId} nao esta parada na publicacao`);
    }
    if (outcome === "retry") return { runId: row.runId, status: "pending" };
    await settleStep(row.stepId, "approved", { output: saida });
    return { runId: row.runId, status: "approved" };
  }

  private async close(id: string, status: string, gravar?: { output: unknown }): Promise<void> {
    await db
      .update(schema.approvals)
      .set({ status, decidedAt: Math.floor(Date.now() / 1000), ...(gravar === undefined ? {} : { output: gravar.output as object }) })
      .where(eq(schema.approvals.id, id));
  }
}

/**
 * Leva o passo de ação ao estado que a decisão gravada na pendência diz.
 *
 * Mora fora da gate porque o executor também chama, na retomada: quem caiu
 * entre fechar a pendência e atualizar o passo deixaria o passo em
 * `awaiting_approval` com a decisão já tomada, e a retomada pausaria de novo
 * para sempre. Rejeitar pula o passo em vez de falhar, porque rejeitar é uma
 * resposta válida e o que vem depois ainda pode rodar.
 */
export async function settleStep(
  stepId: string,
  status: string,
  /** `output`: o que a pendência guardou da publicação. `semResposta`: não há como saber a resposta (dada por publicada à mão). */
  extra: { output?: unknown; semResposta?: boolean; motivo?: string } = {},
): Promise<{ output: unknown }> {
  const endedAt = Math.floor(Date.now() / 1000);
  // Só o passo que ainda espera a decisão. O que foi zerado por uma
  // reexecução já é outra tentativa, e a decisão da pendência antiga não
  // fala por ela.
  const esperando = and(eq(schema.steps.id, stepId), eq(schema.steps.status, "awaiting_approval"));
  if (status === "rejected" || status === "conflict") {
    const error = status === "conflict" ? (extra.motivo ?? MOTIVO_DE_CONFLITO) : "rejected";
    await db.update(schema.steps).set({ status: "skipped", error, output: null, endedAt }).where(esperando);
    return { output: null };
  }
  const output =
    extra.output !== undefined && status === "approved"
      ? extra.output
      : { state: status === "drafted" ? "drafted" : "published", ...(extra.semResposta === true ? { semResposta: true } : {}) };
  await db.update(schema.steps).set({ status: "done", output, endedAt }).where(esperando);
  return { output };
}
