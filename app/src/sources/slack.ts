import { db as defaultDb } from "../db/index.js";
import { McpRegistry } from "../mcp/registry.js";
import { mcpService, type McpService } from "../services/mcp-service.js";
import { slackService, type SlackService, type SlackWatch } from "../services/slack-service.js";
import {
  CURSOR_TOKEN,
  pollMcpServer,
  type McpCaller,
  type McpPollShape,
} from "./mcp-poll.js";

type Db = typeof defaultDb;

/**
 * Cursor de um canal que nunca foi varrido.
 *
 * Zero, e não o epoch em ISO da varredura genérica: o `oldest` do Slack é
 * epoch em segundos, e mandar `1970-01-01T00:00:00.000Z` para ele é mandar
 * texto onde se espera número. O efeito é o mesmo que o da fonte genérica, ler
 * desde o começo, porque quanta história existe do outro lado quem sabe é o
 * Slack.
 */
const CURSOR_INICIAL = "0";

/**
 * O instante da chamada como `ts` do Slack, em segundos.
 *
 * É o cursor de um canal quieto. Arredondado para baixo, que repete no máximo
 * um segundo de mensagens, e a chave externa mata o repetido.
 */
export function slackWatermark(ms: number): string {
  return String(Math.floor(ms / 1000));
}

/** Fonte gravada no evento e no cursor. Um servidor de Slack, uma fonte. */
export function slackSource(server: string): string {
  return `slack:${server}`;
}

/** Chave do cursor: um canal, um cursor, que é o que a story pede. */
export function slackCursorKey(channel: string): string {
  return `channel:${channel}`;
}

/** Uma mensagem de canal, já traduzida do formato do Slack. */
export interface SlackMessage {
  channel: string;
  /** Quem escreveu, do jeito que o servidor devolveu. Nulo em mensagem de sistema. */
  author: string | null;
  text: string;
  ts: string;
  /**
   * A thread a que a mensagem pertence.
   *
   * É o próprio `ts` quando ela abre a thread, e não nulo: quem responde no
   * Slack responde sempre a uma thread, e deixar o campo vazio na mensagem de
   * abertura obrigaria quem for responder a remontar essa regra.
   */
  threadTs: string;
  /** Verdadeiro quando é resposta, e não abertura. */
  reply: boolean;
  /** Endereço da mensagem, quando o servidor devolve um. */
  permalink: string | null;
}

/**
 * A fonte de menções e mensagens de canal observado.
 *
 * Em cima da varredura por consulta a servidor MCP, e não ao lado dela: cursor,
 * deduplicação e a ordem entre gravar e mover o cursor são as mesmas, e o que
 * muda é só saber ler o item. O que se ganha em saber é o evento normalizado
 * que a story pede, com autor, canal, texto e vínculo da thread no topo do
 * corpo, em vez de um `item` cru que cada agent teria que decifrar.
 *
 * Não há token de Slack em lugar nenhum deste caminho. Quem fala com o Slack é
 * o servidor MCP que alguém já autorizou, e o Locum só sabe chamá-lo.
 *
 * Varrer não publica nada, e responder em thread não mora aqui: uma resposta é
 * escrita externa, e escrita externa para na fila de aprovação.
 */
export function slackShape(server: string, channel: string): McpPollShape {
  return {
    source: slackSource(server),
    key: slackCursorKey(channel),
    initialCursor: CURSOR_INICIAL,
    items: slackMessages,
    // O `ts` é único dentro do canal e sobrevive a edição, que é o que a chave
    // externa precisa: mensagem corrigida continua sendo a mesma mensagem.
    externalId: (item) => `slack:${channel}:${normalize(item, channel).ts}`,
    stamp: (item) => normalize(item, channel).ts,
    watermark: slackWatermark,
    payload: (item) => {
      const mensagem = normalize(item, channel);
      return {
        // O executor lê `repo` e `changedFiles` de todo evento. Aqui não há
        // repositório, e o canal é o que responde "de onde veio isto" na lista
        // de execuções.
        repo: `slack/${channel}`,
        changedFiles: [],
        server,
        channel,
        author: mensagem.author,
        text: mensagem.text,
        ts: mensagem.ts,
        threadTs: mensagem.threadTs,
        reply: mensagem.reply,
        permalink: mensagem.permalink,
        item,
      };
    },
  };
}

/**
 * Onde estão as mensagens na resposta.
 *
 * `messages` primeiro porque é como o Slack responde histórico de canal, e
 * depois os dois formatos que a varredura genérica já aceita, para que um
 * servidor MCP que reembrulhe a resposta continue servindo.
 *
 * O que não tem `ts` fica de fora aqui, e não estoura lá na frente: um marcador
 * de canal no meio da lista não é mensagem, e deixá-lo derrubar a varredura
 * seguraria o cursor do canal inteiro por causa de uma linha que ninguém quer.
 */
export function slackMessages(payload: unknown): unknown[] {
  const lista = Array.isArray(payload)
    ? payload
    : ((payload as { messages?: unknown; items?: unknown } | null | undefined)?.messages ??
      (payload as { items?: unknown } | null | undefined)?.items);
  if (!Array.isArray(lista)) return [];
  return lista.filter((item) => typeof (item as { ts?: unknown } | null)?.ts === "string");
}

