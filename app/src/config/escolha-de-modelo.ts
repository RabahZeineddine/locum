/** O catálogo de modelos por provedor, como o `providers.allModels` devolve. */
export type CatalogoDeModelos = { provedor: string; modelos: string[]; erro?: string }[];

/** Provedor e modelo escolhidos; vazio até a pessoa escolher. O modelo do template nunca entra aqui. */
export interface Escolha {
  provedor: string;
  modelo: string;
}

export const ESCOLHA_VAZIA: Escolha = { provedor: "", modelo: "" };

/** Só os provedores desta máquina que de fato têm modelo para escolher. */
export function provedoresDisponiveis(catalogo: CatalogoDeModelos): CatalogoDeModelos {
  return catalogo.filter((c) => c.modelos.length > 0);
}

/** Provedor novo zera o modelo: nada cai no primeiro da lista. */
export function trocarProvedor(_atual: Escolha, provedor: string): Escolha {
  return { provedor, modelo: "" };
}

/** A escolha só vale com provedor disponível e um modelo que ele lista. */
export function escolhaCompleta(escolha: Escolha, catalogo: CatalogoDeModelos): boolean {
  return provedoresDisponiveis(catalogo).some(
    (c) => c.provedor === escolha.provedor && c.modelos.includes(escolha.modelo),
  );
}

/**
 * O que vai ao `agents.importTemplate`: `provedor/modelo` de cada passo de
 * modelo, a escolha geral ou, com `porPasso`, a de cada um. `null` enquanto
 * algum passo estiver incompleto, e instalar fica desabilitado.
 */
export function montarSubstituicoes(
  indices: number[],
  geral: Escolha,
  porPasso: Record<number, Escolha> | null,
  catalogo: CatalogoDeModelos,
): Record<number, string> | null {
  const resultado: Record<number, string> = {};
  for (const indice of indices) {
    const escolha = porPasso === null ? geral : (porPasso[indice] ?? ESCOLHA_VAZIA);
    if (!escolhaCompleta(escolha, catalogo)) return null;
    resultado[indice] = `${escolha.provedor}/${escolha.modelo}`;
  }
  return resultado;
}

/**
 * Confere as substituições contra o catálogo e os passos do spec: cada índice
 * tem de ser de um passo de modelo, e a escolha de um provedor disponível com
 * um modelo que ele lista. Erro claro, nunca descarte em silêncio.
 */
export function validarSubstituicoes(
  passos: { model?: unknown }[],
  substituicoes: Record<number, string>,
  catalogo: CatalogoDeModelos,
): void {
  for (const [chave, escolhido] of Object.entries(substituicoes)) {
    const indice = Number(chave);
    const passo = Number.isInteger(indice) ? passos[indice] : undefined;
    if (passo === undefined) throw new Error(`o template não tem o passo ${chave}`);
    if (typeof passo.model !== "string") throw new Error(`o passo ${chave} do template não escolhe modelo`);
    const barra = escolhido.indexOf("/");
    const provedor = escolhido.slice(0, barra);
    const modelo = escolhido.slice(barra + 1);
    const doProvedor = barra < 1 ? undefined : provedoresDisponiveis(catalogo).find((c) => c.provedor === provedor);
    if (doProvedor === undefined) throw new Error(`o provedor de "${escolhido}" não está disponível nesta máquina`);
    if (!doProvedor.modelos.includes(modelo)) {
      throw new Error(`o modelo "${modelo}" não está na lista do provedor ${provedor}`);
    }
  }
}
