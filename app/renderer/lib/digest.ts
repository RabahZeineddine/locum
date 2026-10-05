/**
 * O digest lido de qualquer um dos dois formatos gravados: a saída do passo
 * (`DigestReading`) e a pendência na Fila (`DigestProposal`), ambos em
 * `src/digest/proposal.ts`. Fica fora da tela para ser testável sem ela.
 */

export type Classe = "needs_reply" | "info" | "ignore";
export type Item = { channel: string; subject: string; kind: Classe; summary: string };
export type Digest = { headline: string; items: Item[] };

export const ORDEM: Classe[] = ["needs_reply", "info", "ignore"];

function item(x: unknown, canal?: string): Item | null {
  if (x === null || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const channel = typeof o.channel === "string" ? o.channel : canal;
  if (typeof channel !== "string" || typeof o.subject !== "string" || typeof o.summary !== "string") return null;
  const kind = ORDEM.includes(o.kind as Classe) ? (o.kind as Classe) : "info";
  return { channel, subject: o.subject, kind, summary: o.summary };
}

/** Aceita a saída do passo (`items`) e a pendência (`channels`); o resto volta nulo. */
export function lerDigest(valor: unknown): Digest | null {
  if (valor === null || typeof valor !== "object") return null;
  const o = valor as Record<string, unknown>;
  if (typeof o.headline !== "string") return null;
  let itens: (Item | null)[] = [];
  if (Array.isArray(o.items)) itens = o.items.map((x) => item(x));
  else if (Array.isArray(o.channels)) {
    itens = o.channels.flatMap((c) => {
      const canal = (c ?? {}) as { channel?: unknown; items?: unknown };
      return Array.isArray(canal.items)
        ? canal.items.map((x) => item(x, typeof canal.channel === "string" ? canal.channel : undefined))
        : [];
    });
  }
  const validos = itens.filter((x): x is Item => x !== null);
  return validos.length > 0 ? { headline: o.headline, items: validos } : null;
}

/**
 * A primeira linha do resumo é o que se lê na lista; o resto é detalhe. Resumo
 * antigo, escrito num parágrafo só, parte na primeira frase.
 */
export function partirResumo(resumo: string): { valor: string; detalhe: string } {
  const texto = resumo.trim();
  const quebra = texto.indexOf("\n");
  if (quebra >= 0) return { valor: texto.slice(0, quebra).trim(), detalhe: texto.slice(quebra + 1).trim() };
  if (texto.length <= 140) return { valor: texto, detalhe: "" };
  const ponto = texto.search(/\.\s/);
  if (ponto > 0 && ponto < 200) return { valor: texto.slice(0, ponto + 1), detalhe: texto.slice(ponto + 2).trim() };
  return { valor: texto, detalhe: "" };
}
