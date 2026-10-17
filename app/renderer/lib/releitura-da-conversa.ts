import type { MarcaDaConversa } from "../../src/agent-chat/tipos";

/**
 * Quando a releitura periódica da conversa vale pedir o estado inteiro (que monta o contexto do run
 * e as ferramentas do agent), em vez de ficar só na marca leve. Pura, para o teste não precisar de janela.
 */
export function precisaRelerEstado(a: { marca: MarcaDaConversa; anterior: MarcaDaConversa | null; outroProcesso: boolean }): boolean {
  if (a.anterior === null) return true;
  if (a.marca.versao !== a.anterior.versao || a.marca.ocupada !== a.anterior.ocupada) return true;
  // Com outro processo na vez, segue lendo: a tela volta ao normal sozinha quando ele decide ou morre.
  return a.marca.ocupada && a.outroProcesso;
}
