/** A opção do combobox: o mesmo formato de `OpcaoDoCombobox`, sem importar o componente. */
export interface OpcaoDeCanal {
  id: string;
  rotulo: string;
  detalhe?: string;
}

export interface CanalDoSlackListado {
  id: string;
  name: string;
  isPrivate: boolean;
}

/**
 * As opções do combobox: busca por nome ou por id, marcados no topo e o resto
 * em ordem alfabética. Canal privado leva o detalhe.
 */
export function opcoesDeCanaisDoSlack(
  lista: readonly CanalDoSlackListado[],
  marcados: ReadonlySet<string>,
  termo: string,
  rotulos: { privado: string },
): OpcaoDeCanal[] {
  const t = termo.trim().toLowerCase();
  const achados = t === "" ? lista : lista.filter((c) => c.name.toLowerCase().includes(t) || c.id.toLowerCase().includes(t));
  const marcado = (c: CanalDoSlackListado): number => (marcados.has(c.id) ? 0 : 1);
  return [...achados]
    .sort((a, b) => marcado(a) - marcado(b) || a.name.localeCompare(b.name))
    .map((c) => ({ id: c.id, rotulo: `#${c.name}`, ...(c.isPrivate ? { detalhe: rotulos.privado } : {}) }));
}

/**
 * O que foi digitado na busca, se for um id de canal que a lista não tem
 * (canal fora da lista, ou lista que não carregou). Nulo quando não é id ou
 * já está na lista.
 */
export function canalDoSlackDigitado(busca: string, lista: readonly CanalDoSlackListado[]): string | null {
  const id = busca.trim().toUpperCase();
  if (!/^[CG][A-Z0-9]{6,}$/.test(id)) return null;
  return lista.some((c) => c.id === id) ? null : id;
}
