import { and, eq, inArray, type SQLWrapper } from "drizzle-orm";
import { db as defaultDb, schema } from "./index.js";

type Db = Pick<typeof defaultDb, "delete">;

/** Fonte do cursor que marca o run já reconciliado com o desfecho do pull request. */
export const FONTE_RECONCILE = "reconcile";

/**
 * Onde cada coisa que prende estado a um run o guarda, no espírito de
 * `ESTADO_DO_GATILHO`. Quem passa a guardar estado por run declara aqui;
 * `esquecerRuns` apaga pelo declarado, sem saber de fonte nenhuma.
 */
export type EstadoDoRun = {
  onde: "cursor";
  fonte: string;
  /** A chave do cursor é o id do run. */
  chave: "id";
};

export const ESTADO_DO_RUN: readonly EstadoDoRun[] = [{ onde: "cursor", fonte: FONTE_RECONCILE, chave: "id" }];

/** Apaga o estado preso aos runs. Síncrona: roda dentro de uma transação de quem chama. */
export function esquecerRuns(db: Db, runIds: SQLWrapper | readonly string[]): void {
  for (const e of ESTADO_DO_RUN) {
    db.delete(schema.cursors).where(and(eq(schema.cursors.source, e.fonte), inArray(schema.cursors.key, runIds))).run();
  }
}
