import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { ActionMode } from "../config/types.js";

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
export class PublishConflict extends Error {}

export type ActionRequest = {
  runId: string;
  stepId: string;
  kind: string;
  payload: unknown;
  /** O `target` do passo, quando ele declarou um. */
  target?: string | null;
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
  /** Publica de verdade. Recebe o externalId ja gravado, para ser idempotente. */
  publish(payload: unknown, externalId: string): Promise<void>;
  /** Prepara sem publicar. No GitHub, review em estado pendente. */
  draft?(payload: unknown, externalId: string): Promise<void>;
};

/**
 * Porta unica de saida. Nada que escreve fora passa por outro lugar.
 *
 * `approve` e o padrao. `auto` existe, mas nasce desligado e escopado, e a UI
 * so deve oferece-lo quando as metricas sustentarem. Ha acao que nao aceita os
 * tres, e quem diz isso e o handler, em `modes`: abrir tarefa em nome de uma
 * pessoa nunca e automatico, e uma regra dessas nao pode depender de o modo
 * certo estar escrito na spec.
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
  describe(): { kind: string; modes: readonly ActionMode[]; holdsByContent: boolean }[] {
    return [...this.handlers.entries()].map(([kind, handler]) => ({
      kind,
      modes: handler.modes ?? (["approve", "draft", "auto"] as const),
      holdsByContent: typeof handler.holdForApproval === "function",
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
    const externalId = `${req.runId}:${req.stepId}`;
    writer
      .insert(schema.approvals)
      .values({
        id,
        runId: req.runId,
        stepId: req.stepId,
        kind: req.kind,
        payload: prepared.payload as object,
        status: prepared.mode === "approve" ? "pending" : prepared.mode === "draft" ? "pending" : "auto",
        externalId,
      })
      .run();
    return { id, externalId };
  }

  async submit(req: ActionRequest, mode: ActionMode): Promise<"pending" | "drafted" | "published"> {
    const prepared = await this.prepare(req.kind, req.payload, mode, req.target ?? null);
    const { id, externalId } = this.enqueue(db, req, prepared);

    if (prepared.mode === "approve") return "pending";

    const handler = this.handlers.get(req.kind);
    if (!handler) throw new Error(`acao "${req.kind}" sem handler registrado`);

    if (prepared.mode === "draft") {
      if (!handler.draft) throw new Error(`acao "${req.kind}" nao suporta modo rascunho`);
      await handler.draft(prepared.payload, externalId);
      await this.close(id, "drafted");
      return "drafted";
    }

    await handler.publish(prepared.payload, externalId);
    await this.close(id, "approved");
    return "published";
  }

  /**
   * Chamado pela inbox quando você clica. Devolve o run da pendência, que quem
   * chamou precisa retomar: a gate só fecha a pendência e o passo, e rodar o
   * resto do pipeline é trabalho do executor.
   */
  async decide(
    approvalId: string,
    decision: "approved" | "rejected",
  ): Promise<{ runId: string; status: "approved" | "rejected" | "conflict" }> {
    const [row] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
    if (!row) throw new Error(`aprovacao ${approvalId} nao encontrada`);
    if (row.status !== "pending") throw new Error(`aprovacao ${approvalId} ja resolvida: ${row.status}`);

    let status: "approved" | "rejected" | "conflict" = decision;
    if (decision === "approved") {
      const handler = this.handlers.get(row.kind);
      if (!handler) throw new Error(`acao "${row.kind}" sem handler registrado`);
      try {
        // externalId ja esta gravado: retry depois de crash nao publica duas vezes.
        await handler.publish(row.payload, row.externalId!);
      } catch (err) {
        if (!(err instanceof PublishConflict)) throw err;
        status = "conflict";
      }
    }
    await this.close(approvalId, status);
    await settleStep(row.stepId, status);
    return { runId: row.runId, status };
  }

  private async close(id: string, status: string): Promise<void> {
    await db
      .update(schema.approvals)
      .set({ status, decidedAt: Math.floor(Date.now() / 1000) })
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
export async function settleStep(stepId: string, status: string): Promise<{ output: unknown }> {
  const endedAt = Math.floor(Date.now() / 1000);
  if (status === "rejected" || status === "conflict") {
    const error = status === "conflict" ? "publish_conflict" : "rejected";
    await db
      .update(schema.steps)
      .set({ status: "skipped", error, output: null, endedAt })
      .where(eq(schema.steps.id, stepId));
    return { output: null };
  }
  const output = { state: status === "drafted" ? "drafted" : "published" };
  await db.update(schema.steps).set({ status: "done", output, endedAt }).where(eq(schema.steps.id, stepId));
  return { output };
}
