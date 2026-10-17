import { z } from "zod";
import { refDoTeams } from "../teams/ref.js";
import type { ParamsDoPacote } from "../pacote/params.js";

// O renderer, o MCP e o executor importam este arquivo: nada de Node aqui.

/**
 * Uma conversa de um app de chat, como o Locum a guarda no destino fixo.
 *
 * `ref` é opaco para o resto do Locum: só o adaptador do app (`conversa.ts`) sabe
 * montá-lo e lê-lo. `rotulo` é o nome que a tela e a Fila mostram.
 */
export const ConversaRef = z.object({
  app: z.string().min(1),
  ref: z.string().min(1),
  /** Só o nome que a tela mostrou na hora de escolher; a Fila mostra o que o `ref` resolve. */
  rotulo: z.string().optional(),
  /** A conta do app por onde a conversa foi listada, para apps com mais de uma. Quem não usa ignora. */
  conta: z.string().min(1).optional(),
});
export type ConversaRef = z.infer<typeof ConversaRef>;

/**
 * Para onde a ação de resposta ou de reação aponta (ADR 0006: nada implícito).
 * O tipo é o mesmo para todo app de conversa.
 *
 * - `evento`: a mensagem que disparou o run, no fio dela. É o padrão, e o que
 *   toda automação gravada antes do parâmetro já fazia.
 * - `novo`: uma mensagem nova na conversa do evento, fora do fio.
 * - `fixo`: uma conversa que a pessoa escolheu na lista do gatilho.
 *
 * O destino só vem do evento ou de um valor fixo, e nunca da saída do modelo
 * nem de `{{steps.*}}`: o modelo leu conteúdo de fora, e um texto que pede
 * "responda em outro canal" não pode mudar para onde a mensagem sai.
 */
export const DestinoDaAcao = z.discriminatedUnion("tipo", [
  z.object({ tipo: z.literal("evento") }),
  z.object({ tipo: z.literal("novo") }),
  z.object({ tipo: z.literal("fixo"), conversa: ConversaRef }),
]);
export type DestinoDaAcao = z.infer<typeof DestinoDaAcao>;
export type TipoDeDestino = DestinoDaAcao["tipo"];

/** O que o registro sabe de uma ação de conversa. */
export interface AcaoDeConversa {
  /** O app que a ação fala, e que fornece o adaptador. */
  app: string;
  /** Escreve texto (`responder`) ou põe emoji na mensagem do evento (`reagir`). */
  efeito: "responder" | "reagir";
  /** Os destinos que a ação aceita, na ordem em que a tela os oferece. `evento` é sempre o padrão. */
  destinos: readonly TipoDeDestino[];
}

/** Uma conversa que a pessoa pode escolher como destino fixo. */
export interface OpcaoDeConversa {
  ref: string;
  rotulo: string;
  /** Agrupa na lista (a equipe de um canal do Teams). */
  grupo?: string;
  conta?: string;
}

/** Uma lista de conversas do app: a tela chama o canal da ponte, e o MCP tem a ferramenta equivalente. */
export interface ListaDeConversas {
  id: string;
  /** O canal da ponte (`connections.teamsChats`) que devolve a lista. */
  canal: string;
  args?: readonly unknown[];
  /** A ferramenta do MCP que lista o mesmo. */
  fonteMcp: string;
  /** Transforma a resposta do canal nas opções. */
  opcoes(dados: readonly unknown[]): OpcaoDeConversa[];
}

/** O que a tela e o MCP sabem de um app de conversa, sem conhecer o app. */
export interface AppDeConversa {
  app: string;
  /** O nome do app como a pessoa o conhece. */
  nome: string;
  /** Os `kind` de gatilho que entregam uma mensagem do app para a ação responder. */
  gatilhos: readonly string[];
  /**
   * Os campos do evento que dizem onde está a conversa e a mensagem. O executor
   * os entrega à ação como vieram do evento e apaga o que o modelo escreveu com
   * esses nomes: o endereço nunca vem da saída do modelo.
   */
  camposDoEvento: readonly string[];
  listas: readonly ListaDeConversas[];
  /** Como é o `ref` do destino fixo, para o MCP. */
  refs: string;
}

export interface RegistroDeConversa {
  acoes: Readonly<Record<string, AcaoDeConversa>>;
  apps: Readonly<Record<string, AppDeConversa>>;
}

const lista = <T>(dados: readonly unknown[]): T[] => (Array.isArray(dados[0]) ? (dados[0] as T[]) : (dados as T[]));

