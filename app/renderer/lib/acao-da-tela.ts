import { useEffect } from "react";

/** O que a paleta pede a uma tela que ainda pode não estar montada. */
export type AcaoDaTela = "adicionar-conexao";

const EVENTO = "locum:acao-da-tela";
let pendente: AcaoDaTela | null = null;

/**
 * Pede uma ação a uma tela. Se a tela já está no ar, o evento chega; se ela
 * ainda vai montar (a paleta navegou agora), o pedido fica guardado e a tela o
 * consome ao montar.
 */
export function pedirAcaoDaTela(acao: AcaoDaTela): void {
  pendente = acao;
  globalThis.dispatchEvent(new CustomEvent(EVENTO, { detail: acao }));
}

/** A tela declara que sabe fazer `acao`: vale o pedido guardado e os próximos. */
export function useAcaoDaTela(acao: AcaoDaTela, fazer: () => void): void {
  useEffect(() => {
    const atender = (): void => {
      if (pendente !== acao) return;
      pendente = null;
      fazer();
    };
    atender();
    const ouvir = (evento: Event): void => {
      if ((evento as CustomEvent<AcaoDaTela>).detail === acao) atender();
    };
    globalThis.addEventListener(EVENTO, ouvir);
    return () => globalThis.removeEventListener(EVENTO, ouvir);
    // `fazer` troca a cada render; o que vale é a tela montada.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acao]);
}
