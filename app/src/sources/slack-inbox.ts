import { db as defaultDb } from "../db/index.js";
import { mcpOAuthService } from "../services/mcp-oauth-service.js";
import { SLACK_SERVER } from "../services/slack-app.js";
import { pollMcpServer, CURSOR_TOKEN, type McpCaller, type McpPollShape } from "./mcp-poll.js";
import { slackSource, slackWatermark } from "./slack.js";

type Db = typeof defaultDb;

/** Onde mora a API do Slack. Entra como opção para o teste apontar para um falso. */
export const SLACK_API_URL = "https://slack.com/api";

/**
 * Teto de mensagens por consulta. É o máximo que `assistant.search.context`
 * aceita, e o cursor garante que a batida seguinte pega o que sobrou.
 */
const LIMITE = 20;

/**
 * Páginas por pergunta numa batida.
 *
 * O `after` da busca pode valer pelo dia, e não pelo segundo, como o filtro da
 * barra de busca. Num dia com mais de uma página de menções, ler só a primeira
 * devolveria a mesma página para sempre. Seguir o `next_cursor` resolve, e o
 * teto mantém as duas perguntas dentro do limite de dez chamadas por minuto
 * que a busca impõe a cada usuário.
 */
const PAGINAS = 4;

/**
 * As duas perguntas que a caixa faz, uma por cursor.
 *
 * Menção é o texto `<@U…>` da própria pessoa em qualquer conversa que ela
 * enxerga. Mensagem direta é tudo que chega em conversa de duas ou de poucas
 * pessoas, com ou sem menção; a busca pede um termo, e o filtro `to:` da barra
 * de busca do Slack é o que separa o que foi mandado para ela.
 *
 * As duas consultas se sobrepõem quando alguém menciona a pessoa numa conversa
 * direta, e não faz mal: a chave externa é a mensagem, e não a pergunta, então
 * a segunda leitura da mesma mensagem não vira evento de novo.
 */
export type SlackInboxKind = "mention" | "dm";

interface Pergunta {
  kind: SlackInboxKind;
  query: (eu: string) => string;
  channelTypes: string;
}

const PERGUNTAS: Pergunta[] = [
  {
    kind: "mention",
    query: (eu) => `<@${eu}>`,
    channelTypes: "public_channel,private_channel,mpim,im",
  },
  {
    kind: "dm",
    query: (eu) => `to:<@${eu}>`,
    channelTypes: "im,mpim",
  },
];

export interface SlackInboxWatch {
  mentions: boolean;
  dms: boolean;
}

export interface SlackInboxOptions {
  db?: Db;
  /** Token de usuário do Slack. Ausente é o que a conexão oficial guardou. */
  token?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  apiUrl?: string;
}

export interface SlackInboxOutcome {
  eventIds: string[];
  seen: number;
  /** Erro de cada pergunta que falhou. Uma que falha não segura a outra. */
  errors: { kind: SlackInboxKind; error: string }[];
}

/**
 * Varre o que pede a atenção da pessoa no Slack: menções e mensagens diretas.
 *
 * Fala com a API do Slack, e não com o servidor MCP, e de propósito: a busca
 * do servidor oficial devolve texto corrido em markdown, sem canal nem carimbo
 * separados, e evento montado de texto corrido teria autor e thread
 * adivinhados. A autorização é a mesma: o token que a conexão oficial guardou,
 * do usuário e não de bot, com os escopos `search:read.*` do manifesto.
 *
 * Cursor, deduplicação e a ordem entre gravar e mover o cursor são os da
 * varredura por MCP, que recebe aqui um chamador que vai à API em vez de a uma
 * ferramenta. O evento sai no mesmo formato do de canal observado, com o
 * servidor oficial como `server`, para que a resposta aprovada saia pelo mesmo
 * caminho de qualquer outra resposta no Slack: pela fila.
 */
