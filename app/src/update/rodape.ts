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
 * Sem total declarado pelo servidor vale a `reserva`, o tamanho do manifesto.
 * `null` e não 0: sem total a barra não sabe o quanto falta, e fingir 0% faria
 * um download andando parecer parado.
 */
export function progressoDoDownload(
  recebidos: number,
  declarado: number | null,
  reserva: number | null = null,
): number | null {
  const total = declarado ?? reserva;
  if (total === null || !(total > 0)) return null;
  return Math.min(100, Math.max(0, Math.floor((recebidos / total) * 100)));
}

export function rodapeDaAtualizacao(estado: UpdaterState): RodapeDaAtualizacao {
  const version = estado.available?.version;
  // Versão já baixada continua à mostra mesmo com a atualização desligada
  // depois: a troca ainda acontece quando o Locum fechar, e esconder o link
  // seria surpresa.
  if (estado.phase === "ready" && version !== undefined) return { tipo: "pronta", version };
  // Verificador que não subiu (dev, desligado, bundle intocável) não tem fase
  // que valha mostrar. Falha também fica de fora: a Configuração explica.
  if (estado.reason !== null) return { tipo: "versao" };
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

/** A versão para a qual o modal deve estar aberto, ou `null`. A dispensa vem no estado, guardada no processo principal. */
export function versaoParaOModal(estado: UpdaterState): string | null {
  const rodape = rodapeDaAtualizacao(estado);
  if (rodape.tipo !== "pronta" || rodape.version === estado.dismissedVersion) return null;
  return rodape.version;
}
