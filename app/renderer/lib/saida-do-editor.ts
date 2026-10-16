/**
 * A confirmação de sair de uma tela com mudança não salva.
 *
 * Todo caminho de navegação da janela (barra lateral, paleta, botões internos)
 * passa por `sairDaTela`. O editor registra uma guarda enquanto está aberto: se
 * há mudança, ela segura a navegação, pergunta, e só chama `prosseguir` depois
 * da decisão. Sem guarda, a navegação segue direto.
 */

/** Devolve verdadeiro quando segurou a saída; nesse caso, quem decide chama `prosseguir`. */
export type Guarda = (prosseguir: () => void) => boolean;

let guarda: Guarda | null = null;

/** Registra a guarda e devolve quem a tira. */
export function registrarGuarda(nova: Guarda): () => void {
  guarda = nova;
  return () => {
    if (guarda === nova) guarda = null;
  };
}

export function sairDaTela(prosseguir: () => void): void {
  if (guarda !== null && guarda(prosseguir)) return;
  prosseguir();
}
