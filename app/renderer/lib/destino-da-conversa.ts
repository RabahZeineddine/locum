import { ACOES_DE_CONVERSA_REGISTRO, destinoDoPasso, type DestinoDaAcao } from "../../src/acao/destino";
import { refDoTeams } from "../../src/teams/ref";

/** Uma conversa que a pessoa pode escolher como destino fixo, no formato do `ref` do app. */
export interface OpcaoDeConversa {
  ref: string;
  rotulo: string;
  /** Agrupa na lista (a equipe de um canal do Teams). */
  grupo?: string;
}

export interface ListasDeConversa {
  teamsChats?: readonly { chatId: string; label: string }[];
  teamsCanais?: readonly { teamId: string; teamName: string; channelId: string; channelName: string }[];
  slackCanais?: readonly { id: string; name: string; isPrivate: boolean }[];
}

/**
 * As conversas que o app oferece, das mesmas listas que o gatilho usa. Cada app
 * só diz como a sua lista vira `ref`; o resto da tela é igual para todos.
 */
export function opcoesDeConversa(app: string, listas: ListasDeConversa): OpcaoDeConversa[] {
  if (app === "teams") {
    const chats = (listas.teamsChats ?? []).map((c) => ({ ref: refDoTeams({ tipo: "chat", chatId: c.chatId }), rotulo: c.label }));
    const canais = (listas.teamsCanais ?? []).map((c) => ({
      ref: refDoTeams({ tipo: "canal", teamId: c.teamId, channelId: c.channelId }),
      rotulo: c.channelName,
      grupo: c.teamName,
    }));
    return [...chats, ...canais];
  }
  if (app === "slack") {
    return (listas.slackCanais ?? []).map((c) => ({ ref: c.id, rotulo: `#${c.name}` }));
  }
  return [];
}

/** O destino do passo como a tela o mostra: o gravado, ou o padrão (evento) quando o passo é antigo. */
export function destinoDoNo(acao: string, params: Record<string, unknown> | undefined): DestinoDaAcao {
  try {
    return destinoDoPasso(acao, params);
  } catch {
    // Destino fixo ainda sem conversa escolhida: o campo continua em "fixo" até a pessoa escolher.
    const cru = params?.destino as { tipo?: unknown; conversa?: { app?: unknown; ref?: unknown; rotulo?: unknown } } | undefined;
    if (cru?.tipo === "fixo") {
      return { tipo: "fixo", conversa: { app: String(cru.conversa?.app ?? ""), ref: String(cru.conversa?.ref ?? ""), rotulo: String(cru.conversa?.rotulo ?? "") } };
    }
    return { tipo: "evento" };
  }
}

/** `params` com o destino trocado; o padrão (evento) sai do passo, como num passo antigo. */
export function paramsComDestino(params: Record<string, unknown> | undefined, destino: DestinoDaAcao): Record<string, unknown> {
  const { destino: _antigo, ...resto } = params ?? {};
  return destino.tipo === "evento" ? resto : { ...resto, destino };
}

/** Os gatilhos que trazem mensagem de cada app de conversa. */
const GATILHOS_DO_APP: Record<string, readonly string[]> = {
  teams: ["teams-inbox"],
  slack: ["slack-channel", "slack-inbox"],
};

/** Se algum dos gatilhos entrega uma mensagem do app para a ação responder (manual e cron não entregam). */
export function gatilhoTrazMensagem(acao: string, kinds: readonly string[]): boolean {
  const app = ACOES_DE_CONVERSA_REGISTRO[acao]?.app;
  const doApp = app === undefined ? [] : (GATILHOS_DO_APP[app] ?? []);
  return kinds.some((k) => doApp.includes(k));
}
