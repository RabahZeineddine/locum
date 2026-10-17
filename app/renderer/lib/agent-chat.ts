import { BRIDGE_GLOBAL } from "../../electron/bridge-contract.js";
import { chaveDoAgent, chaveDoRun, type AlvoDaConversa, type EstadoDaConversa, type EventoDaConversa } from "../../src/agent-chat/tipos.js";

/**
 * Acesso estreito ao chat do agent, fora do catálogo de `lib/bridge.ts`.
 *
 * O clique do cartão (`decidir`) é uma ação de pessoa, como `approvals.decide`:
 * entrar no catálogo que o assistente e qualquer hook de leitura enxergam
 * seria deixar a escrita ao alcance do que não é um clique.
 */
interface PonteDoChatDoAgent {
  agentChat: {
    state: (id: string) => Promise<EstadoDaConversa>;
    send: (id: string, texto: string) => Promise<void>;
    decide: (id: string, cartao: string, decisao: "executar" | "recusar") => Promise<void>;
    cancel: (id: string) => Promise<void>;
    reset: (id: string) => Promise<void>;
    take: (id: string) => Promise<void>;
  };
  runChat: {
    state: (id: string) => Promise<EstadoDaConversa>;
    send: (id: string, texto: string) => Promise<void>;
    cancel: (id: string) => Promise<void>;
    reset: (id: string) => Promise<void>;
    take: (id: string) => Promise<void>;
    setModel: (id: string, alvo: AlvoDaConversa | null) => Promise<void>;
  };
  chat: { onEvent: (ouvinte: (evento: EventoDaConversa) => void) => () => void };
}

function ponte(): PonteDoChatDoAgent {
  const achada = (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL] as PonteDoChatDoAgent | undefined;
  if (!achada?.agentChat) throw new Error("ponte indisponivel");
  return achada;
}

/** O que o hook da conversa precisa de uma conversa, seja de agent ou de run: a chave do fluxo e as cinco operações em comum. */
export interface ChatPorChave {
  /** A chave dos eventos do fluxo desta conversa (`agent:<id>`, `run:<id>`). */
  chave: (id: string) => string;
  estado: (id: string) => Promise<EstadoDaConversa>;
  enviar: (id: string, texto: string) => Promise<void>;
  cancelar: (id: string) => Promise<void>;
  limpar: (id: string) => Promise<void>;
  tomar: (id: string) => Promise<void>;
  /** O fluxo de todas as conversas; cada evento diz de qual é. */
  assinar: (ouvinte: (evento: EventoDaConversa) => void) => () => void;
}

/** O fluxo é um só para as duas conversas: o evento diz de qual é pela chave. */
const assinar = (ouvinte: (evento: EventoDaConversa) => void): (() => void) => ponte().chat.onEvent(ouvinte);

export const chatDoAgent: ChatPorChave & { decidir: (id: string, cartao: string, decisao: "executar" | "recusar") => Promise<void> } = {
  chave: chaveDoAgent,
  estado: (id) => ponte().agentChat.state(id),
  enviar: (id, texto) => ponte().agentChat.send(id, texto),
  decidir: (id, cartao, decisao) => ponte().agentChat.decide(id, cartao, decisao),
  cancelar: (id) => ponte().agentChat.cancel(id),
  limpar: (id) => ponte().agentChat.reset(id),
  tomar: (id) => ponte().agentChat.take(id),
  assinar,
};

/** A conversa de um run (ADR 0009): sem cartão, e com a escolha de com quem ela fala. */
export const chatDoRun: ChatPorChave & { definirAlvo: (id: string, alvo: AlvoDaConversa | null) => Promise<void> } = {
  chave: chaveDoRun,
  estado: (id) => ponte().runChat.state(id),
  enviar: (id, texto) => ponte().runChat.send(id, texto),
  cancelar: (id) => ponte().runChat.cancel(id),
  limpar: (id) => ponte().runChat.reset(id),
  tomar: (id) => ponte().runChat.take(id),
  definirAlvo: (id, alvo) => ponte().runChat.setModel(id, alvo),
  assinar,
};