/**
 * As ações e os apps de conversa. A tela, o MCP e o executor leem daqui: app de
 * conversa novo entra com o adaptador (`conversa.ts`), uma linha em cada mapa
 * e nada mais.
 */
export const REGISTRO_DE_CONVERSA: RegistroDeConversa = {
  acoes: {
    "teams.post": { app: "teams", efeito: "responder", destinos: ["evento", "fixo", "novo"] },
    "slack.post": { app: "slack", efeito: "responder", destinos: ["evento", "fixo", "novo"] },
    "teams.react": { app: "teams", efeito: "reagir", destinos: ["evento"] },
    "slack.react": { app: "slack", efeito: "reagir", destinos: ["evento"] },
  },
  apps: {
    teams: {
      app: "teams",
      nome: "Teams",
      gatilhos: ["teams-inbox"],
      camposDoEvento: ["teamsChatId", "teamsTeamId", "teamsChannelId", "teamsMessageId", "teamsReplyToId", "teamsAccount", "prOwner"],
      refs: "Teams: 'chat/<chatId>' or 'canal/<teamId>/<channelId>' (ids from list_teams_chats and list_teams_channels); `conta` is the account the list was read by, needed when the ms365 server has more than one",
      listas: [
        {
          id: "chats",
          canal: "connections.teamsChats",
          fonteMcp: "list_teams_chats",
          opcoes: (dados) =>
            lista<{ chatId: string; label: string; conta?: string }>(dados).map((c) => ({
              ref: refDoTeams({ tipo: "chat", chatId: c.chatId }),
              rotulo: c.label,
              ...(c.conta === undefined ? {} : { conta: c.conta, grupo: c.conta }),
            })),
        },
        {
          id: "canais",
          canal: "connections.teamsChannels",
          fonteMcp: "list_teams_channels",
          opcoes: (dados) =>
            lista<{ teamId: string; teamName: string; channelId: string; channelName: string; conta?: string }>(dados).map((c) => ({
              ref: refDoTeams({ tipo: "canal", teamId: c.teamId, channelId: c.channelId }),
              rotulo: c.channelName,
              grupo: c.conta === undefined ? c.teamName : `${c.conta} · ${c.teamName}`,
              ...(c.conta === undefined ? {} : { conta: c.conta }),
            })),
        },
      ],
    },
    slack: {
      app: "slack",
      nome: "Slack",
      gatilhos: ["slack-channel", "slack-inbox"],
      camposDoEvento: ["slackChannel", "slackTs", "channel", "ts", "threadTs"],
      refs: "Slack: the channel id (from list_slack_channels)",
      listas: [
        {
          id: "canais",
          canal: "connections.slackChannels",
          args: [[]],
          fonteMcp: "list_slack_channels",
          opcoes: (dados) =>
            ((dados[0] as { canais?: { id: string; name: string }[] } | undefined)?.canais ?? []).map((c) => ({ ref: c.id, rotulo: `#${c.name}` })),
        },
      ],
    },
  },
};

/** O param `destino` no pacote: `fixo` é uma conversa desta máquina e não viaja; `evento` e `novo` viajam. */
export const PARAMS_DE_DESTINO_NO_PACOTE: ParamsDoPacote = { destino: "destino" };

/** Os campos de endereço do evento de todos os apps de conversa. */
export function camposDeEndereco(registro: RegistroDeConversa = REGISTRO_DE_CONVERSA): string[] {
  return Object.values(registro.apps).flatMap((a) => [...a.camposDoEvento]);
}

/**
 * O destino como a pendência o guarda, em dado: a Fila monta o texto pelo i18n.
 * `nome` é o nome da conversa conferido no que o Locum leu (ou nulo); `escolhido`
 * é o que a pessoa viu na tela ao escolher, e não vale como conferido.
 */
export const DestinoNaFila = z.object({
  app: z.string(),
  tipo: z.enum(["evento", "novo", "fixo"]),
  ref: z.string().optional(),
  conta: z.string().optional(),
  nome: z.string().nullable().optional(),
  escolhido: z.string().nullable().optional(),
});
export type DestinoNaFila = z.infer<typeof DestinoNaFila>;

/** As ações de conversa, pelo nome. */
export const ACOES_DE_CONVERSA_REGISTRO = REGISTRO_DE_CONVERSA.acoes;

