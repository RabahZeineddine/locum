import { fetchPr } from "./github.js";
import { db as defaultDb, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
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


export interface ParsedGithubPr {
  owner: string;
  repo: string;
  pull: number;
}

export function extractGithubPr(text: string): ParsedGithubPr | null {
  const match = GITHUB_PR_LINK_REGEX.exec(text);
  if (!match) return null;
  return {
    owner: match[1]!,
    repo: match[2]!,
    pull: Number(match[3]!)
  };
}

export const GITHUB_PR_LINK_REGEX = /https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s]+)\/pull\/(\d+)/;

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
      const pr = extractGithubPr(mensagem.text);
      return {
        // O executor lê `repo` e `changedFiles` de todo evento. Se houver link de PR,
        // já apontamos o repo para o do PR para o reviewer se situar de imediato.
        repo: pr ? `${pr.owner}/${pr.repo}` : `slack/${channel}`,
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
        ...(pr ? { prOwner: pr.owner, prRepo: pr.repo, prNumber: pr.pull } : {}),
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
  const emTexto = (payload as { messages?: unknown } | null | undefined)?.messages;
  if (typeof emTexto === "string") return mensagensDoTexto(emTexto);
  const lista = Array.isArray(payload)
    ? payload
    : ((payload as { messages?: unknown; items?: unknown } | null | undefined)?.messages ??
      (payload as { items?: unknown } | null | undefined)?.items);
  if (!Array.isArray(lista)) return [];
  return lista.filter((item) => typeof (item as { ts?: unknown } | null)?.ts === "string");
}

/** Abertura de cada mensagem no texto do servidor oficial. */
const CABECALHO = /^=== Message from (.*) \((U[A-Z0-9]+)(?:, [^)]*)?\) at .* ===\s*$/;
/** Linhas de metadado que o servidor põe depois do texto. */
const METADADO = /^(Thread|Reactions|Files): /;

/**
 * As mensagens do `slack_read_channel` do servidor oficial.
 *
 * Ele devolve `messages` como texto, e não como lista: um bloco por mensagem,
 * aberto por `=== Message from Nome <email> (U…) at … ===`, com o carimbo na
 * linha `Message TS:` e, depois do texto, linhas de thread, reação e arquivo.
 * Aqui o bloco vira o mesmo item que a API do Slack daria, para `normalize`
 * não precisar saber de onde veio. O canal sai da linha `Channel:` do topo.
 *
 * A leitura de canal só traz mensagem de topo, então não há resposta de thread
 * para reconhecer: o `thread_ts` fica de fora e a mensagem abre a própria.
 */
function mensagensDoTexto(texto: string): unknown[] {
  const linhas = texto.split("\n");
  const canal = /^Channel: .*\((C[A-Z0-9]+)\)\s*$/.exec(linhas[0] ?? "")?.[1];
  const itens: Record<string, unknown>[] = [];
  let atual: { user: string; user_name: string; ts?: string; corpo: string[] } | null = null;
  const fechar = (): void => {
    if (atual?.ts === undefined) return;
    const corpo = [...atual.corpo];
    while (corpo.length > 0 && (corpo.at(-1)!.trim() === "" || METADADO.test(corpo.at(-1)!))) corpo.pop();
    itens.push({
      ts: atual.ts,
      user: atual.user,
      user_name: atual.user_name,
      text: corpo.join("\n").trim(),
      ...(canal === undefined ? {} : { channel: canal }),
    });
  };
  for (const linha of linhas) {
    const cabecalho = CABECALHO.exec(linha);
    if (cabecalho !== null) {
      fechar();
      atual = { user: cabecalho[2]!, user_name: cabecalho[1]!.replace(/\s*<[^>]*>$/, ""), corpo: [] };
      continue;
    }
    if (atual === null) continue;
    const ts = atual.ts === undefined ? /^Message TS: (\d+\.\d+)\s*$/.exec(linha)?.[1] : undefined;
    if (ts !== undefined) atual.ts = ts;
    else if (atual.ts !== undefined) atual.corpo.push(linha);
  }
  fechar();
  return itens;
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

        // Enriquecer eventos que contêm links para PR do GitHub com dados reais do PR (diff, título, etc)
        for (const evId of inWindow) {
          try {
            const [ev] = await db.select().from(schema.events).where(eq(schema.events.id, evId)).limit(1);
            const payload = ev?.payload as Record<string, unknown> | null;
            if (payload && payload.prOwner && payload.prRepo && payload.prNumber && !payload.diff) {
              const prCtx = await fetchPr(String(payload.prOwner), String(payload.prRepo), Number(payload.prNumber));
              await db.update(schema.events).set({
                payload: {
                  ...payload,
                  ...prCtx,
                  // Preserva dados originais do Slack para poder responder/reagir depois
                  slackChannel: payload.channel,
                  slackTs: payload.ts,
                  slackThreadTs: payload.threadTs,
                }
              }).where(eq(schema.events.id, evId));
            }
          } catch (e) {
            // Falha ao enriquecer PR não derruba a varredura
          }
        }

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
