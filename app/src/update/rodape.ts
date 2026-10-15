/**
 * O que o rodapé da barra lateral diz sobre a atualização.
 *
 * Funções puras sobre o `UpdaterState`: a tela só desenha o que daqui sai, e
 * a regra de quando aparece barra, link ou nada fica testável sem janela.
 */
import type { UpdaterState } from "./state.js";

export type RodapeDaAtualizacao =
  | { tipo: "versao" }
  | { tipo: "procurando" }
  | { tipo: "baixando"; version: string; percent: number | null }
  | { tipo: "pronta"; version: string };

/**
 * Porcentagem inteira entre 0 e 100, ou `null` quando não há total conhecido.
 *
 * `null` e não 0: sem total a barra não sabe o quanto falta, e fingir 0% faria
 * um download andando parecer parado.
 */
export function progressoDoDownload(recebidos: number, total: number | null): number | null {
  if (total === null || !(total > 0)) return null;
  return Math.min(100, Math.max(0, Math.floor((recebidos / total) * 100)));
}

export function rodapeDaAtualizacao(estado: UpdaterState): RodapeDaAtualizacao {
  // Verificador que não subiu (dev, desligado, bundle intocável) não tem fase
  // que valha mostrar. Falha também fica de fora: a Configuração explica.
  if (estado.reason !== null) return { tipo: "versao" };
  const version = estado.available?.version;
  switch (estado.phase) {
    case "checking":
      return { tipo: "procurando" };
    case "downloading":
      return version === undefined ? { tipo: "procurando" } : { tipo: "baixando", version, percent: estado.progress };
    case "ready":
      return version === undefined ? { tipo: "versao" } : { tipo: "pronta", version };
    default:
      return { tipo: "versao" };
  }
}

/** A versão para a qual o modal deve estar aberto, ou `null`. */
export function versaoParaOModal(estado: UpdaterState, dispensada: string | null): string | null {
  const rodape = rodapeDaAtualizacao(estado);
  if (rodape.tipo !== "pronta" || rodape.version === dispensada) return null;
  return rodape.version;
}
