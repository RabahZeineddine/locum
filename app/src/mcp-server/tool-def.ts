import type { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { respond } from "./respond.js";

/**
 * O que cada ferramenta faz ao mundo, dito ao cliente por anotação do protocolo.
 *
 * É daqui que o Claude Code decide perguntar antes de chamar: a recomendação é
 * deixar liberadas só as de leitura, e as demais perguntam a cada chamada.
 * Quem confirma cada escrita é o cliente, e não uma trava a mais no Locum.
 *
 * - `read`: só lê o que há no banco ou na máquina.
 * - `read-external`: só lê, mas fala com um serviço de fora (Teams, GitHub, o servidor MCP cadastrado).
 * - `write`: grava configuração interna, reversível, sem efeito fora da máquina.
 * - `danger`: apaga, sobrescreve, ou alarga o que o app faz sozinho (modo `auto`, todos os chats).
 * - `external`: fala com serviço de fora ou abre o navegador, sem publicar nada.
 * - `publish`: publica em nome da pessoa, ou liga/dispara o que age sozinho com a conta dela.
 */
export type Kind = "read" | "read-external" | "write" | "danger" | "external" | "publish";

export const ANOTACOES: Record<Kind, { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }> = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  "read-external": { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  danger: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  external: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  publish: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

/** Registra a ferramenta com a anotação do seu tipo e a resposta no formato do protocolo. */
export function def<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  kind: Kind,
  description: string,
  shape: S,
  run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): void {
  server.registerTool(
    name,
    { description, inputSchema: shape, annotations: ANOTACOES[kind] } as never,
    (async (args: unknown) => respond(() => run(args as z.infer<z.ZodObject<S>>))) as never,
  );
}

/**
 * As ferramentas que nasceram antes das anotações, registradas direto no
 * servidor. A tabela cobre cada uma, e uma ferramenta sem tipo estoura na
 * montagem: esquecer a anotação seria deixar o cliente sem saber o que ela faz.
 */
export const TIPO_DAS_ANTIGAS: Record<string, Kind> = {
  locum_health: "read",
  list_agents: "read",
  get_agent: "read",
  list_runs: "read",
  get_run: "read",
  list_findings: "read",
  get_metrics: "read",
  list_mcp_servers: "read",
  list_providers: "read",
  get_machine_profile: "read",
  upsert_agent: "danger",
  register_mcp_server: "danger",
  test_mcp_server: "external",
  list_server_tools: "external",
  set_model_fallback: "write",
  set_budget: "write",
  set_trigger: "write",
  run_agent: "publish",
  rerun_step: "publish",
  list_initiatives: "read",
  get_initiative: "read",
  read_initiative_context: "read",
  list_prompts: "read",
  get_prompt: "read",
  upsert_initiative: "write",
  set_initiative_status: "write",
  set_initiative_servers: "write",
  link_agent_to_initiative: "write",
  set_initiative_workspace: "write",
  add_initiative_link: "write",
  upsert_prompt: "write",
  propose_context_update: "write",
  describe_steps: "read",
  list_library_agents: "read",
  get_library_agent: "read",
  upsert_library_agent: "danger",
  list_toolsets: "read",
  upsert_toolset: "danger",
  remove_library_agent: "danger",
  remove_toolset: "danger",
};

/** Põe a anotação em quem registra sem ela, e recusa o que não tem tipo conhecido. */
export function exigirAnotacoes(server: McpServer): McpServer {
  const registrar = server.registerTool.bind(server) as (name: string, config: Record<string, unknown>, cb: unknown) => unknown;
  (server as unknown as { registerTool: typeof registrar }).registerTool = (name, config, cb) => {
    if (config.annotations === undefined) {
      const tipo = TIPO_DAS_ANTIGAS[name];
      if (tipo === undefined) throw new Error(`ferramenta ${name} sem tipo de anotação`);
      return registrar(name, { ...config, annotations: ANOTACOES[tipo] }, cb);
    }
    return registrar(name, config, cb);
  };
  return server;
}
