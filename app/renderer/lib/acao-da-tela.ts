import { useEffect } from "react";

/** O que a paleta pede a uma tela que ainda pode não estar montada. */
export type AcaoDaTela = "adicionar-conexao" | "nova-automacao";

/** Passado esse tempo, o pedido de uma tela que não montou é esquecido. */
export const VALIDADE_DO_PEDIDO_MS = 3000;

const EVENTO = "locum:acao-da-tela";
const canal = new EventTarget();
let pendente: { acao: AcaoDaTela; em: number } | null = null;

/**
 * Pede uma ação a uma tela. Se a tela já está no ar, o evento chega; se ela
 * ainda vai montar (a paleta navegou agora), o pedido fica guardado por
 * alguns segundos e a tela o consome ao montar.
 */
export function pedirAcaoDaTela(acao: AcaoDaTela, agora: number = Date.now()): void {
  pendente = { acao, em: agora };
  canal.dispatchEvent(new CustomEvent(EVENTO, { detail: acao }));
}

/** Entrega o pedido guardado uma vez só, e só se for desta ação e ainda valer. */
export function consumirPedido(acao: AcaoDaTela, agora: number = Date.now()): boolean {
  const guardado = pendente;
  if (guardado === null || guardado.acao !== acao) return false;
  pendente = null;
  return agora - guardado.em <= VALIDADE_DO_PEDIDO_MS;
}

/** Atende o pedido guardado e os próximos; devolve o cancelamento da assinatura. */
export function assinarAcaoDaTela(acao: AcaoDaTela, fazer: () => void): () => void {
  const atender = (): void => {
    if (consumirPedido(acao)) fazer();
  };
  atender();
  canal.addEventListener(EVENTO, atender);
  return () => canal.removeEventListener(EVENTO, atender);
}

/** A tela declara que sabe fazer `acao`: vale o pedido guardado e os próximos. */
export function useAcaoDaTela(acao: AcaoDaTela, fazer: () => void): void {
  // `fazer` troca a cada render; o que vale é a tela montada.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => assinarAcaoDaTela(acao, fazer), [acao]);
}
