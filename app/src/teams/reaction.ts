import { abrirTeams, type TeamsGraphOptions } from "./graph.js";

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

export type TeamsReactionOptions = TeamsGraphOptions;

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

/**
 * Tira o 👀 da mensagem do evento, se ele veio do Teams com PR, e não põe nada.
 * É o fim de quem pegou o PR e não vai publicar review: fila rejeitada, run
 * falho ou sem orçamento. Recusa do Graph vira log.
 */
export async function soltarOPr(payload: unknown, options: TeamsReactionOptions = {}): Promise<void> {
  const alvo = alvoDaReacao(payload);
  if (alvo === null) return;
  try {
    await reagirNoTeams(alvo, "unset", REACAO_PEGOU, options);
  } catch (err) {
    console.error(`tirar ${REACAO_PEGOU} no Teams falhou: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Põe ou tira uma reação. Estoura se o Graph recusar: quem chama decide se engole. */
export async function reagirNoTeams(
  alvo: AlvoDaReacao,
  acao: "set" | "unset",
  emoji: string,
  options: TeamsReactionOptions = {},
): Promise<void> {
  const teams = await abrirTeams(options);
  try {
    await teams.post(`${caminhoDe(alvo)}/${acao}Reaction`, { reactionType: emoji }, "a reação");
  } finally {
    // Uma sessão que veio de fora (a da varredura) é de quem a abriu.
    if (options.graph === undefined) await teams.close();
  }
}
