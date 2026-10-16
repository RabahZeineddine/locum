// Sem dependência de Node: a janela usa o mesmo formato e o mesmo reducer de fala.

/** Uma chamada de escrita à espera do clique, e o que aconteceu com ela depois. */
export interface Cartao {
  /** O id do pedido de aprovação; o clique devolve este id. */
  id: string;
  servidor: string;
  ferramenta: string;
  argumentos: unknown;
  /**
   * `executando`: a pessoa clicou e a ferramenta ainda não respondeu.
   * `expirado`: a conversa foi limpa, interrompida ou o app fechou antes do clique.
   * `incerto`: houve o clique, o processo morreu antes do fim e não se sabe se a escrita saiu.
   */
  estado: "pendente" | "executando" | "executado" | "falhou" | "recusado" | "expirado" | "incerto";
  /** O que a ferramenta devolveu, como texto e cortado, quando já respondeu. */
  resultado?: string;
}

/** Uma fala como a tela mostra, guardada para a conversa voltar ao reabrir. */
export interface FalaDoAgent {
  de: "user" | "assistant";
  texto: string;
  ferramentas: string[];
  cartoes: Cartao[];
}

/**
 * O que o chat mostra enquanto a resposta chega: o mesmo formato do assistente,
 * mais o cartão de escrita e o desfecho dele.
 */
export type EventoDoAgent =
  | { tipo: "texto"; delta: string }
  | { tipo: "ferramenta"; nome: string; entrada: unknown; id?: string }
  | { tipo: "resultado"; nome: string; id?: string; texto?: string; erro?: boolean }
  | { tipo: "fim"; motivo: string }
  | { tipo: "resumido" }
  | { tipo: "erro"; mensagem: string }
  | { tipo: "cartao"; cartao: Cartao }
  | { tipo: "cartao-estado"; id: string; estado: Cartao["estado"]; resultado?: string };

/** Cada evento diz de qual conversa é, e em que ordem veio: a tela descarta o que o retrato já contém. */
export type EventoDaConversa = EventoDoAgent & { chave: string; seq: number };

export interface ConexaoSemServidor {
  connectionId: string;
  motivo: string;
}

/** O retrato da conversa, para a tela reabrir onde parou e escutar o resto. */
export interface EstadoDaConversa {
  falas: FalaDoAgent[];
  /** Há um turno em andamento no processo principal. */
  respondendo: boolean;
  resumido: boolean;
  /** Conexões do agent sem servidor agora: avisa, e não impede de conversar. */
  semServidor: ConexaoSemServidor[];
  /** Quantas ferramentas da conta Claude o agent tem e ficam de fora do chat. */
  contaIgnorada: number;
  /** O `seq` do último evento já refletido nas falas. */
  seq: number;
}

/** A chave da conversa de um agent, a mesma dos eventos e do histórico guardado. */
export const chaveDoAgent = (id: string): string => `agent:${id}`;

/** Aplica um evento na fala do assistente a que ele pertence. */
export function aplicarEvento(fala: FalaDoAgent, evento: EventoDoAgent): FalaDoAgent {
  switch (evento.tipo) {
    case "texto":
      return { ...fala, texto: fala.texto + evento.delta };
    case "ferramenta":
      return { ...fala, ferramentas: [...fala.ferramentas, evento.nome] };
    case "erro":
      return { ...fala, texto: `${fala.texto}\n\n[${evento.mensagem}]` };
    case "cartao":
      return { ...fala, cartoes: [...fala.cartoes, evento.cartao] };
    case "cartao-estado":
      return {
        ...fala,
        cartoes: fala.cartoes.map((c) =>
          c.id === evento.id ? { ...c, estado: evento.estado, ...(evento.resultado === undefined ? {} : { resultado: evento.resultado }) } : c,
        ),
      };
    default:
      return fala;
  }
}
