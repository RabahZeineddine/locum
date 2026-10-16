#!/usr/bin/env node
/**
 * Entrada do servidor MCP do Locum, por transporte stdio.
 *
 * O banco e o mesmo do aplicativo. O modo WAL deixa este processo ler enquanto
 * a linha de comando escreve, entao nao existe copia nem sincronizacao.
 *
 * Nada pode escrever em stdout aqui: stdout e o canal do protocolo, e um
 * `console.log` perdido corrompe a sessao do cliente. Diagnostico vai para
 * stderr.
 */
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { migrateDb } from "../db/migrate.js";
import { buildMcpServer } from "./server.js";

// O servidor sobe da raiz do repositório, que é o que o .mcp.json manda, e a
// busca padrão da pasta de migração sobe diretórios sem nunca descer para app/.
// Pelo próprio arquivo, o caminho vale de onde quer que ele seja chamado.
migrateDb(fileURLToPath(new URL("../../drizzle", import.meta.url)));

const { ligarLimites } = await import("../services/limites-padrao.js");
ligarLimites();
const server = buildMcpServer();
await server.connect(new StdioServerTransport());
console.error("servidor MCP do locum no ar");
