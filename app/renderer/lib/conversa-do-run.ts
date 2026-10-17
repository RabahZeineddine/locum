import type { AlvoDaConversa, DoRunNaConversa, EstadoDaConversa } from "../../src/agent-chat/tipos";

/**
 * Lógica pura da conversa de um run na tela: a marca de "alterada pela conversa" e o que o
 * retrato do estado permite fazer. Sem React, para o teste não precisar de janela.
 */

/** A hora do dia (hh:mm, 24 horas) de um instante em segundos, no fuso da máquina ou no pedido. */
export function horaDaMarca(segundos: number, idioma: string, fuso?: string): string {
  return new Intl.DateTimeFormat(idioma, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(fuso === undefined ? {} : { timeZone: fuso }) }).format(new Date(segundos * 1000));
}

/** "Alterada pela conversa às hh:mm", ou nada quando a pendência não foi mexida pela conversa. */
export function marcaDaAlteracao(
  t: (chave: string, variaveis?: Record<string, unknown>) => string,
  segundos: number | null | undefined,
  idioma: string,
  fuso?: string,
): string | null {
  if (segundos === null || segundos === undefined) return null;
  return t("inbox.alteradaPelaConversa", { hora: horaDaMarca(segundos, idioma, fuso) });
}

/** O valor de uma opção do seletor de alvo; vazio é o padrão do run. */
export function valorDoSeletor(run: Pick<DoRunNaConversa, "alvo" | "padrao">): string {
  if (run.padrao || run.alvo === null) return "";
  return `${run.alvo.tipo}:${run.alvo.id}`;
}

export function valorDoAlvo(alvo: AlvoDaConversa): string {
  return "agent" in alvo ? `agent:${alvo.agent}` : `modelo:${alvo.modelo}`;
}

/** O alvo que a opção escolhida pede a `runChat.setModel`; nulo volta ao padrão. */
export function alvoDoValor(valor: string): AlvoDaConversa | null {
  const corte = valor.indexOf(":");
  if (corte === -1) return null;
  const id = valor.slice(corte + 1);
  if (id === "") return null;
  const tipo = valor.slice(0, corte);
  if (tipo === "agent") return { agent: id };
  if (tipo === "modelo") return { modelo: id };
  return null;
}

/** O que a aba Conversa deixa fazer, a partir do retrato do estado. */
export interface SituacaoDaConversa {
  /** `sem-alvo`: ninguém para responder. `somente-leitura`: automação arquivada, a conversa só lê. */
  situacao: "sem-alvo" | "somente-leitura" | "conversando";
  podeEnviar: boolean;
  /** Trocar o alvo no meio de uma volta, ou com outro processo na vez, o serviço recusa. */
  podeTrocarAlvo: boolean;
  /** Assumir só faz sentido quando a volta é de outro processo. */
  podeAssumir: boolean;
  cortouContexto: boolean;
}

export function situacaoDaConversa(estado: Pick<EstadoDaConversa, "respondendo" | "outroProcesso" | "run">): SituacaoDaConversa | null {
  const run = estado.run;
  if (run === undefined) return null;
  return {
    situacao: run.alvo === null ? "sem-alvo" : run.arquivada ? "somente-leitura" : "conversando",
    podeEnviar: run.alvo !== null,
    podeTrocarAlvo: !estado.respondendo && !estado.outroProcesso,
    podeAssumir: estado.outroProcesso,
    cortouContexto: run.contexto.cortado.length > 0,
  };
}
