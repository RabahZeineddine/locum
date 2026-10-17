import { and, eq, sql } from "drizzle-orm";
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