export async function pollSlackInbox(
  watch: SlackInboxWatch,
  options: SlackInboxOptions = {},
): Promise<SlackInboxOutcome> {
  const db = options.db ?? defaultDb;
  const token = await (options.token ?? (() => mcpOAuthService.accessToken(SLACK_SERVER)))();
  if (token === null) throw new Error("o Slack não está conectado pelo servidor oficial");

  const api = slackApi(token, options.fetchFn ?? fetch, options.apiUrl ?? SLACK_API_URL);
  const eu = await quemSou(api);

  const outcome: SlackInboxOutcome = { eventIds: [], seen: 0, errors: [] };
  for (const pergunta of PERGUNTAS) {
    if (pergunta.kind === "mention" && !watch.mentions) continue;
    if (pergunta.kind === "dm" && !watch.dms) continue;
    try {
      const { eventIds, seen } = await pollMcpServer(
        {
          server: SLACK_SERVER,
          tool: "assistant.search.context",
          args: {
            query: pergunta.query(eu),
            channel_types: pergunta.channelTypes,
            sort: "timestamp",
            sort_dir: "asc",
            limit: LIMITE,
            after: CURSOR_TOKEN,
          },
        },
        { db, call: api, shape: inboxShape(pergunta.kind, eu) },
      );
      outcome.eventIds.push(...eventIds);
      outcome.seen += seen;
    } catch (err) {
      outcome.errors.push({ kind: pergunta.kind, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return outcome;
}

/** Chamador que vai à API Web do Slack, seguindo as páginas da busca. */
function slackApi(token: string, fetchFn: typeof fetch, apiUrl: string): McpCaller {
  const chamar = umaChamada(token, fetchFn, apiUrl);
  return async (server, method, args) => {
    if (method !== "assistant.search.context") return chamar(server, method, args);

    const mensagens: unknown[] = [];
    let cursor: string | undefined;
    for (let pagina = 0; pagina < PAGINAS; pagina++) {
      const resposta = (await chamar(server, method, cursor === undefined ? args : { ...args, cursor })) as {
        results?: { messages?: unknown };
        response_metadata?: { next_cursor?: unknown };
      };
      const lista = resposta.results?.messages;
      if (Array.isArray(lista)) mensagens.push(...lista);
      const proximo = resposta.response_metadata?.next_cursor;
      if (typeof proximo !== "string" || proximo === "") break;
      cursor = proximo;
    }
    return { ok: true, results: { messages: mensagens } };
  };
}

/**
 * Uma chamada à API Web do Slack.
 *
 * O `after` chega como o `ts` da última mensagem vista, que tem fração, e a
 * API quer segundos inteiros. Arredondar para baixo devolve de novo a última
 * mensagem do segundo, e a chave externa a descarta.
 *
 * `ok: false` vira exceção pelo mesmo motivo do `isError` da varredura: tratar
 * a recusa como resposta vazia faria o cursor andar sem ninguém ter lido.
 */
function umaChamada(token: string, fetchFn: typeof fetch, apiUrl: string): McpCaller {
  return async (_server, method, args) => {
    const corpo = new URLSearchParams();
    for (const [chave, valor] of Object.entries(args)) {
      if (valor === undefined || valor === null) continue;
      if (chave === "after") {
        const segundos = Math.floor(Number(valor));
        if (segundos > 0) corpo.set(chave, String(segundos));
        continue;
      }
      corpo.set(chave, String(valor));
    }
    const resposta = await fetchFn(`${apiUrl}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: corpo,
    });
    if (!resposta.ok) throw new Error(`Slack respondeu ${resposta.status} em ${method}`);
    const json = (await resposta.json()) as { ok?: unknown; error?: unknown };
    if (json.ok !== true) {
      throw new Error(`Slack recusou ${method}: ${typeof json.error === "string" ? json.error : "sem motivo"}`);
    }
    return json;
  };
}

/** O identificador da pessoa dona do token, que é quem a busca procura. */
async function quemSou(api: McpCaller): Promise<string> {
  const resposta = (await api(SLACK_SERVER, "auth.test", {})) as { user_id?: unknown };
  if (typeof resposta.user_id !== "string" || resposta.user_id === "") {
    throw new Error("o Slack não disse de quem é o token");
  }
  return resposta.user_id;
}

/** Uma mensagem da busca, já traduzida. */
export interface SlackInboxMessage {
  kind: SlackInboxKind;
  channel: string;
  author: string | null;
  authorId: string | null;
  text: string;
  ts: string;
  threadTs: string;
  reply: boolean;
  permalink: string | null;
}

/**
 * Onde estão as mensagens na resposta da busca.
 *
 * Fica de fora o que a própria pessoa escreveu, que a busca por `to:` devolve
 * junto quando ela responde numa conversa direta, e o que veio de bot: acordar
 * agent com a própria resposta ou com aviso automático é trabalho que ninguém
 * pediu.
 */
export function inboxMessages(payload: unknown, eu: string): unknown[] {
  const lista = (payload as { results?: { messages?: unknown } } | null | undefined)?.results?.messages;
  if (!Array.isArray(lista)) return [];
  return lista.filter((item) => {
    const bruto = (item ?? {}) as Record<string, unknown>;
    return (
      typeof bruto.message_ts === "string" &&
      typeof bruto.channel_id === "string" &&
      bruto.author_user_id !== eu &&
      bruto.is_author_bot !== true
    );
  });
}

/**
 * O item da busca virando mensagem.
 *
 * A busca não devolve `thread_ts`. O vínculo vem do permalink, que o Slack
 * monta com `?thread_ts=` quando a mensagem é resposta; sem ele, a mensagem
 * abre a própria thread, como na fonte de canal.
 */
export function normalizeInbox(item: unknown, kind: SlackInboxKind): SlackInboxMessage {
  const bruto = (item ?? {}) as Record<string, unknown>;
  const ts = texto(bruto.message_ts);
  const channel = texto(bruto.channel_id);
  if (ts === null || channel === null) throw new Error("mensagem da busca do Slack sem canal ou carimbo");

  const permalink = texto(bruto.permalink);
  const threadTs = threadDoPermalink(permalink) ?? ts;
  return {
    kind,
    channel,
    author: texto(bruto.author_name) ?? texto(bruto.author_user_id),
    authorId: texto(bruto.author_user_id),
    text: texto(bruto.content) ?? "",
    ts,
    threadTs,
    reply: threadTs !== ts,
    permalink,
  };
}

function threadDoPermalink(permalink: string | null): string | null {
  if (permalink === null) return null;
  try {
    return texto(new URL(permalink).searchParams.get("thread_ts"));
  } catch {
    return null;
  }
}

/** Chave do cursor de cada pergunta. */
export function inboxCursorKey(kind: SlackInboxKind): string {
  return `inbox:${kind}`;
}

function inboxShape(kind: SlackInboxKind, eu: string): McpPollShape {
  return {
    source: slackSource(SLACK_SERVER),
    key: inboxCursorKey(kind),
    initialCursor: inicial(),
    items: (payload) => inboxMessages(payload, eu),
    // A mesma chave da fonte de canal: a menção num canal observado é a mesma
    // mensagem que a varredura do canal já gravou, e não deve acordar o agent
    // duas vezes.
    externalId: (item) => {
      const mensagem = normalizeInbox(item, kind);
      return `slack:${mensagem.channel}:${mensagem.ts}`;
    },
    stamp: (item) => normalizeInbox(item, kind).ts,
    watermark: slackWatermark,
    payload: (item) => {
      const mensagem = normalizeInbox(item, kind);
      return {
        repo: `slack/${mensagem.channel}`,
        changedFiles: [],
        server: SLACK_SERVER,
        kind: mensagem.kind,
        channel: mensagem.channel,
        author: mensagem.author,
        authorId: mensagem.authorId,
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
 * Cursor de quem nunca varreu: um dia atrás.
 *
 * Diferente da fonte de canal, que lê desde o começo porque a pessoa escolheu
 * aquele canal. Aqui não houve escolha de conversa, e ligar o gatilho
 * acordaria o agent para cada menção da história inteira da conta.
 */
function inicial(): string {
  return String(Math.floor(Date.now() / 1000) - 24 * 60 * 60);
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor !== "" ? valor : null;
}
