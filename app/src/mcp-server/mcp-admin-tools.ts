import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVIDOR_CONTA } from "../config/types.js";
import { mcpService } from "../services/mcp-service.js";
import { redactServerConfig } from "./redact.js";
import { def } from "./tool-def.js";

/**
 * O resto da tela de servidores MCP: ligar, colar credencial, o vínculo com a
 * origem (plugin, Claude Code, Cursor) e quem usa cada servidor. Cadastrar,
 * testar e listar ferramentas ficam em `config-tools.ts`.
 *
 * Ligar é a ferramenta que deixa o executor subir o comando do servidor com os
 * poderes do app, e por isso vem como destrutiva: o cliente pergunta antes.
 */
async function cadastro(name: string) {
  const entrada = await mcpService.get(name);
  if (entrada === undefined) throw new Error(`servidor MCP "${name}" nao cadastrado`);
  return { ...redactServerConfig(entrada.config), enabled: entrada.enabled };
}

export function registerMcpAdminTools(server: McpServer): void {
  def(server, "set_mcp_server_enabled", "danger",
    "Turns a registered MCP server on or off, like the switch of the screen. On, the app starts its command (stdio) or calls its URL with the powers of the app whenever a step, a test or a tool list needs it; read the command with list_mcp_servers before turning one on. Off is always safe.",
    { name: z.string().min(1), enabled: z.boolean() },
    async ({ name, enabled }) => {
      await mcpService.setEnabled(name, enabled);
      return cadastro(name);
    });

  def(server, "set_mcp_server_credential", "write",
    "Stores a pasted token for a server that does not use OAuth (API key, personal token). The value goes to the keychain and is never returned; the registration gets the placeholder in the given header (http) or variable (stdio). In Authorization, a value without scheme gets \"Bearer \".",
    { name: z.string().min(1), field: z.string().min(1).describe("header or variable name, like Authorization or API_KEY"), value: z.string().min(1) },
    async ({ name, field, value }) => {
      await mcpService.setCredential(name, { campo: field, valor: value });
      return cadastro(name);
    });

  def(server, "get_mcp_usage", "read",
    "Which initiatives use each MCP server, by title.",
    {}, () => mcpService.usage());

  def(server, "get_mcp_links", "read",
    "The servers linked to an origin (a plugin, Claude Code, Cursor...): whether the origin matches what was accepted, changed (with the diff and the hash to accept) or disappeared. Secrets come masked.",
    {}, () => mcpService.vinculos());

  def(server, "accept_mcp_origin", "danger",
    "Applies the change the origin made to a linked server, like the Accept button: command, url, env and headers become what the origin file says now. hash is the one get_mcp_links showed; if the origin changed again since, nothing is applied.",
    { name: z.string().min(1), hash: z.string().min(1) },
    async ({ name, hash }) => {
      await mcpService.aceitarOrigem(name, hash);
      return cadastro(name);
    });

  def(server, "keep_mcp_previous", "write",
    "Keeps the previous configuration of a linked server and drops the warning of this change. The warning comes back if the origin changes again.",
    { name: z.string().min(1), hash: z.string().min(1) },
    async ({ name, hash }) => {
      await mcpService.manterAnterior(name, hash);
      return cadastro(name);
    });

  def(server, "unlink_mcp_server", "write",
    "Cuts the link of a server to its origin: it becomes a manual registration, with today's configuration as an editable copy. Linking again means importing again.",
    { name: z.string().min(1) },
    async ({ name }) => {
      await mcpService.desvincular(name);
      return cadastro(name);
    });

  def(server, "list_cached_server_tools", "read",
    "The last good tool list of a server, without starting it, with when it was read. null when it was never listed.",
    { name: z.string().min(1) },
    async ({ name }) => (name === SERVIDOR_CONTA ? null : mcpService.cachedTools(name)));
}
