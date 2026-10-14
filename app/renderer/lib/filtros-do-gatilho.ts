import type { PollFilters } from "../../src/config/types";

/**
 * O que a pessoa digita nos campos de lista do gatilho do GitHub, e o filtro
 * que o cadastro guarda. Fica fora do componente para a conversa de ida e
 * volta ter teste: o texto é livre, e o filtro, não.
 */

/** Vírgula, espaço ou quebra de linha separam; item vazio some. */
export function listaDoTexto(texto: string): string[] {
  return texto
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/** Para o que pode ter espaço no nome, como a label `help wanted`: só vírgula e quebra de linha separam. */
export function listaDeNomes(texto: string): string[] {
  return texto
    .split(/[,\n]+/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export function textoDaLista(lista: readonly string[] | undefined): string {
  return (lista ?? []).join(", ");
}

/** Review pedido numa caixa só: `org/slug` é time, o resto é pessoa (ou `@me`). */
export function revisaoDoTexto(texto: string): { users: string[]; teams: string[] } {
  const itens = listaDoTexto(texto);
  return { users: itens.filter((i) => !i.includes("/")), teams: itens.filter((i) => i.includes("/")) };
}

export function revisaoComoTexto(revisao: { users?: string[]; teams?: string[] } | undefined): string {
  return textoDaLista([...(revisao?.users ?? []), ...(revisao?.teams ?? [])]);
}

const cheia = (lista: readonly string[] | undefined): string[] | undefined =>
  lista === undefined || lista.length === 0 ? undefined : [...lista];

/**
 * Tira do filtro o que está vazio. Sem nada sobrando devolve `undefined`, para
 * o gatilho voltar a ser gravado sem `filters`, igual ao de antes do campo.
 */
export function podarFiltros(f: PollFilters): PollFilters | undefined {
  const par = <A extends string, B extends string>(
    valor: Partial<Record<A | B, string[]>> | undefined,
    a: A,
    b: B,
  ) => {
    const x = cheia(valor?.[a]);
    const y = cheia(valor?.[b]);
    return x === undefined && y === undefined
      ? undefined
      : { ...(x === undefined ? {} : { [a]: x }), ...(y === undefined ? {} : { [b]: y }) };
  };

  const limpo: PollFilters = {};
  const authors = par(f.authors, "include", "exclude");
  if (authors) limpo.authors = authors;
  const reviewRequested = par(f.reviewRequested, "users", "teams");
  if (reviewRequested) limpo.reviewRequested = reviewRequested;
  const teamMembers = cheia(f.teamMembers);
  if (teamMembers) limpo.teamMembers = teamMembers;
  const labels = par(f.labels, "include", "exclude");
  if (labels) limpo.labels = labels;
  const baseBranches = cheia(f.baseBranches);
  if (baseBranches) limpo.baseBranches = baseBranches;
  const paths = par(f.paths, "include", "exclude");
  if (paths) limpo.paths = paths;
  if (f.maxChangedLines !== undefined) limpo.maxChangedLines = f.maxChangedLines;
  return Object.keys(limpo).length === 0 ? undefined : limpo;
}
