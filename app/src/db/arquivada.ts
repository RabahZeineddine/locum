import { eq } from "drizzle-orm";
import { db as defaultDb, schema } from "./index.js";

type Leitor = Pick<typeof defaultDb, "select">;

/** A automação está arquivada: nada dela roda, é salvo ou liga. */
export class AutomacaoArquivada extends Error {
  constructor(readonly agentId: string) {
    super(`automacao "${agentId}" esta arquivada; desarquive para usar`);
    this.name = "AutomacaoArquivada";
  }
}

/** O gatilho foi removido (ou arquivado junto com a automação) depois que quem chama o leu. */
export class GatilhoRemovido extends Error {
  constructor(readonly triggerId: string) {
    super(`gatilho ${triggerId} nao existe mais`);
    this.name = "GatilhoRemovido";
  }
}

/** Síncrona, para rodar dentro da mesma transação que grava. */
export function recusarSeArquivada(leitor: Leitor, agentId: string): void {
  const agent = leitor.select({ archivedAt: schema.agents.archivedAt }).from(schema.agents).where(eq(schema.agents.id, agentId)).get();
  if (agent?.archivedAt != null) throw new AutomacaoArquivada(agentId);
}

/** Verdadeiro quando o gatilho ainda existe. Síncrona, para a mesma transação que grava. */
export function gatilhoExiste(leitor: Leitor, triggerId: string): boolean {
  return leitor.select({ id: schema.triggers.id }).from(schema.triggers).where(eq(schema.triggers.id, triggerId)).get() !== undefined;
}
