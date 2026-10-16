import type { ArmazemLocal } from "./rascunho-automacao";

/**
 * Cache curto das listas que vêm de rede (canais e chats do Teams). A lista é
 * cara e quase não muda: carrega uma vez, guarda por alguns minutos e só
 * relê no "Atualizar". Mora no `sessionStorage` da janela, então sobrevive a
 * fechar e abrir o painel e some quando a janela fecha.
 */

export const TTL_DA_LISTA_MS = 5 * 60_000;

interface Entrada<T> {
  em: number;
  dados: T;
}

const chaveDe = (chave: string): string => `locum.cache.${chave}`;

/** O que está guardado e ainda vale, ou nulo. */
export function lerDoCache<T>(armazem: ArmazemLocal, chave: string, agora: number, ttlMs: number = TTL_DA_LISTA_MS): T | null {
  try {
    const cru = armazem.getItem(chaveDe(chave));
    if (cru === null) return null;
    const entrada = JSON.parse(cru) as Entrada<T>;
    return typeof entrada.em === "number" && agora - entrada.em < ttlMs ? entrada.dados : null;
  } catch {
    return null;
  }
}

// Duas montagens pedindo a mesma lista juntas esperam a mesma carga.
const emVoo = new Map<string, Promise<unknown>>();

export interface OpcoesDoCache {
  /** Ignora o que está guardado (o botão "Atualizar"). */
  forcar?: boolean;
  agora?: () => number;
  ttlMs?: number;
}

/** A lista do cache, ou a carregada agora (e guardada). Falha não é guardada. */
export async function listaComCache<T>(
  armazem: ArmazemLocal,
  chave: string,
  carregar: () => Promise<T>,
  { forcar = false, agora = Date.now, ttlMs = TTL_DA_LISTA_MS }: OpcoesDoCache = {},
): Promise<T> {
  if (!forcar) {
    const guardada = lerDoCache<T>(armazem, chave, agora(), ttlMs);
    if (guardada !== null) return guardada;
    const andando = emVoo.get(chave);
    if (andando !== undefined) return andando as Promise<T>;
  }
  const carga = carregar().then((dados) => {
    try {
      armazem.setItem(chaveDe(chave), JSON.stringify({ em: agora(), dados } satisfies Entrada<T>));
    } catch {
      // sem armazém, sem cache
    }
    return dados;
  });
  emVoo.set(chave, carga);
  try {
    return await carga;
  } finally {
    if (emVoo.get(chave) === carga) emVoo.delete(chave);
  }
}

/** O índice destacado depois de ↑ (-1) ou ↓ (+1), dando a volta nas pontas. */
export function moverDestaque(atual: number, total: number, passo: 1 | -1): number {
  if (total === 0) return 0;
  return (atual + passo + total) % total;
}
