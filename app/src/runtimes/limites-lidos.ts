/**
 * O modelo único dos limites, por provedor. Cada fonte (assinatura do Claude
 * Code ou do Codex, cabeçalho de rate limit da API, gateway, orçamento local)
 * traduz o que sabe para isto, e quem decide pausar não precisa conhecer a fonte.
 */

export type TipoDeLimite = "janela" | "orcamento" | "taxa";
export type OrigemDoLimite = "assinatura" | "orcamento-local" | "cabecalho-api" | "gateway";

export interface Limite {
  provedor: string;
  conta?: string;
  /** "5h", "semana", "dia", "mes", "rpm", "tpm", "orcamento". */
  chave: string;
  tipo: TipoDeLimite;
  /** De 0 a 1. */
  uso: number;
  usado?: number;
  teto?: number;
  unidade?: "usd" | "tokens" | "req" | "%";
  /** Epoch em segundos. */
  resetaEm?: number;
  origem: OrigemDoLimite;
  /** Epoch em segundos da leitura. */
  quando: number;
}

/** O que a fonte sabe dizer: o provedor, a conta e a hora entram quando a leitura é registrada. */
export type LimiteLido = Omit<Limite, "provedor" | "conta" | "quando">;

type OuvinteDeLimites = (provedor: string, limites: LimiteLido[], quandoMs: number) => void;
type OuvinteDeGasto = (provedor: string, gasto: { usd: number; tokens: number }) => void;
const ouvintes = new Set<OuvinteDeLimites>();
const ouvintesDeGasto = new Set<OuvinteDeGasto>();

/** Quem quer saber de cada leitura: o serviço dos limites se inscreve aqui ao subir. */
export function aoLerLimites(ouvinte: OuvinteDeLimites): () => void {
  ouvintes.add(ouvinte);
  return () => ouvintes.delete(ouvinte);
}

/** Entrega a leitura aos inscritos. Erro de ouvinte não pode derrubar a chamada que gerou a leitura. */
export function publicarLimites(provedor: string, limites: LimiteLido[], quandoMs: number = Date.now()): void {
  if (limites.length === 0) return;
  for (const ouvinte of ouvintes) {
    try {
      ouvinte(provedor, limites, quandoMs);
    } catch {}
  }
}

/** O gasto cobrado de uma chamada de API, para o orçamento local do provedor. */
export function aoGastar(ouvinte: OuvinteDeGasto): () => void {
  ouvintesDeGasto.add(ouvinte);
  return () => ouvintesDeGasto.delete(ouvinte);
}

export function publicarGasto(provedor: string, gasto: { usd: number; tokens: number }): void {
  for (const ouvinte of ouvintesDeGasto) {
    try {
      ouvinte(provedor, gasto);
    } catch {}
  }
}
