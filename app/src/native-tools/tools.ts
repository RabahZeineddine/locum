import { clienteHttp } from "../net/http.js";

/**
 * As ferramentas de leitura que o Locum oferece aos agents por conta própria,
 * sem depender de app conectado: ler qualquer endereço e consultar JSON.
 *
 * Só leitura. Mandar dado para fora é nó de ação no fluxo (`http.request`),
 * que passa pela fila; aqui o método é sempre GET.
 */

/** Corpo maior que isto é cortado: o resto só encheria o contexto do modelo. */
export const LIMITE_DO_CORPO = 60_000;

export interface RespostaHttp {
  status: number;
  contentType: string | null;
  /** O corpo já lido como JSON, quando a resposta é JSON. */
  json?: unknown;
  /** O corpo como texto, quando não é JSON. */
  text?: string;
  truncated: boolean;
}

export async function httpGet(
  url: string,
  headers: Record<string, string> = {},
  fetchFn: typeof fetch = clienteHttp,
  caminho?: string,
): Promise<RespostaHttp> {
  let endereco: URL;
  try {
    endereco = new URL(url);
  } catch {
    throw new Error(`endereço inválido: ${url}`);
  }
  if (endereco.protocol !== "http:" && endereco.protocol !== "https:") throw new Error("só http e https");

  const resposta = await fetchFn(endereco.toString(), { method: "GET", headers });
  const contentType = resposta.headers.get("content-type");
  const corpo = await resposta.text();
  // Com caminho, o recorte vem antes do teto: o agent pede só o pedaço que
  // precisa de uma resposta de 75 KB, e o pedaço volta inteiro.
  if (caminho !== undefined && caminho.trim() !== "" && /json/i.test(contentType ?? "")) {
    try {
      const recorte = jsonQuery(JSON.parse(corpo), caminho);
      const texto = JSON.stringify(recorte) ?? "null";
      if (texto.length <= LIMITE_DO_CORPO) return { status: resposta.status, contentType, json: recorte, truncated: false };
      return { status: resposta.status, contentType, text: texto.slice(0, LIMITE_DO_CORPO), truncated: true };
    } catch {
      // Corpo que não fecha como JSON segue o caminho de sempre, como texto.
    }
  }
  const truncated = corpo.length > LIMITE_DO_CORPO;
  const base = { status: resposta.status, contentType, truncated };
  if (!truncated && /json/i.test(contentType ?? "")) {
    try {
      return { ...base, json: JSON.parse(corpo) };
    } catch {
      // Servidor que diz JSON e manda outra coisa: vai como texto.
    }
  }
  return { ...base, text: truncated ? corpo.slice(0, LIMITE_DO_CORPO) : corpo };
}

/**
 * O valor num caminho como `itens[0].nome` ou `a.b.c`. Caminho vazio devolve
 * o JSON inteiro. Texto entra como JSON, com ou sem a cerca que o modelo põe.
 */
export function jsonQuery(entrada: unknown, caminho = ""): unknown {
  let atual: unknown = entrada;
  if (typeof entrada === "string") {
    const m = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(entrada);
    try {
      atual = JSON.parse(m === null ? entrada : m[1]!);
    } catch {
      throw new Error("a entrada não é JSON");
    }
  }
  const partes = caminho
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  for (const parte of partes) {
    if (atual === null || typeof atual !== "object") return null;
    atual = (atual as Record<string, unknown>)[parte];
    if (atual === undefined) return null;
  }
  return atual;
}
