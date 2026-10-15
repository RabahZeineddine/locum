import { BRIDGE_GLOBAL } from "../../electron/bridge-contract.js";
import type { EstadoDaConversa, EventoDaConversa } from "../../src/agent-chat/tipos.js";

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
  };
  chat: { onEvent: (ouvinte: (evento: EventoDaConversa) => void) => () => void };
}

function ponte(): PonteDoChatDoAgent {
  const achada = (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL] as PonteDoChatDoAgent | undefined;
  if (!achada?.agentChat) throw new Error("ponte indisponivel");
  return achada;
}

export const chatDoAgent = {
  estado: (id: string) => ponte().agentChat.state(id),
  enviar: (id: string, texto: string) => ponte().agentChat.send(id, texto),
  decidir: (id: string, cartao: string, decisao: "executar" | "recusar") => ponte().agentChat.decide(id, cartao, decisao),
  cancelar: (id: string) => ponte().agentChat.cancel(id),
  limpar: (id: string) => ponte().agentChat.reset(id),
  /** O fluxo de todas as conversas; cada evento diz de qual é. */
  assinar: (ouvinte: (evento: EventoDaConversa) => void): (() => void) => ponte().chat.onEvent(ouvinte),
};
