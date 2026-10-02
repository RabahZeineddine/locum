import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { AgentBudget } from "../config/types.js";

export class BudgetExceeded extends Error {
  constructor(scope: "run" | "day", unit: "usd" | "tokens", limit: number, spent: number) {
    const fmt = (n: number) => (unit === "usd" ? `${n.toFixed(2)} USD` : `${Math.round(n)} tokens`);
    super(`orçamento de ${scope} estourado: limite ${fmt(limit)}, gasto ${fmt(spent)}`);
  }
}

/**
 * O dia de quem usa, no fuso do Mac, e não em UTC.
 *
 * Em UTC, o teto diário de quem está em São Paulo virava às 21h: o agent que
 * estourou às 20h ganhava um dia inteiro de gasto antes da meia-noite.
 */
export function today(now: Date = new Date()): string {
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${dois(now.getMonth() + 1)}-${dois(now.getDate())}`;
}

/** Gasto em dinheiro e em tokens dos passos cobrados. */
export type Spend = { usd: number; tokens: number };

/**
 * Checado antes de cada passo de modelo, nao so no comeco do run.
 *
 * O dia vem de `usage_daily`, que o executor atualiza assim que cada passo
 * cobrado termina. Runs simultâneos do mesmo agent ainda podem passar juntos pela checagem,
 * mas cada um passa só um passo além do teto, e não um run inteiro.
 */
export async function assertWithinBudget(
  agentId: string,
  run: Spend,
  limits: AgentBudget,
): Promise<void> {
  if (limits.perRunUsd !== undefined && run.usd >= limits.perRunUsd) {
    throw new BudgetExceeded("run", "usd", limits.perRunUsd, run.usd);
  }
  if (limits.perRunTokens !== undefined && run.tokens >= limits.perRunTokens) {
    throw new BudgetExceeded("run", "tokens", limits.perRunTokens, run.tokens);
  }
  if (limits.perDayUsd === undefined && limits.perDayTokens === undefined) return;

  const [row] = await db
    .select()
    .from(schema.usageDaily)
    .where(and(eq(schema.usageDaily.day, today()), eq(schema.usageDaily.agentId, agentId)));

  const usd = row?.costUsd ?? 0;
  if (limits.perDayUsd !== undefined && usd >= limits.perDayUsd) {
    throw new BudgetExceeded("day", "usd", limits.perDayUsd, usd);
  }
  const tokens = row?.tokens ?? 0;
  if (limits.perDayTokens !== undefined && tokens >= limits.perDayTokens) {
    throw new BudgetExceeded("day", "tokens", limits.perDayTokens, tokens);
  }
}

/**
 * Soma no dia um gasto, e a execução quando `newRun`.
 *
 * O executor chama a cada passo cobrado, com `newRun` falso, e uma vez na
 * saída do trecho para contar a execução: um run que pausa na fila e é
 * retomado depois tem dois trechos, e só o primeiro conta como execução.
 */
export async function recordSpend(agentId: string, spend: Spend, newRun: boolean): Promise<void> {
  if (!newRun && spend.usd === 0 && spend.tokens === 0) return;
  const day = today();
  const runs = newRun ? 1 : 0;
  await db
    .insert(schema.usageDaily)
    .values({ day, agentId, costUsd: spend.usd, tokens: spend.tokens, runs })
    .onConflictDoUpdate({
      target: [schema.usageDaily.day, schema.usageDaily.agentId],
      set: {
        costUsd: sql`${schema.usageDaily.costUsd} + ${spend.usd}`,
        tokens: sql`${schema.usageDaily.tokens} + ${spend.tokens}`,
        runs: sql`${schema.usageDaily.runs} + ${runs}`,
      },
    });
}
