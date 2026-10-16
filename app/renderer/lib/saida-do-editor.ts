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

interface Registro {
  guarda: Guarda;
  nivel: number;
}

const guardas: Registro[] = [];

/**
 * Registra a guarda e devolve quem a tira. O editor é o nível 0; o agent aberto
 * sobre ele num modal é o nível 1: sair da janela pergunta primeiro a dele e
 * depois a do editor, e fechar só o modal pergunta só a dele.
 */
export function registrarGuarda(nova: Guarda, nivel = 0): () => void {
  const registro = { guarda: nova, nivel };
  guardas.push(registro);
  return () => {
    const i = guardas.indexOf(registro);
    if (i >= 0) guardas.splice(i, 1);
  };
}

/** Consulta, do nível mais alto ao `desdeONivel`, as guardas que seguram a saída, uma de cada vez. */
export function sairDaTela(prosseguir: () => void, desdeONivel = 0): void {
  const fila = guardas
    .filter((g) => g.nivel >= desdeONivel)
    .sort((a, b) => b.nivel - a.nivel)
    .map((g) => g.guarda);
  const passo = (i: number): void => {
    if (i >= fila.length) {
      prosseguir();
      return;
    }
    if (!fila[i]!(() => passo(i + 1))) passo(i + 1);
  };
  passo(0);
}

/**
 * Depois de um salvar: com a pergunta de saída aberta, a navegação pendente
 * segue (uma vez) quando salvou. Serve ao "Salvar" da pergunta e ao "salvar por
 * cima" do conflito que apareceu no meio dela.
 */
export function seguirSeSalvou(saida: { prosseguir: () => void } | null, salvou: boolean, limpar: () => void): boolean {
  if (!salvou || saida === null) return false;
  limpar();
  saida.prosseguir();
  return true;
}
