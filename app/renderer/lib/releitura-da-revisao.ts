/**
 * O que a tela de revisão faz quando a pendência é relida com outro conteúdo (a conversa do run
 * ou o MCP a editaram) e quando o autosave pode gravar. Pura, para o teste não precisar de janela.
 */

export type AcaoDaReleitura = "manter" | "recarregar" | "avisar";

/**
 * `conhecidos` são as impressões que esta janela já teve como base. `hashBase` é a impressão do payload com que o estado local foi montado (ou gravado pela última vez
 * por esta janela). Sem edição pendente a tela adota o que veio; com edição, avisa e deixa a pessoa
 * escolher, porque gravar o estado local por cima apagaria a mudança de fora.
 */
export function acaoDaReleitura(a: { hashBase: string | null; hashAtual: string; edicaoPendente: boolean; conhecidos?: readonly string[] }): AcaoDaReleitura {
  // Uma releitura que chega atrasada, com um conteúdo que esta janela já viu ou gravou, não é mudança de fora.
  if (a.hashBase === null || a.hashAtual === a.hashBase || a.conhecidos?.includes(a.hashAtual) === true) return "manter";
  return a.edicaoPendente ? "avisar" : "recarregar";
}

/** O autosave grava o que a pessoa mexeu, e só enquanto não há aviso de mudança de fora pedindo a decisão dela. */
export function devoGravar(a: { edicaoPendente: boolean; avisando: boolean }): boolean {
  return a.edicaoPendente && !a.avisando;
}
