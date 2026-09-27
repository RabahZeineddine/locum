import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";

type Db = typeof defaultDb;

export type PromptRow = typeof schema.prompts.$inferSelect;
export type PromptVersionRow = typeof schema.promptVersions.$inferSelect;

/** Prompt com o corpo da versao mais recente ja resolvido. */
export interface PromptWithLatest extends PromptRow {
  version: number;
  body: string;
  note: string | null;
}

/**
 * Prompt versionado. Nome unico entre todos, corpo com versao nova so quando
 * o texto muda: nota sozinha, ou uma segunda gravacao com o mesmo corpo, nao
 * abrem versao.
 */
export class PromptService {
  constructor(private readonly db: Db = defaultDb) {}

  async list(initiativeId?: string): Promise<PromptWithLatest[]> {
    const linhas =
      initiativeId === undefined
        ? await this.db.select().from(schema.prompts)
        : await this.db
            .select()
            .from(schema.prompts)
            .where(eq(schema.prompts.initiativeId, initiativeId));

    return Promise.all(linhas.map((linha) => this.withLatest(linha)));
  }

  async get(name: string): Promise<PromptWithLatest | undefined> {
    const linha = await this.row(name);
    return linha ? this.withLatest(linha) : undefined;
  }

  async upsert(name: string, body: string, note?: string): Promise<PromptWithLatest> {
    const nome = name.trim();
    if (nome.length === 0) throw new Error("prompt precisa de nome");

    let linha = await this.row(nome);
    if (!linha) {
      const [inserida] = await this.db
        .insert(schema.prompts)
        .values({ id: randomUUID(), name: nome })
        .returning();
      linha = inserida!;
    }

    const ultima = await this.latestVersion(linha.id);
    if (ultima && ultima.body === body) {
      return { ...linha, version: ultima.version, body: ultima.body, note: ultima.note };
    }

    const [versao] = await this.db
      .insert(schema.promptVersions)
      .values({
        id: randomUUID(),
        promptId: linha.id,
        version: (ultima?.version ?? 0) + 1,
        body,
        note: note ?? null,
      })
      .returning();
    return { ...linha, version: versao!.version, body: versao!.body, note: versao!.note };
  }

  async versions(name: string): Promise<PromptVersionRow[]> {
    const linha = await this.row(name);
    if (!linha) return [];
    return this.db
      .select()
      .from(schema.promptVersions)
      .where(eq(schema.promptVersions.promptId, linha.id))
      .orderBy(desc(schema.promptVersions.version));
  }

  private async withLatest(linha: PromptRow): Promise<PromptWithLatest> {
    const ultima = await this.latestVersion(linha.id);
    return {
      ...linha,
      version: ultima?.version ?? 0,
      body: ultima?.body ?? "",
      note: ultima?.note ?? null,
    };
  }

  private async latestVersion(promptId: string): Promise<PromptVersionRow | undefined> {
    const [linha] = await this.db
      .select()
      .from(schema.promptVersions)
      .where(eq(schema.promptVersions.promptId, promptId))
      .orderBy(desc(schema.promptVersions.version))
      .limit(1);
    return linha;
  }

  private async row(name: string): Promise<PromptRow | undefined> {
    const [linha] = await this.db.select().from(schema.prompts).where(eq(schema.prompts.name, name));
    return linha;
  }
}

export const promptService = new PromptService();
