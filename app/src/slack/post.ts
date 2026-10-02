import { McpRegistry } from "../mcp/registry.js";
import { mcpService, type McpService } from "../services/mcp-service.js";
import type { SlackWatch } from "../services/slack-service.js";
import { unwrap, type McpCaller } from "../sources/mcp-poll.js";
import type { SlackPostProposal } from "./proposal.js";

export interface SlackPostOptions {
  mcp?: McpService;
  /** Quem chama a ferramenta. Entra como dependência para poder ser trocado. */
  call?: McpCaller;
}

/**
 * Manda a resposta para a thread, pelo servidor MCP cadastrado.
 *
 * Só é chamado depois do clique de alguém na fila: quem chega aqui é o
 * `publish` do handler, e a gate só o chama com a pendência aprovada. Não há
 * token do Slack neste caminho, como não há na leitura: quem fala com o Slack
 * é o servidor MCP que alguém já autorizou.
 *
 * Os nomes de argumento vêm do cadastro porque variam de um servidor para
 * outro, e os da resposta são outros que os da leitura: a ferramenta que lista
 * histórico costuma chamar o canal de `channel_id`, e a que publica chama de
 * `channel`.
 */
export async function postSlackReply(
  proposal: SlackPostProposal,
  watch: SlackWatch,
  options: SlackPostOptions = {},
): Promise<void> {
  const args = {
    [watch.postChannelArg]: proposal.channel,
    [watch.threadArg]: proposal.threadTs,
    [watch.textArg]: proposal.text,
  };

  // `unwrap` está aqui pelo `isError`: o protocolo devolve a falha da
  // ferramenta como resposta bem sucedida, e quem não olhasse esse campo daria
  // a mensagem por publicada e fecharia a pendência de uma resposta que não
  // saiu.
  const resposta = unwrap(await callTool(proposal.server, watch.postTool, args, options));

  // Servidor que só repassa a API do Slack devolve a recusa como corpo normal,
  // `{"ok": false, "error": "not_in_channel"}`, sem `isError`. Lido como
  // sucesso, fecharia a pendência de uma resposta que o Slack não aceitou.
  const corpo = resposta as { ok?: unknown; error?: unknown } | null;
  if (corpo !== null && typeof corpo === "object" && corpo.ok === false) {
    const motivo = typeof corpo.error === "string" ? corpo.error : "sem motivo";
    throw new Error(`o Slack recusou a resposta: ${motivo}`);
  }
}

async function callTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
  options: SlackPostOptions,
): Promise<unknown> {
  if (options.call !== undefined) return options.call(server, tool, args);

  const registry = McpRegistry.fromList(await (options.mcp ?? mcpService).enabledConfigs());
  if (!registry.has(server)) throw new Error(`servidor MCP "${server}" nao esta habilitado`);
  try {
    return await registry.callTool(server, tool, args);
  } finally {
    await registry.closeAll();
  }
}
