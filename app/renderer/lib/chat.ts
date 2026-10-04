import { BRIDGE_GLOBAL } from "../../electron/bridge-contract.js";

/** O mesmo formato que `electron/chat.ts` emite, com a conversa a que pertence. */
export type ChatEvent = (
  | { tipo: "texto"; delta: string }
  | { tipo: "ferramenta"; nome: string; entrada: unknown }
  | { tipo: "resultado"; nome: string }
  | { tipo: "fim"; motivo: string }
  | { tipo: "resumido" }
  | { tipo: "erro"; mensagem: string }
) & { chave: string };

interface PonteDeChat {
  chat: { onEvent: (ouvinte: (evento: ChatEvent) => void) => () => void };
}

/**
 * Assina o fluxo do assistente.
 *
 * Fica fora de `lib/bridge.ts` porque nao e chamada com resposta, e o canal e
 * fixo no preload: a janela nao escolhe o que escutar.
 */
export function assinarEventosDoChat(ouvinte: (evento: ChatEvent) => void): () => void {
  const ponte = (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL] as PonteDeChat | undefined;
  return ponte?.chat?.onEvent?.(ouvinte) ?? (() => undefined);
}
