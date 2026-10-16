import type { Rascunho } from "./automacao";

/**
 * O rascunho local do editor de automação.
 *
 * O editor edita em memória e só grava no "Salvar". Sem isto, uma navegação, um
 * recarregamento ou uma queda da janela perdia a automação inteira. O rascunho
 * é por automação (a chave leva o id), mora no armazém local da janela e some
 * quando a pessoa salva, descarta ou volta ao que está gravado.
 */

/** O pedaço do `Storage` que o rascunho usa; o teste passa um de memória. */
export interface ArmazemLocal {
  getItem(chave: string): string | null;
  setItem(chave: string, valor: string): void;
  removeItem(chave: string): void;
}

export interface RascunhoGuardado {
  rascunho: Rascunho;
  /** A versão gravada sobre a qual a edição começou. */
  versao: number;
  /** Quando foi guardado, em milissegundos. */
  salvoEm: number;
}

/** Há diferença entre o que está na tela e o que está gravado. */
export function temMudanca(rascunho: Rascunho, salvo: Rascunho): boolean {
  return JSON.stringify(rascunho) !== JSON.stringify(salvo);
}

export function chaveDoRascunho(agentId: string): string {
  return `locum.rascunho-automacao.${agentId}`;
}

/**
 * Guarda o rascunho, ou apaga o guardado quando ele voltou a ser igual ao
 * gravado. Armazém cheio ou bloqueado não pode quebrar a edição: o rascunho é
 * rede de segurança, e perdê-lo é o estado de antes.
 */
export function guardarRascunho(
  armazem: ArmazemLocal,
  agentId: string,
  rascunho: Rascunho,
  salvo: Rascunho,
  versao: number,
  agora: number = Date.now(),
): void {
  try {
    if (!temMudanca(rascunho, salvo)) {
      armazem.removeItem(chaveDoRascunho(agentId));
      return;
    }
    const corpo: RascunhoGuardado = { rascunho, versao, salvoEm: agora };
    armazem.setItem(chaveDoRascunho(agentId), JSON.stringify(corpo));
  } catch {
    // sem armazém, sem rascunho
  }
}

/** O rascunho guardado, ou nulo se não há ou se o conteúdo não é um rascunho. */
export function lerRascunho(armazem: ArmazemLocal, agentId: string): RascunhoGuardado | null {
  try {
    const cru = armazem.getItem(chaveDoRascunho(agentId));
    if (cru === null) return null;
    const lido = JSON.parse(cru) as Partial<RascunhoGuardado> | null;
    const r = lido?.rascunho;
    if (r === undefined || r === null || typeof r.spec !== "object" || r.spec === null || !Array.isArray(r.gatilhos)) return null;
    return { rascunho: r, versao: typeof lido?.versao === "number" ? lido.versao : 0, salvoEm: typeof lido?.salvoEm === "number" ? lido.salvoEm : 0 };
  } catch {
    return null;
  }
}

export function descartarRascunho(armazem: ArmazemLocal, agentId: string): void {
  try {
    armazem.removeItem(chaveDoRascunho(agentId));
  } catch {
    // idem
  }
}
