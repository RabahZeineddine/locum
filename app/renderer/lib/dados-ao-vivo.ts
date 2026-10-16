import { invalidateReads } from "./bridge";
import { criarPorteiroDeAvisos } from "./leitura";

interface PonteDosDados {
  dados: { onMudou: (ouvinte: (areas: string[]) => void) => () => void };
}

/**
 * Liga o aviso `dados:mudou` do processo principal às leituras abertas: o que
 * mudou no banco (nesta tela, em outra, no scheduler ou no `Locum --mcp`)
 * relê sozinho. Janela escondida espera voltar o foco. Devolve quem desliga.
 */
export function assinarMudancasDosDados(): () => void {
  const ponte = (globalThis as Record<string, unknown>)["locum"] as PonteDosDados | undefined;
  const porteiro = criarPorteiroDeAvisos(
    () => typeof document === "undefined" || document.visibilityState === "visible",
    () => invalidateReads(),
  );
  const desassinar = ponte?.dados?.onMudou?.(() => porteiro.avisar());
  const voltou = (): void => porteiro.voltou();
  document.addEventListener("visibilitychange", voltou);
  window.addEventListener("focus", voltou);
  return () => {
    desassinar?.();
    document.removeEventListener("visibilitychange", voltou);
    window.removeEventListener("focus", voltou);
  };
}
