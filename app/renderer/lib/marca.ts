import { conexaoDoServidor } from "../../src/services/conexao-catalogo";

/** O que a tela precisa para desenhar o ícone de uma conexão ou servidor. */
export interface MarcaDaConexao {
  /** Chave em `renderer/src/marcas.ts`, ou nula quando o pacote não tem a logo. */
  chave: string | null;
  /** Glifo genérico para a marca conhecida que o pacote não publica. */
  glifo: "slack" | "teams" | null;
  /** Cor de fundo, sem #. */
  cor: string;
  /** Letra para o ícone sem logo nem glifo. */
  inicial: string;
}

export interface FonteDaMarca {
  name: string;
  url?: string | undefined;
  command?: readonly string[] | undefined;
}

interface Conhecida {
  chave: string | null;
  cor: string;
  /** Pedaços do nome, do host ou do comando que identificam a marca. */
  pistas: readonly string[];
}

/**
 * Marcas de casa que não são do catálogo. `chave` nula é marca conhecida sem
 * logo no pacote: a cor é a dela, e o ícone é a inicial.
 */
const CONHECIDAS: readonly Conhecida[] = [
  { chave: "argo", cor: "EF7B4D", pistas: ["argocd", "argo-cd"] },
  { chave: "datagrip", cor: "000000", pistas: ["datagrip"] },
  { chave: "jetbrains", cor: "000000", pistas: ["jetbrains", "intellij", "idea", "pycharm", "webstorm", "goland"] },
  { chave: null, cor: "0F766E", pistas: ["context7"] },
  { chave: null, cor: "2563EB", pistas: ["waroom"] },
  { chave: null, cor: "7C3AED", pistas: ["qulture"] },
];

/** Cores escuras o bastante para o glifo branco, para marca desconhecida. */
const PALETA = ["334155", "0E7490", "4D7C0F", "A16207", "B45309", "BE123C", "7E22CE", "4338CA", "0F766E", "9F1239"] as const;

function inicialDe(nome: string): string {
  return (nome.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
}

/** Cor estável por nome: o mesmo servidor tem a mesma cor em toda tela e em toda sessão. */
function corEstavel(nome: string): string {
  let h = 0;
  for (const c of nome.toLowerCase()) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  return PALETA[h % PALETA.length]!;
}

/**
 * A marca de uma conexão, pelo nome, pelo host do endereço ou pelo pacote do
 * comando. O catálogo manda; depois as marcas de casa; sem nenhuma, a inicial
 * com cor estável.
 */
export function marcaDoServidor(fonte: FonteDaMarca): MarcaDaConexao {
  const inicial = inicialDe(fonte.name);
  const item = conexaoDoServidor({
    name: fonte.name,
    ...(fonte.url === undefined ? {} : { url: fonte.url }),
    ...(fonte.command === undefined ? {} : { command: [...fonte.command] }),
  });
  if (item !== undefined) {
    const glifo = item.id === "slack" ? "slack" : item.id === "teams" ? "teams" : null;
    return { chave: item.logo, glifo: item.logo === null ? glifo : null, cor: item.color, inicial };
  }
  const palheiro = [fonte.name, hostDe(fonte.url), ...(fonte.command ?? [])].join(" ").toLowerCase();
  const conhecida = CONHECIDAS.find((m) => m.pistas.some((p) => palheiro.includes(p)));
  if (conhecida !== undefined) return { chave: conhecida.chave, glifo: null, cor: conhecida.cor, inicial };
  return { chave: null, glifo: null, cor: corEstavel(fonte.name), inicial };
}

function hostDe(url: string | undefined): string {
  if (url === undefined) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
