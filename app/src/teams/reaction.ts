import { mcpOAuthService } from "../services/mcp-oauth-service.js";
import { GRAPH_URL, TEAMS_SERVER } from "../services/teams-app.js";
import { clienteHttp } from "../net/http.js";

/** Pegou o PR. */
export const REACAO_PEGOU = "👀";

/** A reação do veredito, que troca a de "pegou". */
export const REACAO_DO_VEREDITO = {
  APPROVE: "✅",
  REQUEST_CHANGES: "⚠️",
  COMMENT: "💬",
} as const;

/** A mensagem do Teams onde o Locum reage. */
export type AlvoDaReacao =
  | { tipo: "chat"; chatId: string; messageId: string }
  | { tipo: "canal"; teamId: string; channelId: string; messageId: string; replyToId?: string };

export interface TeamsReactionOptions {
  /** Token do Graph. Ausente é o que a conexão do Teams guardou. */
  token?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  graphUrl?: string;
}

const texto = (valor: unknown): string | null => (typeof valor === "string" && valor !== "" ? valor : null);

/**
 * A mensagem onde reagir, pelos campos que a varredura gravou no evento. Nulo
 * quando o evento não veio do Teams com PR, que é o caso de todo review que
 * nasceu em outro lugar.
 */
export function alvoDaReacao(payload: unknown): AlvoDaReacao | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  const messageId = texto(p.teamsMessageId);
  if (messageId === null) return null;
  const chatId = texto(p.teamsChatId);
  if (chatId !== null) return { tipo: "chat", chatId, messageId };
  const teamId = texto(p.teamsTeamId);
  const channelId = texto(p.teamsChannelId);
  if (teamId === null || channelId === null) return null;
  const replyToId = texto(p.teamsReplyToId);
  return { tipo: "canal", teamId, channelId, messageId, ...(replyToId === null ? {} : { replyToId }) };
}

function caminhoDe(alvo: AlvoDaReacao): string {
  const enc = encodeURIComponent;
  if (alvo.tipo === "chat") return `/chats/${enc(alvo.chatId)}/messages/${enc(alvo.messageId)}`;
  const canal = `/teams/${enc(alvo.teamId)}/channels/${enc(alvo.channelId)}/messages`;
  return alvo.replyToId === undefined
    ? `${canal}/${enc(alvo.messageId)}`
    : `${canal}/${enc(alvo.replyToId)}/replies/${enc(alvo.messageId)}`;
}

/** Põe ou tira uma reação. Estoura se o Graph recusar: quem chama decide se engole. */
export async function reagirNoTeams(
  alvo: AlvoDaReacao,
  acao: "set" | "unset",
  emoji: string,
  options: TeamsReactionOptions = {},
): Promise<void> {
  const valor = await (options.token ?? (() => mcpOAuthService.accessToken(TEAMS_SERVER)))();
  if (valor === null) throw new Error("o Teams não está conectado");
  const resposta = await (options.fetchFn ?? clienteHttp)(
    `${options.graphUrl ?? GRAPH_URL}${caminhoDe(alvo)}/${acao}Reaction`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${valor}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reactionType: emoji }),
    },
  );
  if (!resposta.ok) {
    const corpo = (await resposta.json().catch(() => ({}))) as { error?: { code?: unknown } };
    const codigo = typeof corpo.error?.code === "string" ? `: ${corpo.error.code}` : "";
    throw new Error(`Graph recusou a reação com ${resposta.status}${codigo}`);
  }
}