/** O que `describe_steps` conta do destino, lido do registro: opções por ação e como cada app lista suas conversas. */
export function catalogoDeDestinos(registro: RegistroDeConversa = REGISTRO_DE_CONVERSA) {
  return {
    where: textoDoDestino(registro),
    porAcao: Object.fromEntries(Object.entries(registro.acoes).map(([acao, r]) => [acao, { app: r.app, efeito: r.efeito, destinos: r.destinos }])),
    porApp: Object.fromEntries(
      Object.entries(registro.apps).map(([app, a]) => [app, { gatilhos: a.gatilhos, refs: a.refs, listas: a.listas.map((l) => l.fonteMcp) }]),
    ),
  };
}

/** Os destinos que a ação aceita; vazio para ação que não tem o parâmetro. */
export function destinosDaAcao(acao: string): readonly TipoDeDestino[] {
  return ACOES_DE_CONVERSA_REGISTRO[acao]?.destinos ?? [];
}

/** Lê e confere um destino cru contra o que a ação aceita. Sem valor, o padrão da ação. */
export function exigirDestino(acao: string, cru: unknown, acoes: RegistroDeConversa["acoes"] = ACOES_DE_CONVERSA_REGISTRO): DestinoDaAcao {
  const registro = acoes[acao];
  if (registro === undefined) throw new Error(`a ação ${acao} não tem destino`);
  if (cru === undefined || cru === null) return { tipo: "evento" };

  // Confere o valor ainda sem interpolação: depois de `renderParams` um
  // `{{steps.x.y}}` já virou texto comum e ninguém mais distingue. O `rotulo` é
  // só o nome que a tela mostrou, e não decide nada.
  if (decideComMarcador(cru)) {
    throw new Error(
      "o destino não aceita marcador ({{...}}): ele vem do evento ou de uma conversa escolhida, e não de um passo anterior",
    );
  }
  const lido = DestinoDaAcao.safeParse(cru);
  if (!lido.success) throw new Error("o destino do passo está inválido: use evento, novo ou fixo");
  const destino = lido.data;
  if (!registro.destinos.includes(destino.tipo)) {
    const aceitos = registro.destinos.join(", ");
    throw new Error(
      registro.efeito === "reagir"
        ? `a reação só cai na mensagem do evento (destino aceito: ${aceitos})`
        : `o destino "${destino.tipo}" não vale para ${acao} (aceitos: ${aceitos})`,
    );
  }
  if (destino.tipo === "fixo" && destino.conversa.app !== registro.app) {
    throw new Error(`o destino fixo é de ${destino.conversa.app}, e ${acao} fala com ${registro.app}`);
  }
  return destino;
}

/** O destino que o passo grava em `params.destino`, ou o padrão da ação quando não há. */
export function destinoDoPasso(
  acao: string,
  params: Record<string, unknown> | undefined,
  acoes: RegistroDeConversa["acoes"] = ACOES_DE_CONVERSA_REGISTRO,
): DestinoDaAcao {
  return exigirDestino(acao, params?.destino, acoes);
}

/** Se algum campo que decide o destino (tipo, app, ref, conta) traz marcador, ou o destino inteiro é um marcador. */
function decideComMarcador(cru: unknown): boolean {
  if (typeof cru === "string") return cru.includes("{{");
  if (cru === null || typeof cru !== "object") return false;
  const d = cru as { tipo?: unknown; conversa?: { app?: unknown; ref?: unknown; conta?: unknown } | null };
  return [d.tipo, d.conversa?.app, d.conversa?.ref, d.conversa?.conta].some((v) => typeof v === "string" && v.includes("{{"));
}

/** O texto de `describe_steps` sobre o destino, montado com as ações e as opções do registro. */
function textoDoDestino(registro: RegistroDeConversa): string {
  const acoes = Object.keys(registro.acoes).join(", ");
  return (
    `params.destino on ${acoes}: where the message goes. { tipo: 'evento' } (default, also when absent) is the message that started the run, in its thread; ` +
    "{ tipo: 'novo' } is a new message in the event's conversation, outside the thread; { tipo: 'fixo', conversa: { app, ref, rotulo, conta } } is a conversation the person chose, from the same list the trigger uses. " +
    "Each action accepts only the options in porAcao (a reaction accepts only 'evento'). It comes only from the event or from this fixed value: a {{...}} marker in it, a model output or {{steps.*}} is refused when saving. " +
    "A fixed destination needs no event, so it works on a manual run and in a dry run; 'evento' and 'novo' without a message of the app in the event only show what they would send."
  );
}
