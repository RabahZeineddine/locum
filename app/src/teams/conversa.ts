import { TEAMS_CHANNEL_PREFIX } from "../sources/teams-inbox.js";
import type { AdaptadorDeConversa } from "../acao/conversa.js";
import { alvoDaReacao } from "./reaction.js";
import { lerRefDoTeams, refDoTeams } from "./ref.js";

/** Prefixo do `repo` que a caixa do Teams grava em cada evento. */
const PREFIXO = "teams/";

/** Para onde vai a resposta, pelo `repo` do evento. */
export type DestinoDoTeams =
  | { tipo: "chat"; chatId: string }
  | { tipo: "canal"; teamId: string; channelId: string; threadId: string };

/**
 * Evento de PR guarda `owner/repo` em `repo`, e um dono chamado `teams` ou
 * `teams-channel` faria esse nome passar por conversa. Quem distingue é o
 * `prOwner`, que só o evento de PR tem.
 */
function eventoDePr(payload: unknown): boolean {
  return typeof (payload as { prOwner?: unknown } | null | undefined)?.prOwner === "string";
}

/**
 * O destino de um evento de PR que veio do Teams. O `repo` dele é o do GitHub,
 * então a conversa de origem vem dos campos `teams*` que a varredura grava
 * (os mesmos do 👀). Numa mensagem dentro de thread a resposta vai na raiz
 * (`teamsReplyToId`); na raiz do canal, na própria mensagem. Nulo se o PR não
 * veio do Teams.
 */
function destinoDoPr(payload: unknown): DestinoDoTeams | null {
  const alvo = alvoDaReacao(payload);
  if (alvo === null) return null;
  if (alvo.tipo === "chat") return { tipo: "chat", chatId: alvo.chatId };
  return { tipo: "canal", teamId: alvo.teamId, channelId: alvo.channelId, threadId: alvo.replyToId ?? alvo.messageId };
}

export function destinoDe(payload: unknown): DestinoDoTeams {
  if (eventoDePr(payload)) {
    const doPr = destinoDoPr(payload);
    if (doPr === null) throw new Error("o passo de resposta no Teams nao recebeu um evento de conversa");
    return doPr;
  }
  const repo = (payload as { repo?: unknown } | null | undefined)?.repo;
  if (typeof repo === "string" && repo.startsWith(TEAMS_CHANNEL_PREFIX)) {
    const partes = repo.slice(TEAMS_CHANNEL_PREFIX.length).split("/");
    if (partes.length === 3 && partes.every((p) => p !== "")) {
      return { tipo: "canal", teamId: partes[0]!, channelId: partes[1]!, threadId: partes[2]! };
    }
  }
  return { tipo: "chat", chatId: chatOf(payload) };
}

/** De qual conversa o evento veio, pelo `repo`, como no Slack. */
export function chatOf(payload: unknown): string {
  const repo = (payload as { repo?: unknown } | null | undefined)?.repo;
  if (eventoDePr(payload) || typeof repo !== "string" || !repo.startsWith(PREFIXO) || repo.length === PREFIXO.length) {
    throw new Error("o passo de resposta no Teams nao recebeu um evento de conversa");
  }
  return repo.slice(PREFIXO.length);
}


/**
 * O adaptador do Teams: o evento diz a conversa pelo `repo` (ou pelos campos
 * `teams*` quando é um PR achado numa conversa), e o destino fixo é `chat/<id>`
 * ou `canal/<equipe>/<canal>`. Numa thread de canal, a mensagem é a raiz dela.
 */
export const adaptadorDoTeams: AdaptadorDeConversa = {
  app: "teams",
  enderecoDoEvento(payload) {
    const d = destinoDe(payload);
    const conta = (payload as { teamsAccount?: unknown } | null)?.teamsAccount;
    return {
      conversa: refDoTeams(d),
      mensagem: d.tipo === "chat" ? null : d.threadId,
      conta: typeof conta === "string" && conta !== "" ? conta : null,
    };
  },
  validarRef(ref) {
    lerRefDoTeams(ref);
  },
  descreverRef(ref) {
    const c = lerRefDoTeams(ref);
    return c.tipo === "chat" ? `Chat ${c.chatId}` : `Canal ${c.channelId} (equipe ${c.teamId})`;
  },
};
