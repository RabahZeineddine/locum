/** O que a busca sabe de uma conexão: onde procurar, e se já está ligada. */
export interface ItemDeBusca {
  id: string;
  /** Aparece em "Suas conexões"; as demais só no catálogo. */
  ligada: boolean;
  /** Nome, descrição, origem e ferramentas conhecidas. */
  textos: readonly string[];
}

function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Filtra por termo: cada palavra tem de aparecer em algum campo. As ligadas
 * vão para `suas` e o resto para `catalogo`, para quem procura "github" achar
 * a conexão que existe ou, não havendo, o item para adicionar. Sem termo,
 * só as ligadas.
 */
export function buscarConexoes(itens: readonly ItemDeBusca[], termo: string): { suas: string[]; catalogo: string[] } {
  const palavras = normalizar(termo).split(/\s+/).filter((p) => p !== "");
  const suas: string[] = [];
  const catalogo: string[] = [];
  for (const item of itens) {
    if (palavras.length === 0) {
      if (item.ligada) suas.push(item.id);
      continue;
    }
    const campos = item.textos.map(normalizar);
    if (!palavras.every((p) => campos.some((c) => c.includes(p)))) continue;
    (item.ligada ? suas : catalogo).push(item.id);
  }
  return { suas, catalogo };
}
