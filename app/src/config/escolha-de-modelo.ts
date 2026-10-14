/** O catálogo de modelos por provedor, como o `providers.allModels` devolve. */
export type CatalogoDeModelos = { provedor: string; modelos: string[]; erro?: string }[];

/** Só os provedores desta máquina que de fato têm modelo para escolher. */
export function provedoresDisponiveis(catalogo: CatalogoDeModelos): CatalogoDeModelos {
  return catalogo.filter((c) => c.modelos.length > 0);
}

/**
 * O modelo inicial de um passo de template: o do próprio template se o
 * provedor dele existe nesta máquina (e o modelo, se o provedor o lista);
 * senão o primeiro modelo do primeiro provedor. `null` sem provedor nenhum.
 */
export function modeloInicial(original: string, catalogo: CatalogoDeModelos): string | null {
  const disponiveis = provedoresDisponiveis(catalogo);
  const barra = original.indexOf("/");
  const provedor = original.slice(0, barra);
  const modelo = original.slice(barra + 1);
  const doProvedor = barra < 0 ? undefined : disponiveis.find((c) => c.provedor === provedor);
  if (doProvedor !== undefined) {
    return doProvedor.modelos.includes(modelo) ? original : `${doProvedor.provedor}/${doProvedor.modelos[0]}`;
  }
  const primeiro = disponiveis[0];
  return primeiro === undefined ? null : `${primeiro.provedor}/${primeiro.modelos[0]}`;
}

/** Separa `provedor/modelo` no primeiro `/`. */
export function partirModelo(id: string): { provedor: string; modelo: string } {
  const barra = id.indexOf("/");
  return barra < 0 ? { provedor: "", modelo: id } : { provedor: id.slice(0, barra), modelo: id.slice(barra + 1) };
}
