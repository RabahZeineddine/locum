import { notInArray, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, schema } from "../db/index.js";
import { dbPath } from "../db/path.js";
import { RESERVED_AGENT_IDS } from "../services/agent-service.js";
import { machineId } from "../services/machine-service.js";
import { registerConfigTools } from "./config-tools.js";
import { registerReadTools } from "./read-tools.js";
import { registerRunTools } from "./run-tools.js";

export const SERVER_NAME = "locum";
export const SERVER_VERSION = "0.1.0";

/**
 * Monta o servidor sem conectar transporte, para que as ferramentas possam ser
 * exercidas em processo. O `index.ts` e quem liga o stdio.
 *
 * Aqui o Locum e servidor: ele se expoe a agents externos. O `McpRegistry` e o
 * papel oposto, de cliente. O ADR 0002 pede que os dois nomes nao se misturem.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "locum_health",
    {
      description:
        "Confere que o servidor esta de pe e enxergando o mesmo banco do aplicativo.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(await health(), null, 2) }],
    }),
  );

  registerReadTools(server);
  registerConfigTools(server);
  registerRunTools(server);
  return server;
}

export interface Health {
  server: string;
  version: string;
  machineId: string;
  dbPath: string;
  counts: { agents: number; runs: number; mcpServers: number };
}

async function health(): Promise<Health> {
  return {
    server: SERVER_NAME,
    version: SERVER_VERSION,
    machineId,
    dbPath: dbPath(),
    counts: {
      agents: await agentCount(),
      runs: await count(schema.runs),
      mcpServers: await count(schema.mcpServers),
    },
  };
}

async function count(table: SQLiteTable): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(table);
  return row?.n ?? 0;
}

/** Conta agent como o dono da maquina enxerga: sem os agents do sistema. */
async function agentCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.agents)
    .where(notInArray(schema.agents.id, [...RESERVED_AGENT_IDS]));
  return row?.n ?? 0;
}
