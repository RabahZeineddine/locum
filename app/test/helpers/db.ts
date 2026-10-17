import Database from "better-sqlite3";
import type { Logger } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "../../src/db/schema.js";

const migracoes = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Banco em memória com o esquema das migrações, um por teste.
 *
 * Vem das migrações, e não de um `create table` escrito aqui, para que o teste
 * enxergue o mesmo esquema que o aplicativo instalado recebe na subida.
 */
export function bancoDeTeste(opcoes: { logger?: Logger } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema, logger: opcoes.logger });
  migrate(db, { migrationsFolder: migracoes });
  return db;
}

/**
 * O gatilho de mentira do agendador também existe no banco, como o real: a
 * gravação de estado por gatilho confere que ele ainda existe. Devolve o gatilho
 * (ou nada), para usar direto no `get` do cadastro falso.
 */
export function plantarGatilho<T extends { id: string; agentId: string; config: unknown; enabled: boolean }>(
  db: ReturnType<typeof bancoDeTeste>,
  gatilho: T | undefined,
): T | undefined {
  if (gatilho === undefined) return undefined;
  db.insert(schema.agents).values({ id: gatilho.agentId, name: gatilho.agentId }).onConflictDoNothing().run();
  db.insert(schema.triggers)
    .values({ id: gatilho.id, agentId: gatilho.agentId, kind: (gatilho.config as { kind: string }).kind, config: gatilho.config as object, enabled: gatilho.enabled })
    .onConflictDoNothing()
    .run();
  return gatilho;
}
