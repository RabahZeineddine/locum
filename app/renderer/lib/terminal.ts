import { BRIDGE_GLOBAL } from "../../electron/bridge-contract.js";

/** O mesmo formato que `electron/terminal.ts` manda para a janela. */
export type TerminalEvent =
  | { id: string; tipo: "dados"; dados: string }
  | { id: string; tipo: "fim"; codigo: number }
  | { id: string; tipo: "aberto"; iniciativa: string | null; titulo: string };

interface PonteDeTerminal {
  terminal: { onEvent: (ouvinte: (evento: TerminalEvent) => void) => () => void };
}

/** Assina a saída dos terminais embutidos. Canal fixo no preload, como o do chat. */
export function assinarEventosDoTerminal(ouvinte: (evento: TerminalEvent) => void): () => void {
  const ponte = (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL] as PonteDeTerminal | undefined;
  return ponte?.terminal?.onEvent?.(ouvinte) ?? (() => undefined);
}
