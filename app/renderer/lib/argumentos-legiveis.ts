export interface LinhaDeArgumento {
  chave: string;
  valor: string;
}

const MAIOR_PROFUNDIDADE = 4;

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

function vazio(v: unknown): boolean {
  return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
}

/** Um valor em texto corrido: sem chaves, aspas nem colchetes de JSON. */
function texto(v: unknown, profundidade: number): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (profundidade >= MAIOR_PROFUNDIDADE) return JSON.stringify(v) ?? "";
  if (Array.isArray(v)) {
    const itens = v.filter((x) => !vazio(x)).map((x) => texto(x, profundidade + 1));
    // Itens simples ficam numa linha; itens compostos, um por linha.
    return v.some((x) => typeof x === "object" && x !== null) ? itens.join("\n") : itens.join(", ");
  }
  if (ehObjeto(v)) {
    const partes = Object.entries(v)
      .filter(([, x]) => !vazio(x))
      .map(([k, x]) => `${emPalavras(k)}: ${texto(x, profundidade + 1)}`);
    // Dentro de lista o objeto cabe numa linha; no topo, uma chave por linha.
    return profundidade === 1 ? partes.join(", ") : partes.join("\n");
  }
  return "";
}

/**
 * Os argumentos de uma chamada de ferramenta como linhas legíveis, para o
 * cartão de escrita mostrar o que vai sair sem JSON cru. Chave sem valor some.
 */
export function argumentosLegiveis(argumentos: unknown): LinhaDeArgumento[] {
  if (vazio(argumentos)) return [];
  if (!ehObjeto(argumentos)) return [{ chave: "", valor: texto(argumentos, 0) }];
  return Object.entries(argumentos)
    .filter(([, v]) => !vazio(v))
    .map(([chave, v]) => ({ chave: emPalavras(chave), valor: texto(v, 0) }));
}
