import { createHash } from "node:crypto";

/** O mesmo valor com as chaves em ordem, para a impressão não depender de como o banco as devolveu. */
function ordenado(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(ordenado);
  if (typeof valor === "object" && valor !== null) {
    return Object.fromEntries(
      Object.entries(valor)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, ordenado(v)]),
    );
  }
  return valor;
}

/**
 * A impressão de um conteúdo, como o hash de `accept_mcp_origin`: quem decide
 * manda de volta a que viu, e a decisão só vale se o conteúdo é o mesmo.
 */
export function impressaoDe(valor: unknown): string {
  return createHash("sha256").update(JSON.stringify(ordenado(valor))).digest("hex").slice(0, 16);
}

export function exigirImpressao(esperada: string, atual: string, onde: string): void {
  if (esperada !== atual) {
    throw new Error(`o hash não é o do conteúdo de agora: ${onde} mudou desde a leitura, ou o hash é de outra. Leia de novo e decida sobre o que está lá.`);
  }
}
