import { BRIDGE_GLOBAL } from "../../electron/bridge-contract.js";

interface PonteDoMenu {
  menu: { onNavegar: (ouvinte: (rota: string) => void) => () => void };
}

/** Assina o pedido de rota do menu da aplicação. Canal fixo no preload. */
export function assinarNavegacaoDoMenu(ouvinte: (rota: string) => void): () => void {
  const ponte = (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL] as PonteDoMenu | undefined;
  return ponte?.menu?.onNavegar?.(ouvinte) ?? (() => undefined);
}
