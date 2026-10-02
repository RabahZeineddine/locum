import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { TriggerConfig, type TriggerConfigInput } from "../config/types.js";
import { isReserved } from "./agent-service.js";

type Db = typeof defaultDb;

export type TriggerRow = typeof schema.triggers.$inferSelect;

/** Gatilho cadastrado, com a configuracao ja validada. */
export interface TriggerEntry {
  id: string;
  agentId: string;
  config: TriggerConfig;
  enabled: boolean;
}

/**
 * Cadastro de gatilhos. Linha de comando, servidor MCP e interface passam por
 * aqui porque a regra de que gatilho nasce desabilitado precisa valer para os
 * tres: um agent recem gravado que ja acordasse sozinho contrariaria o ADR
 * 0002, que so libera gravacao de agent justamente porque nenhuma versao entra
 * em execucao agendada sem alguem habilitar o gatilho.
 *
 * Quem consome isto e o agendador em `triggers/scheduler.ts`, que so bate
 * gatilho habilitado.
 */
export class TriggerService {
  constructor(private readonly db: Db = defaultDb) {}

  async list(agentId?: string): Promise<TriggerEntry[]> {
    const rows = await this.db
      .select()
      .from(schema.triggers)
      .where(agentId !== undefined ? eq(schema.triggers.agentId, agentId) : undefined);
    return rows.map(toEntry);
  }

  async get(id: string): Promise<TriggerEntry | undefined> {
    const row = await this.row(id);
    return row ? toEntry(row) : undefined;
  }

  /** So o que o agendador deve enxergar quando ele chegar. */
  async enabled(): Promise<TriggerEntry[]> {
    const rows = await this.db
      .select()
      .from(schema.triggers)
      .where(eq(schema.triggers.enabled, true));
    return rows.map(toEntry);
  }

  /**
   * Cadastra ou atualiza.
   *
   * Sem `id`, um gatilho identico ao que ja existe devolve o que existe em vez
   * de criar outro: nao ha como distinguir dois gatilhos iguais do mesmo agent,
   * e duplicata aqui vira o mesmo trabalho rodando duas vezes.
   */
  async set(
    agentId: string,
    config: TriggerConfigInput,
    options: { id?: string; enabled?: boolean; fromTool?: boolean } = {},
  ): Promise<TriggerEntry> {
    // Ligar é o passo que deixa o agent acordar e gastar sozinho, e só uma
    // pessoa dá esse passo, pela interface ou pela linha de comando.
    if (options.fromTool && options.enabled === true) {
      throw new Error("gatilho so e ligado por uma pessoa, pela interface ou pela linha de comando");
    }
    if (isReserved(agentId)) throw new Error(`"${agentId}" e um agent do sistema e nao aceita escrita`);
    const parsed = TriggerConfig.parse(config);
    const agent = await this.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId));
    if (agent.length === 0) throw new Error(`agent "${agentId}" nao cadastrado`);

    const existing = options.id
      ? await this.requireRow(options.id, agentId)
      : await this.sameConfigRow(agentId, parsed);

    if (existing) {
      const [updated] = await this.db
        .update(schema.triggers)
        .set({
          kind: parsed.kind,
          config: parsed as unknown as object,
          // Pela ferramenta, trocar o que um gatilho ligado escuta desliga o
          // gatilho: a pessoa ligou para aquela configuração, não para esta.
          enabled:
            options.fromTool && JSON.stringify(existing.config) !== JSON.stringify(parsed)
              ? false
              : (options.enabled ?? existing.enabled),
        })
        .where(eq(schema.triggers.id, existing.id))
        .returning();
      return toEntry(updated!);
    }

    const [inserted] = await this.db
      .insert(schema.triggers)
      .values({
        id: randomUUID(),
        agentId,
        kind: parsed.kind,
        config: parsed as unknown as object,
        enabled: options.enabled ?? false,
      })
      .returning();
    return toEntry(inserted!);
  }

  async setEnabled(id: string, enabled: boolean): Promise<TriggerEntry> {
    const existing = await this.row(id);
    if (!existing) throw new Error(`gatilho ${id} nao cadastrado`);
    if (isReserved(existing.agentId)) {
      throw new Error(`"${existing.agentId}" e um agent do sistema e nao aceita escrita`);
    }
    const [updated] = await this.db
      .update(schema.triggers)
      .set({ enabled })
      .where(eq(schema.triggers.id, id))
      .returning();
    if (!updated) throw new Error(`gatilho ${id} nao cadastrado`);
    return toEntry(updated);
  }

  async remove(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(schema.triggers)
      .where(eq(schema.triggers.id, id))
      .returning();
    return deleted.length > 0;
  }

  private async requireRow(id: string, agentId: string): Promise<TriggerRow> {
    const row = await this.row(id);
    if (!row) throw new Error(`gatilho ${id} nao cadastrado`);
    // Trocar o dono de um gatilho por engano moveria trabalho de um agent para
    // outro sem deixar rastro, entao aqui e erro e nao reatribuicao.
    if (row.agentId !== agentId) {
      throw new Error(`gatilho ${id} pertence ao agent "${row.agentId}", nao a "${agentId}"`);
    }
    return row;
  }

  /**
   * Linha do mesmo agent com configuracao igual. A comparacao e sobre o JSON
   * do valor ja validado, que e o unico jeito de a ordem das chaves bater.
   */
  private async sameConfigRow(
    agentId: string,
    config: TriggerConfig,
  ): Promise<TriggerRow | undefined> {
    const target = JSON.stringify(config);
    const rows = await this.db
      .select()
      .from(schema.triggers)
      .where(and(eq(schema.triggers.agentId, agentId), eq(schema.triggers.kind, config.kind)));

    return rows.find((row) => {
      const parsed = TriggerConfig.safeParse(row.config);
      return parsed.success && JSON.stringify(parsed.data) === target;
    });
  }

  private async row(id: string): Promise<TriggerRow | undefined> {
    const [row] = await this.db.select().from(schema.triggers).where(eq(schema.triggers.id, id));
    return row;
  }
}

/**
 * A configuracao volta pelo zod para que linha gravada por uma versao antiga
 * do schema estoure no cadastro, e nao la na frente quando o agendador tentar
 * acordar o agent sem ninguem olhando.
 */
function toEntry(row: TriggerRow): TriggerEntry {
  return {
    id: row.id,
    agentId: row.agentId,
    config: TriggerConfig.parse(row.config),
    enabled: row.enabled,
  };
}

export const triggerService = new TriggerService();
