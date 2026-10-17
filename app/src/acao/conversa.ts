import { exigirDestino, type DestinoDaAcao } from "./destino.js";

// O adaptador e o resolvedor não tocam em rede: quem escreve é o handler da ação.

/** Onde o evento diz que a conversa está, e a mensagem dentro dela quando há. */
export interface EnderecoDeConversa {
  /** A conversa (chat, canal), no formato opaco do app. */
  conversa: string;
  /** A mensagem ou o fio a que se responde, ou nulo quando o app não tem fio ali. */
  mensagem: string | null;
  /** A conta do app por onde o evento chegou, para apps com mais de uma. */
  conta?: string | null;
}

/**
 * O que um app de conversa fornece para responder e reagir sem que o resto do
 * Locum conheça o app. App novo funciona implementando só isto e entrando em
 * `ACOES_DE_CONVERSA_REGISTRO`.
 */
export interface AdaptadorDeConversa {
  app: string;
  /** O endereço que o evento declara; estoura se o evento não é desse app. */
  enderecoDoEvento(payload: unknown): EnderecoDeConversa;
  /** Confere um `ref` escolhido pela pessoa; estoura se não for desse app. */
  validarRef(ref: string): void;
  /** O `ref` em palavras, para a Fila: é o que o app entende, e não o nome que a tela gravou. */
  descreverRef(ref: string): string;
}

/** O alvo já resolvido: o handler só traduz isto para a chamada do app. */
export interface AlvoResolvido {
  tipo: DestinoDaAcao["tipo"];
  conversa: string;
  /** Presente só quando a resposta vai no fio da mensagem do evento. */
  mensagem: string | null;
  /** A conversa fixa em palavras, como o adaptador a descreve a partir do `ref`; o rótulo gravado no passo não entra. */
  rotulo: string | null;
  /** A conta por onde sair: a escolhida no destino fixo, ou a do evento. */
  conta: string | null;
}

/**
 * Resolve o destino de uma ação de conversa, igual para todo app.
 *
 * `evento` e `novo` pedem o endereço ao evento; `fixo` não precisa de evento
 * nenhum, e por isso funciona também num gatilho manual ou num ensaio.
 */
export function resolverDestino(adaptador: AdaptadorDeConversa, acao: string, cru: unknown, payload: unknown): AlvoResolvido {
  const destino = exigirDestino(acao, cru);
  if (destino.tipo === "fixo") {
    adaptador.validarRef(destino.conversa.ref);
    return {
      tipo: "fixo",
      conversa: destino.conversa.ref,
      mensagem: null,
      rotulo: adaptador.descreverRef(destino.conversa.ref),
      conta: destino.conversa.conta ?? null,
    };
  }
  const endereco = adaptador.enderecoDoEvento(payload);
  return {
    tipo: destino.tipo,
    conversa: endereco.conversa,
    mensagem: destino.tipo === "evento" ? endereco.mensagem : null,
    rotulo: null,
    conta: endereco.conta ?? null,
  };
}
