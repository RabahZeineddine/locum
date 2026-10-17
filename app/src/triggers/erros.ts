import { and, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { FONTE_ERRO } from "./estado-do-gatilho.js";

type Db = typeof defaultDb;

/** Fonte do último erro de cada gatilho. Uma linha por gatilho, em JSON. */
const FONTE = FONTE_ERRO;

/**
 * O último erro de um gatilho: de configuração (a varredura seguiu, mas um
 * time ou um nome não deu para ler) ou de batida (ela falhou). Uma batida sem
 * erro apaga o registro, então o que está aqui é o que ainda vale.
 */
export type ErroDoGatilho = { em: number; tipo: "configuracao" | "batida"; texto: string };

export async function lerErro(db: Db, triggerId: string): Promise<ErroDoGatilho | null> {
  const [row] = await db
    .select({ value: schema.cursors.value })
    .from(schema.cursors)
    .where(and(eq(schema.cursors.source, FONTE), eq(schema.cursors.key, triggerId)));
  if (!row) return null;
  try {
    const e = JSON.parse(row.value) as Partial<ErroDoGatilho>;
    return typeof e.em === "number" && typeof e.texto === "string" && (e.tipo === "configuracao" || e.tipo === "batida")
      ? { em: e.em, tipo: e.tipo, texto: e.texto }
      : null;
  } catch {
    return null;
  }
}

export async function registrarErro(db: Db, triggerId: string, erro: ErroDoGatilho): Promise<void> {
  const value = JSON.stringify(erro);
  await db
    .insert(schema.cursors)
    .values({ source: FONTE, key: triggerId, value })
    .onConflictDoUpdate({
      target: [schema.cursors.source, schema.cursors.key],
      set: { value, updatedAt: Math.floor(erro.em / 1000) },
    });
}

export async function limparErro(db: Db, triggerId: string): Promise<void> {
  await db.delete(schema.cursors).where(and(eq(schema.cursors.source, FONTE), eq(schema.cursors.key, triggerId)));
}
