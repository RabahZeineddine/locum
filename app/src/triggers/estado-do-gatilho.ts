import { and, eq, sql } from "drizzle-orm";
import { gatilhoExiste } from "../db/arquivada.js";
import { db as defaultDb, schema } from "../db/index.js";

type Db = Pick<typeof defaultDb, "delete">;

/**
 * Onde cada coisa que prende estado a um gatilho o guarda. Quem passa a guardar
 * estado por gatilho declara aqui; `esquecerGatilho` apaga pelo declarado, sem
 * saber de fonte nenhuma.
 */
export type EstadoDoGatilho =
  | {
      onde: "cursor";
      /** Com `id`, a fonte é `<nome>:<id do gatilho>`; sem, a fonte é o nome puro. */
      fonte: { nome: string; com: "id" | "nada" };
      /** `id`: a chave é o id. `termina-no-id`: `<qualquer coisa>:<id>`. `qualquer`: toda chave da fonte. */
      chave: "id" | "termina-no-id" | "qualquer";
    }
  | { onde: "setting"; /** A chave é `<chave>:<id do gatilho>`. */ chave: string };

/** Nomes das fontes de cursor presas a um gatilho, para quem as grava e a lista abaixo usarem o mesmo. */
export const FONTE_DESCARTES = "gatilho-descartes";
export const FONTE_ERRO = "gatilho-erro";
export const FONTE_RELOGIO = "scheduler";
export const FONTE_RETENTATIVA = "scheduler-retry";
/** Registro da chave de cursor que o gatilho do GitHub usou por último. */
export const FONTE_ULTIMA_CHAVE_GITHUB = "gatilho-cursor";
export const FONTE_TEAMS = "teams";
/** Tentativas que o filtro de IA falhou, uma fonte por gatilho. */
export const FONTE_FALHAS_DO_FILTRO = "teams-filtro-ia-falhas";
/** Conta do Teams lida na primeira batida do gatilho. */
export const CHAVE_CONTA_DO_TEAMS = "teams.account.inbox";

export const ESTADO_DO_GATILHO: readonly EstadoDoGatilho[] = [
  { onde: "cursor", fonte: { nome: FONTE_DESCARTES, com: "nada" }, chave: "id" },
  { onde: "cursor", fonte: { nome: FONTE_ERRO, com: "nada" }, chave: "id" },
  { onde: "cursor", fonte: { nome: FONTE_RELOGIO, com: "nada" }, chave: "id" },
  { onde: "cursor", fonte: { nome: FONTE_RETENTATIVA, com: "nada" }, chave: "id" },
  { onde: "cursor", fonte: { nome: FONTE_ULTIMA_CHAVE_GITHUB, com: "nada" }, chave: "id" },
  // `inbox:<id>` da caixa e `channel:<time>:<canal>:<id>` de cada canal.
  { onde: "cursor", fonte: { nome: FONTE_TEAMS, com: "nada" }, chave: "termina-no-id" },
  { onde: "cursor", fonte: { nome: FONTE_FALHAS_DO_FILTRO, com: "id" }, chave: "qualquer" },
  { onde: "setting", chave: CHAVE_CONTA_DO_TEAMS },
];

/** Apaga todo estado preso ao gatilho. Síncrona: roda dentro de uma transação de quem chama. */
export function esquecerGatilho(db: Db, triggerId: string): void {
  for (const e of ESTADO_DO_GATILHO) {
    if (e.onde === "setting") {
      db.delete(schema.settings).where(eq(schema.settings.key, `${e.chave}:${triggerId}`)).run();
      continue;
    }
    const fonte = eq(schema.cursors.source, e.fonte.com === "id" ? `${e.fonte.nome}:${triggerId}` : e.fonte.nome);
    const sufixo = `:${triggerId}`;
    const chave =
      e.chave === "id"
        ? eq(schema.cursors.key, triggerId)
        : e.chave === "termina-no-id"
          ? sql`substr(${schema.cursors.key}, -${sufixo.length}) = ${sufixo}`
          : undefined;
    db.delete(schema.cursors).where(and(fonte, chave)).run();
  }
}

type LinhaDeCursor = { source: string; key: string };

/** A linha é de um dos formatos que a tabela declara para este gatilho. */
function declarada(linha: LinhaDeCursor, triggerId: string): boolean {
  const sufixo = `:${triggerId}`;
  return ESTADO_DO_GATILHO.some(
    (e) =>
      e.onde === "cursor" &&
      linha.source === (e.fonte.com === "id" ? `${e.fonte.nome}:${triggerId}` : e.fonte.nome) &&
      (e.chave === "qualquer" || (e.chave === "id" ? linha.key === triggerId : linha.key.endsWith(sufixo))),
  );
}

/**
 * Grava o estado de um gatilho só se ele ainda existe, conferido na mesma
 * transação que grava. Quem arquiva ou remove o gatilho (inclusive em outro
 * processo) apaga o estado e o gatilho juntos, e uma batida que ainda corria
 * não o recria: a gravação é descartada, com aviso no log. Devolve se gravou.
 * Linha que a tabela não declara é erro de programação, não gravação silenciosa.
 */
export function gravarCursorDoGatilho(
  db: Pick<typeof defaultDb, "transaction">,
  triggerId: string,
  linha: LinhaDeCursor,
  value: string,
  at: number = Date.now(),
): boolean {
  if (!declarada(linha, triggerId)) throw new Error(`ESTADO_DO_GATILHO nao declara ${linha.source}/${linha.key} para o gatilho ${triggerId}`);
  return db.transaction(
    (tx) => {
      if (!gatilhoExiste(tx, triggerId)) {
        console.warn(`estado do gatilho ${triggerId} descartado (${linha.source}): o gatilho nao existe mais`);
        return false;
      }
      tx.insert(schema.cursors)
        .values({ ...linha, value })
        .onConflictDoUpdate({ target: [schema.cursors.source, schema.cursors.key], set: { value, updatedAt: Math.floor(at / 1000) } })
        .run();
      return true;
    },
    { behavior: "immediate" },
  );
}

/** O mesmo para a configuração guardada por gatilho (`<chave>:<id>`): grava se não havia, e mantém a que havia. */
export function gravarSettingDoGatilho(db: Pick<typeof defaultDb, "transaction">, triggerId: string, chave: string, value: string): boolean {
  if (!ESTADO_DO_GATILHO.some((e) => e.onde === "setting" && e.chave === chave)) throw new Error(`ESTADO_DO_GATILHO nao declara a configuracao ${chave}`);
  return db.transaction(
    (tx) => {
      if (!gatilhoExiste(tx, triggerId)) {
        console.warn(`configuracao ${chave} do gatilho ${triggerId} descartada: o gatilho nao existe mais`);
        return false;
      }
      tx.insert(schema.settings).values({ key: `${chave}:${triggerId}`, value }).onConflictDoNothing().run();
      return true;
    },
    { behavior: "immediate" },
  );
}
