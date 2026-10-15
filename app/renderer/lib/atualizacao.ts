import { useEffect, useState } from "react";
import { BRIDGE_GLOBAL } from "../../electron/bridge-contract.js";
import type { UpdaterState } from "../../src/update/state.js";
import { read } from "./bridge";

interface PonteDeAtualizacao {
  updates: { onEvent: (ouvinte: (estado: UpdaterState) => void) => () => void };
}

/** Assina o estado da atualização que o processo principal empurra. Canal fixo no preload. */
export function assinarEventosDaAtualizacao(ouvinte: (estado: UpdaterState) => void): () => void {
  const ponte = (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL] as PonteDeAtualizacao | undefined;
  return ponte?.updates?.onEvent?.(ouvinte) ?? (() => undefined);
}

/**
 * O estado da atualização, vivo: lê uma vez ao montar e depois segue o que o
 * processo principal empurra, sem sondar. O segundo item grava um estado que
 * voltou de uma chamada (conferir, ligar), que chega antes do empurrão.
 */
export function useAtualizacao(): [UpdaterState | undefined, (estado: UpdaterState) => void] {
  const [estado, setEstado] = useState<UpdaterState>();

  useEffect(() => {
    let vivo = true;
    // Um empurrão que chega antes da leitura vale mais que ela.
    let empurrado = false;
    const parar = assinarEventosDaAtualizacao((novo) => {
      empurrado = true;
      if (vivo) setEstado(novo);
    });
    read("updates.state").then(
      (lido) => {
        if (vivo && !empurrado) setEstado(lido);
      },
      () => undefined,
    );
    return () => {
      vivo = false;
      parar();
    };
  }, []);

  return [estado, setEstado];
}
