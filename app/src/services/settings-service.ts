import { eq, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { WorkingHoursConfig } from "../config/types.js";

type Db = typeof defaultDb;

export const WORKING_HOURS_SETTING_KEY = "scheduler.working_hours";

/**
 * Chave e valor da instalacao. Serve as preferencias que os dois processos
 * precisam enxergar iguais, e devolve `undefined` quando a chave nunca foi
 * gravada, porque "nao decidido" e diferente de "decidido que nao".
 */
export class SettingsService {
  constructor(private readonly db: Db = defaultDb) {}

  async get(key: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, key));
    return row?.value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db
      .insert(schema.settings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value, updatedAt: sql`(unixepoch())` },
      });
  }

  async remove(key: string): Promise<boolean> {
    const deleted = await this.db
      .delete(schema.settings)
      .where(eq(schema.settings.key, key))
      .returning({ key: schema.settings.key });
    return deleted.length > 0;
  }

  async getBoolean(key: string): Promise<boolean | undefined> {
    const value = await this.get(key);
    return value === undefined ? undefined : value === "true";
  }

  async setBoolean(key: string, value: boolean): Promise<void> {
    await this.set(key, value ? "true" : "false");
  }

  async getWorkingHours(): Promise<WorkingHoursConfig | undefined> {
    const raw = await this.get(WORKING_HOURS_SETTING_KEY);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      return WorkingHoursConfig.parse(parsed);
    } catch {
      return undefined;
    }
  }

  async setWorkingHours(config: WorkingHoursConfig): Promise<void> {
    await this.set(WORKING_HOURS_SETTING_KEY, JSON.stringify(config));
  }
}

export const settingsService = new SettingsService();
