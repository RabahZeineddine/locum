/**
 * Por que a lista de canais do Slack não veio. O código é o que a tela
 * traduz; o texto, em inglês, é para quem lê o erro cru (o MCP). O código vai
 * no começo da mensagem porque só ela atravessa a ponte. Arquivo sem
 * dependência de propósito: a tela importa daqui.
 */
export type SlackChannelsErrorCode = "sem-conexao" | "sem-escopo" | "outro-servidor";

const TEXTO: Record<SlackChannelsErrorCode, string> = {
  "sem-conexao": "Slack is not connected. Connect it in Connections, through the official server.",
  "sem-escopo": "The Slack token lacks the channel scopes. Update the Slack app with the new manifest and connect again.",
  "outro-servidor": "The list only comes through the official Slack connection. Paste the channel ID.",
};

export class SlackChannelsError extends Error {
  constructor(readonly code: SlackChannelsErrorCode) {
    super(`slack-canais:${code}: ${TEXTO[code]}`);
  }
}

/** O código dentro da mensagem de um erro que atravessou a ponte, ou nulo. */
export function codigoDoErroDeCanais(mensagem: string): SlackChannelsErrorCode | null {
  const achou = /slack-canais:(sem-conexao|sem-escopo|outro-servidor)/.exec(mensagem);
  return achou === null ? null : (achou[1] as SlackChannelsErrorCode);
}
