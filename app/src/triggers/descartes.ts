import { and, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { comTrava } from "./trava.js";
import type { Descarte } from "../sources/github-filtros.js";

type Db = typeof defaultDb;

/** Fonte do registro de descartes. Uma linha por gatilho, com a lista em JSON. */
const FONTE = "gatilho-descartes";

/** Quantos descartes cada gatilho guarda. */
export const TETO_GUARDADO = 50;

/** Um pull request que o gatilho viu e não virou evento, e quando foi a última vez. */
export type DescarteGuardado = Descarte & { em: number };

export async function lerDescartes(db: Db, triggerId: string): Promise<DescarteGuardado[]> {
  const [row] = await db
    .select({ value: schema.cursors.value })
    .from(schema.cursors)
    .where(and(eq(schema.cursors.source, FONTE), eq(schema.cursors.key, triggerId)));
  if (!row) return [];
  try {
    const lista = JSON.parse(row.value) as unknown;
    return Array.isArray(lista)
      ? lista.filter((d): d is DescarteGuardado => typeof d?.pr === "string" && typeof d?.motivo === "string" && typeof d?.em === "number")
      : [];
  } catch {
    return [];
  }
}

/**
 * Soma os descartes da batida aos guardados, o mais novo primeiro.
 *
 * O pull request que continua na janela volta a ser descartado a cada batida,
 * então o mesmo par pull request e motivo vira uma linha só, com a hora da
 * última vez. Mora na tabela de cursores, que já guarda o que o agendador
 * precisa lembrar, e não pede migração.
 */
export async function registrarDescartes(
  db: Db,
  triggerId: string,
  novos: Descarte[],
  at: number,
): Promise<void> {
  if (novos.length === 0) return;
  // Ler e gravar dentro da trava: duas batidas do mesmo gatilho não perdem o que a outra gravou.
  return comTrava(`descartes:${triggerId}`, () => gravar(db, triggerId, novos, at));
}

async function gravar(db: Db, triggerId: string, novos: Descarte[], at: number): Promise<void> {
  const chave = (d: Descarte) => `${d.pr}\n${d.motivo}`;
  const nossos = new Set(novos.map(chave));
  const antigos = (await lerDescartes(db, triggerId)).filter((d) => !nossos.has(chave(d)));
  const lista = [...novos.map((d) => ({ ...d, em: at })), ...antigos].slice(0, TETO_GUARDADO);
  const value = JSON.stringify(lista);
  await db
    .insert(schema.cursors)
    .values({ source: FONTE, key: triggerId, value })
    .onConflictDoUpdate({
      target: [schema.cursors.source, schema.cursors.key],
      set: { value, updatedAt: Math.floor(at / 1000) },
    });
}

/** Apaga o registro de um gatilho removido. */
export async function esquecerDescartes(db: Db, triggerId: string): Promise<void> {
  await comTrava(`descartes:${triggerId}`, async () => {
    await db.delete(schema.cursors).where(and(eq(schema.cursors.source, FONTE), eq(schema.cursors.key, triggerId)));
  });
}
