/**
 * O que a pessoa digita para dizer quais repositórios observar, e a expressão
 * regular que a varredura usa.
 *
 * Quase todo mundo quer um repositório pelo nome, alguns pelo nome, ou todos
 * que começam igual. Para isso basta escrever nomes separados por vírgula, com
 * `*` no lugar de "qualquer coisa": `api-*, portal`. Quem já sabe expressão
 * regular continua podendo escrever uma, e ela passa sem mudança: qualquer
 * caractere que não cabe em nome de repositório (`^`, `$`, `(`, `|`...) marca o
 * texto como expressão.
 */

/** Caracteres que o GitHub aceita em nome de repositório, mais o `*`. */
const NOME = /^[A-Za-z0-9._*-]+$/;

function nomes(texto: string): string[] | null {
  const partes = texto
    .split(/[,\s]+/)
    .map((parte) => parte.trim())
    .filter((parte) => parte !== "");
  return partes.length > 0 && partes.every((parte) => NOME.test(parte)) ? partes : null;
}

function emExpressao(nome: string): string {
  return nome.replace(/\./g, "\\.").replace(/\*/g, ".*");
}

/** O texto digitado na forma que a varredura entende. */
export function padraoDoRepo(texto: string): string {
  const limpo = texto.trim();
  const lista = nomes(limpo);
  if (lista === null) return limpo;
  const alternativas = lista.map(emExpressao);
  return alternativas.length === 1 ? `^${alternativas[0]}$` : `^(${alternativas.join("|")})$`;
}

/** Parte de expressão que saiu de um nome: letras, `\.` e `.*`. */
const PARTE = /^(?:[A-Za-z0-9_-]|\\\.|\.\*)+$/;

/**
 * O caminho de volta, para a lista mostrar `api-*, portal` e não a expressão.
 * Expressão que não saiu de `padraoDoRepo` aparece como foi escrita.
 */
export function nomeDoPadrao(padrao: string): string {
  const casado = /^\^(?:\((.+)\)|([^()|]+))\$$/.exec(padrao);
  if (casado === null) return padrao;
  const partes = (casado[1] ?? casado[2]!).split("|");
  if (!partes.every((parte) => PARTE.test(parte))) return padrao;
  return partes.map((parte) => parte.replace(/\.\*/g, "*").replace(/\\\./g, ".")).join(", ");
}
