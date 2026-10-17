import type { EsquemaJson } from "../config/referencias.js";
import { CAMPOS_DO_LINK_DE_PR, CAMPOS_DO_PR } from "./esquema-github.js";

const MENSAGEM: Record<string, EsquemaJson> = {
  kind: { type: "string", description: "mention, dm or pr." },
  author: { type: ["string", "null"], description: "Who wrote the message (the pull request author when it links one)." },
  authorId: { type: ["string", "null"], description: "Teams id of who wrote it." },
  text: { type: "string", description: "The message text." },
  messageId: { type: ["string", "null"], description: "Teams id of the message (empty when the event was pasted by hand)." },
  webUrl: { type: ["string", "null"], description: "Address of the message." },
  chatType: { type: "string", description: "Kind of conversation." },
  repo: { type: "string", description: "The conversation, or the repository when the message links a pull request." },
  server: { type: "string", description: "Server the message was read through." },
  at: { type: ["string", "null"], description: "When the poll read the message." },
  teamsAccount: { type: "string", description: "Account the message was read with." },
};

const CONVERSA: Record<string, EsquemaJson> = { chatId: { type: ["string", "null"], description: "Teams id of the chat (empty when the event was pasted by hand)." } };

const CANAL: Record<string, EsquemaJson> = {
  teamId: { type: "string", description: "Team of the channel." },
  channelId: { type: "string", description: "Channel id." },
  channel: { type: "string", description: "Channel name." },
  threadId: { type: "string", description: "Thread the message belongs to." },
};

const COM_PR: Record<string, EsquemaJson> = {
  ...CAMPOS_DO_PR,
  ...CAMPOS_DO_LINK_DE_PR,
  teamsAuthor: { type: ["string", "null"], description: "Who wrote the Teams message." },
  teamsChatId: { type: "string", description: "Chat the message came from." },
  teamsMessageId: { type: "string", description: "Message the review can react to." },
  teamsTeamId: { type: "string", description: "Team of the channel, for a channel message." },
  teamsChannelId: { type: "string", description: "Channel, for a channel message." },
  teamsReplyToId: { type: "string", description: "Thread to reply to, when the message is a reply." },
};

/**
 * Evento do gatilho `teams-inbox` (teams-inbox.ts). Com `prLinks` o evento
 * traz também o contexto do PR, e `author` e `repo` passam a ser os do PR.
 */
export function esquemaDoEventoDoTeams(opcoes: { prLinks: boolean }): EsquemaJson {
  return {
    type: "object",
    properties: { ...CONVERSA, ...CANAL, ...MENSAGEM, ...(opcoes.prLinks ? COM_PR : {}) },
    required: ["repo", "kind", "text", "messageId", ...(opcoes.prLinks ? ["prOwner", "prRepo", "prNumber", "title", "diff", "url", "prsTexto"] : [])],
  };
}
