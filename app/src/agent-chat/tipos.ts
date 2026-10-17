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
  /** Outro processo do Locum (o app ou o `--mcp`) está com a conversa; `respondendo` já o inclui. */
  outroProcesso: boolean;
  resumido: boolean;
  /** Conexões do agent sem servidor agora: avisa, e não impede de conversar. */
  semServidor: ConexaoSemServidor[];
  /** Skills do agent que não existem mais nesta máquina: avisa, e a execução pelo fluxo é que falha. */
  semSkill: string[];
  /** Quantas ferramentas da conta Claude o agent tem e ficam de fora do chat. */
  contaIgnorada: number;
  /** O `seq` do último evento já refletido nas falas. */
  seq: number;
  /** Só na conversa de um run: o que a tela e o MCP mostram além das falas. */
  run?: DoRunNaConversa;
}

/** O que a conversa de um run diz de si, para a pessoa saber com quem fala e o que o modelo viu. */
export interface DoRunNaConversa {
  /** Quem conversa agora: um agent da biblioteca ou um modelo solto. Nulo quando o run não tem passo de modelo e a pessoa ainda não escolheu. */
  alvo: { tipo: "agent"; id: string } | { tipo: "modelo"; id: string } | null;
  /** Por que não há alvo, no idioma do app. Nulo quando há. */
  motivoSemAlvo: string | null;
  /** O alvo é o padrão (o do primeiro passo de modelo do run) ou foi escolhido. */
  padrao: boolean;
  /** O run é de uma automação arquivada: a conversa só lê. */
  arquivada: boolean;
  /** O contexto inicial passou do teto e perdeu algo: o que ficou de fora. */
  contexto: { teto: number; cortado: string[] };
  /** O que a conversa já gastou. */
  gasto: { usd: number; tokens: number };
  /** Os limites técnicos de uma volta: passos do laço de ferramentas (o `maxSteps` do agent quando ele responde) e o que `ler_run` devolve de uma vez, em caracteres. */
  limites: { passosDaVolta: number; passosDoAgent: boolean; tetoDaLeitura: number };
}

/** A chave da conversa de um agent, a mesma dos eventos e do histórico guardado. */
export const chaveDoAgent = (id: string): string => `agent:${id}`;

/** A chave da conversa de um run. */
export const chaveDoRun = (id: string): string => `run:${id}`;

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
