import { notInArray, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db, schema } from "../db/index.js";
import { dbPath } from "../db/path.js";
import { RESERVED_AGENT_IDS } from "../services/agent-service.js";
import { machineId } from "../services/machine-service.js";
import { registerAgentChatTools } from "./agent-chat-tools.js";
import { registerAgentExtraTools } from "./agent-extra-tools.js";
import { ambientePadrao, type Ambiente } from "./ambiente.js";
import { registerApprovalTools } from "./approval-tools.js";
import { registerAutomationTools } from "./automation-tools.js";
import { registerConfigTools } from "./config-tools.js";
import { registerConnectionTools } from "./connection-tools.js";
import { registerInitiativeTools } from "./initiative-tools.js";
import { registerLibraryTools } from "./library-tools.js";
import { registerLimitsTools } from "./limits-tools.js";
import { registerMcpAdminTools } from "./mcp-admin-tools.js";
import { registerPackageTools } from "./package-tools.js";
import { registerProviderTools } from "./provider-tools.js";
import { registerReadTools } from "./read-tools.js";
import { registerRunTools } from "./run-tools.js";
import { registerSessionTools } from "./session-tools.js";
import { registerSettingsTools } from "./settings-tools.js";
import { registerSkillsTools } from "./skills-tools.js";
import { exigirAnotacoes } from "./tool-def.js";

export const SERVER_NAME = "locum";
export const SERVER_VERSION = "0.1.0";

/**
 * Monta o servidor sem conectar transporte, para que as ferramentas possam ser
 * exercidas em processo. O `index.ts` e quem liga o stdio.
 *
 * Aqui o Locum e servidor: ele se expoe a agents externos. O `McpRegistry` e o
 * papel oposto, de cliente. O ADR 0002 pede que os dois nomes nao se misturem.
 *
 * O `fora` troca partes do ambiente (Teams, sessões, chat de agent, executor):
 * o teste para nao sair da maquina, e o Electron para entregar o que so ele tem.
 * Toda ferramenta sai com anotacao, e a montagem estoura se alguma ficar sem.
 */
export function buildMcpServer(fora: Partial<Ambiente> = {}): McpServer {
  const amb: Ambiente = { ...ambientePadrao, ...fora };
  const server = exigirAnotacoes(new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }));

  server.registerTool(
    "locum_health",
    {
      description:
        "Checks that the server is up and sees the same database as the app.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(await health(), null, 2) }],
    }),
  );

  registerReadTools(server);
  registerLimitsTools(server);
  registerConfigTools(server);
  registerRunTools(server);
  registerInitiativeTools(server);
  registerLibraryTools(server);
  registerAutomationTools(server);
  registerConnectionTools(server, amb);
  registerApprovalTools(server, amb);
  registerPackageTools(server);
  registerAgentExtraTools(server, amb);
  registerAgentChatTools(server, amb);
  registerProviderTools(server);
  registerMcpAdminTools(server);
  registerSessionTools(server, amb);
  registerSettingsTools(server, amb);
  registerSkillsTools(server);
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