/**
 * O item do servidor virando mensagem.
 *
 * Sem `ts` não há mensagem: ele é a identidade e o carimbo ao mesmo tempo, e
 * um item sem ele viraria evento novo a cada batida e ainda impediria o cursor
 * de andar. Estourar aqui é melhor que gravar isso.
 */
export function normalize(item: unknown, channel: string): SlackMessage {
  const bruto = (item ?? {}) as Record<string, unknown>;
  const ts = texto(bruto.ts);
  if (ts === null) throw new Error("mensagem do Slack sem carimbo `ts`");

  const threadTs = texto(bruto.thread_ts) ?? ts;
  return {
    channel: texto(bruto.channel) ?? channel,
    // `user_name` quando o servidor resolve o nome, e o identificador quando
    // não: o `U0…` cru não diz nada a quem lê o digest, mas é melhor que nada.
    author: texto(bruto.user_name) ?? texto(bruto.username) ?? texto(bruto.user),
    text: texto(bruto.text) ?? "",
    ts,
    threadTs,
    reply: threadTs !== ts,
    permalink: texto(bruto.permalink),
  };
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor !== "" ? valor : null;
}

export interface SlackPollOptions {
  db?: Db;
  mcp?: McpService;
  slack?: SlackService;
  /** Quem chama a ferramenta. Entra como dependência para poder ser trocado. */
  call?: McpCaller;
}

export interface SlackChannelOutcome {
  channel: string;
  eventIds: string[];
  /** Mensagens que a consulta trouxe, incluindo as já conhecidas. */
  seen: number;
  /** Erro deste canal. Canal que falha não derruba os outros. */
  error?: string;
}

export interface SlackPollOutcome {
  eventIds: string[];
  /** Evento de cada item da janela, novo ou já conhecido. Ver `McpPollOutcome.inWindow`. */
  inWindow: string[];
  seen: number;
  byChannel: SlackChannelOutcome[];
}

/**
 * Os argumentos de uma consulta a um canal.
 *
 * Montados aqui e não guardados no cadastro porque a variação real é só o nome
 * de cada campo, que o cadastro tem. Guardar o objeto inteiro deixaria a lista
 * de canais desencontrada do argumento que carrega o canal.
 */
export function slackArgs(watch: SlackWatch, channel: string): Record<string, unknown> {
  return {
    [watch.channelArg]: channel,
    [watch.sinceArg]: CURSOR_TOKEN,
    limit: watch.limit,
  };
}

/**
 * Varre os canais observados, um cursor por canal.
 *
 * O servidor MCP sobe uma vez só para a lista inteira, e não uma vez por canal:
 * é processo stdio de dezenas de megabytes, e quem observa cinco canais pagaria
 * cinco subidas por batida sem ganhar nada.
 *
 * Canal que falha vira erro na própria linha em vez de exceção: um canal a que
 * alguém perdeu acesso não pode impedir os outros de serem lidos, e o cursor do
 * que falhou fica onde estava.
 */
export async function pollSlack(
  watch: SlackWatch,
  options: SlackPollOptions = {},
): Promise<SlackPollOutcome> {
  const db = options.db ?? defaultDb;
  if (watch.server === null) throw new Error("nenhum servidor MCP cadastrado como Slack");
  const server = watch.server;

  const byChannel: SlackChannelOutcome[] = [];
  const janela: string[] = [];
  await withCaller(options, server, async (call) => {
    for (const channel of watch.channels) {
      try {
        const { eventIds, inWindow, seen } = await pollMcpServer(
          { server, tool: watch.tool, args: slackArgs(watch, channel) },
          { db, call, shape: slackShape(server, channel) },
        );
        byChannel.push({ channel, eventIds, seen });
        janela.push(...inWindow);
      } catch (err) {
        byChannel.push({
          channel,
          eventIds: [],
          seen: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  return {
    eventIds: byChannel.flatMap((c) => c.eventIds),
    inWindow: janela,
    seen: byChannel.reduce((total, c) => total + c.seen, 0),
    byChannel,
  };
}

/**
 * O cadastro do Slack, quando é este servidor que responde por ele.
 *
 * Existe para o agendador: um gatilho de `mcp-poll` apontado para o servidor de
 * Slack não está pedindo uma varredura opaca, está pedindo as mensagens dos
 * canais que alguém cadastrou. Responde nulo para qualquer outro servidor, e aí
 * a varredura genérica continua valendo.
 */
export async function slackWatchFor(
  server: string,
  options: Pick<SlackPollOptions, "slack"> = {},
): Promise<SlackWatch | null> {
  const watch = await (options.slack ?? slackService).get();
  return watch.server === server && watch.channels.length > 0 ? watch : null;
}

/** Sobe o servidor cadastrado uma vez para a lista toda e o devolve encerrado. */
async function withCaller(
  options: SlackPollOptions,
  server: string,
  body: (call: McpCaller) => Promise<void>,
): Promise<void> {
  if (options.call !== undefined) return body(options.call);

  const registry = McpRegistry.fromList(await (options.mcp ?? mcpService).enabledConfigs());
  if (!registry.has(server)) throw new Error(`servidor MCP "${server}" nao esta habilitado`);
  try {
    await body((alvo, tool, args) => registry.callTool(alvo, tool, args));
  } finally {
    await registry.closeAll();
  }
}
