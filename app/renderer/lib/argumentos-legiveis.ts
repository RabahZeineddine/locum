export interface LinhaDeArgumento {
  chave: string;
  valor: string;
}

/** As palavras de `null` e de "nada aqui", dadas por quem chama (vêm do i18n). */
export interface RotulosDeVazio {
  nulo: string;
  vazio: string;
}

export interface OpcoesDeArgumentos {
  /** Sem isto, null, "", [] e {} aparecem escritos: no cartão de confirmação o vazio também é efeito da ação. */
  rotulos?: RotulosDeVazio;
  /** Descarta null, "", [] e {} em qualquer nível. Serve para resultado de ferramenta, onde o vazio é ruído. */
  omitirVazios?: boolean;
}

const MAIOR_PROFUNDIDADE = 4;
const ROTULOS_PADRAO: RotulosDeVazio = { nulo: "null", vazio: "" };

type Contexto = Required<Pick<OpcoesDeArgumentos, "rotulos">> & Pick<OpcoesDeArgumentos, "omitirVazios">;

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `chat_id` e `messageText` viram `chat id` e `message text`. */
function emPalavras(chave: string): string {
  return chave
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

/** Duas chaves que virariam o mesmo nome (`chat_id` e `chatId`) ficam como vieram. */
function chaveLegivel(chave: string, todas: [string, unknown][]): string {
  const nome = emPalavras(chave);
  return todas.some(([k]) => k !== chave && emPalavras(k) === nome) ? chave : nome;
}

function semConteudo(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (ehObjeto(v) && Object.keys(v).length === 0);
}

/**
 * Texto que lido sem aspas passaria por outra coisa ganha aspas: número,
 * booleano, nulo, o próprio rótulo de vazio, só espaço, e, dentro de lista ou
 * objeto, vírgula, quebra de linha ou "chave: " que imitariam a estrutura.
 */
function textoComAspas(s: string, profundidade: number, c: Contexto): string {
  const pareceValor = s.trim() !== "" && (Number.isFinite(Number(s)) || s === "true" || s === "false" || s === "null");
  const pareceVazio = s === c.rotulos.nulo || s === c.rotulos.vazio || s.trim() === "" || s.trim() !== s;
  const pareceEstrutura = profundidade > 0 && /[,\n]|: /.test(s);
  return pareceValor || pareceVazio || pareceEstrutura ? JSON.stringify(s) : s;
}

function vazioEscrito(v: unknown, c: Contexto): string {
  return v === null || v === undefined ? c.rotulos.nulo : c.rotulos.vazio;
}

/** Um valor em texto corrido: sem chaves, aspas de JSON nem colchetes. */
function texto(v: unknown, profundidade: number, c: Contexto): string {
  if (semConteudo(v)) return vazioEscrito(v, c);
  if (typeof v === "string") return textoComAspas(v, profundidade, c);
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (profundidade >= MAIOR_PROFUNDIDADE) return JSON.stringify(v) ?? "";
  if (Array.isArray(v)) {
    const itens = (c.omitirVazios === true ? v.filter((x) => !semConteudo(x)) : v).map((x) => texto(x, profundidade + 1, c));
    // Itens simples ficam numa linha; itens compostos, um por linha.
    return v.some((x) => typeof x === "object" && x !== null) ? itens.join("\n") : itens.join(", ");
  }
  if (ehObjeto(v)) {
    const partes = (c.omitirVazios === true ? Object.entries(v).filter(([, x]) => !semConteudo(x)) : Object.entries(v)).map(
      ([k, x], _, todas) => `${chaveLegivel(k, todas)}: ${texto(x, profundidade + 1, c)}`,
    );
    // Dentro de lista o objeto cabe numa linha; no topo, uma chave por linha.
    return profundidade === 1 ? partes.join(", ") : partes.join("\n");
  }
  return "";
}

/**
 * Os argumentos de uma chamada de ferramenta como linhas legíveis, para o
 * cartão de escrita mostrar o que vai sair sem JSON cru. O vazio aparece
 * escrito (null, "", [] e {} mudam o que a ação faz); `omitirVazios` o tira.
 */
export function argumentosLegiveis(argumentos: unknown, opcoes: OpcoesDeArgumentos = {}): LinhaDeArgumento[] {
  const c: Contexto = { rotulos: opcoes.rotulos ?? ROTULOS_PADRAO, omitirVazios: opcoes.omitirVazios };
  if (!ehObjeto(argumentos)) {
    if (argumentos === null || argumentos === undefined) return [];
    if (c.omitirVazios === true && semConteudo(argumentos)) return [];
    return [{ chave: "", valor: texto(argumentos, 0, c) }];
  }
  return Object.entries(argumentos)
    .filter(([, v]) => c.omitirVazios !== true || !semConteudo(v))
    .map(([chave, v], _, todas) => ({ chave: chaveLegivel(chave, todas), valor: texto(v, 0, c) }));
}
