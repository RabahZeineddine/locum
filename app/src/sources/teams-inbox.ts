import { db as defaultDb } from "../db/index.js";
import { mcpOAuthService } from "../services/mcp-oauth-service.js";
import { GRAPH_URL, TEAMS_SERVER } from "../services/teams-app.js";
import { pollMcpServer, CURSOR_TOKEN, type McpCaller, type McpPollShape } from "./mcp-poll.js";

type Db = typeof defaultDb;

/** Fonte gravada no evento e no cursor. */
export const TEAMS_SOURCE = "teams";

/** Chave do cursor da caixa. Uma varredura só responde pelas duas perguntas. */
export const TEAMS_INBOX_CURSOR = "inbox";

/** O máximo que o Graph devolve por página, tanto de conversa quanto de mensagem. */
const POR_PAGINA = 50;

/**
 * Páginas de cada lista numa batida.
 *
 * A lista de conversas vem da mais recente para a mais antiga e a varredura
 * para na primeira que é mais velha que o cursor, então quase sempre basta a
 * primeira página. O teto existe para a batida que volta depois de dias com o
 * Mac fechado, e tem preço: as duas listas vêm da mais nova para a mais
 * antiga, então o que passa de duzentas conversas ou de duzentas mensagens
 * numa conversa é o mais velho, e o cursor anda por cima dele. Perder a
 * ducentésima primeira conversa de uma semana parada é melhor que uma batida
 * que leva minutos e esbarra no limite de chamadas do Graph.
 */
const PAGINAS = 4;

/**
 * Menção é o nome da pessoa marcado com `@` em qualquer conversa. Mensagem
 * direta é tudo que chega em conversa de duas ou de poucas pessoas, com ou sem
 * menção. Reunião não conta como conversa direta: o chat de reunião junta
 * todo convidado, e acordar o agent a cada "bom dia" ali é trabalho que
 * ninguém pediu. Menção dentro dele continua contando.
 */
export type TeamsInboxKind = "mention" | "dm";

export interface TeamsInboxWatch {
  mentions: boolean;
  dms: boolean;
}

export interface TeamsInboxOptions {
  db?: Db;
  /** Token do Graph. Ausente é o que a conexão do Teams guardou. */
  token?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  graphUrl?: string;
}

export interface TeamsInboxOutcome {
  eventIds: string[];
  seen: number;
  errors: { kind: "inbox"; error: string }[];
}

/**
 * Varre o que pede a atenção da pessoa no Teams: menções e mensagens diretas.
 *
 * O Graph não tem busca de menção para app de desktop, então a varredura anda
 * pelas conversas: lista as que tiveram mensagem depois do cursor e lê de cada
 * uma só o que chegou desde então. A notificação por webhook resolveria sem
 * varrer, mas pede um endereço público, e o Locum roda no Mac de cada um.
 *
 * Cursor, deduplicação e a ordem entre gravar e mover o cursor são os da
 * varredura por MCP, com um chamador que vai ao Graph. O cursor é o carimbo
 * ISO da mensagem mais nova que foi lida, em milissegundos, para que a
 * comparação de texto da varredura ordene certo.
 */
export async function pollTeamsInbox(
  watch: TeamsInboxWatch,
  options: TeamsInboxOptions = {},
): Promise<TeamsInboxOutcome> {
  const db = options.db ?? defaultDb;
  const token = await (options.token ?? (() => mcpOAuthService.accessToken(TEAMS_SERVER)))();
  if (token === null) throw new Error("o Teams não está conectado");

  const graph = graphGet(token, options.fetchFn ?? fetch, options.graphUrl ?? GRAPH_URL);
  const outcome: TeamsInboxOutcome = { eventIds: [], seen: 0, errors: [] };
  if (!watch.mentions && !watch.dms) return outcome;

  try {
    const eu = await quemSou(graph);
    const { eventIds, seen } = await pollMcpServer(
      { server: TEAMS_SERVER, tool: "inbox", args: { since: CURSOR_TOKEN } },
      { db, call: caixa(graph), shape: inboxShape(watch, eu) },
    );
    outcome.eventIds.push(...eventIds);
    outcome.seen += seen;
  } catch (err) {
    outcome.errors.push({ kind: "inbox", error: err instanceof Error ? err.message : String(err) });
  }
  return outcome;
}

/** Um GET no Graph, com o endereço relativo ou o `@odata.nextLink` inteiro. */
type GraphGet = (caminho: string) => Promise<Record<string, unknown>>;

function graphGet(token: string, fetchFn: typeof fetch, graphUrl: string): GraphGet {
  return async (caminho) => {
    const url = caminho.startsWith("https://") ? caminho : `${graphUrl}${caminho}`;
    const resposta = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resposta.ok) {
      const corpo = (await resposta.json().catch(() => ({}))) as { error?: { code?: unknown } };
      const codigo = typeof corpo.error?.code === "string" ? `: ${corpo.error.code}` : "";
      throw new Error(`Graph respondeu ${resposta.status}${codigo}`);
    }
    return (await resposta.json()) as Record<string, unknown>;
  };
}

/** Quem é a pessoa dona do token, para tirar o que ela mesma escreveu. */
async function quemSou(graph: GraphGet): Promise<string> {
  const resposta = await graph("/me?$select=id");
  if (typeof resposta.id !== "string" || resposta.id === "") {
    throw new Error("o Graph não disse de quem é o token");
  }
  return resposta.id;
}

/**
 * O chamador da varredura: junta numa resposta só as mensagens novas de toda
 * conversa que se mexeu depois do cursor, cada uma marcada com o tipo da
 * conversa de onde veio, que a mensagem sozinha não traz.
 *
 * Mensagem criada antes do cursor fica aqui mesmo, porque só aqui o cursor é
 * conhecido: ela só voltou porque alguém a editou.
 */
function caixa(graph: GraphGet): McpCaller {
  return async (_server, _tool, args) => {
    const desde = String(args.since);
    const conversas = await conversasDesde(graph, desde);
    const mensagens: unknown[] = [];
    for (const conversa of conversas) {
      for (const mensagem of await mensagensDesde(graph, conversa.id, desde)) {
        const criada = carimbo((mensagem as { createdDateTime?: unknown } | null)?.createdDateTime);
        if (criada === null || criada <= desde) continue;
        mensagens.push({ ...(mensagem as object), chatType: conversa.chatType });
      }
    }
    return { messages: mensagens };
  };
}

async function conversasDesde(graph: GraphGet, desde: string): Promise<{ id: string; chatType: string }[]> {
  const achadas: { id: string; chatType: string }[] = [];
  let proxima: string | null =
    `/me/chats?$expand=lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc&$top=${POR_PAGINA}`;
  for (let pagina = 0; pagina < PAGINAS && proxima !== null; pagina++) {
    const resposta = await graph(proxima);
    const lista = Array.isArray(resposta.value) ? resposta.value : [];
    for (const item of lista) {
      const conversa = (item ?? {}) as Record<string, unknown>;
      const previa = (conversa.lastMessagePreview ?? {}) as Record<string, unknown>;
      const quando = carimbo(previa.createdDateTime);
      if (typeof conversa.id !== "string") continue;
      // Conversa sem mensagem nenhuma vem com a prévia nula, e não diz nada
      // sobre a ordem das outras.
      if (quando === null) continue;
      // A lista vem da mais recente para a mais antiga: daqui em diante nada
      // se mexeu desde o cursor.
      if (quando <= desde) return achadas;
      achadas.push({ id: conversa.id, chatType: String(conversa.chatType ?? "") });
    }
    proxima = typeof resposta["@odata.nextLink"] === "string" ? resposta["@odata.nextLink"] : null;
  }
  return achadas;
}

/**
 * As mensagens de uma conversa mexidas depois do cursor.
 *
 * O filtro do Graph é por última alteração, porque o de criação só aceita
 * "antes de". Mensagem antiga editada passa por ele, e quem a tira é `caixa`,
 * pela data de criação.
 */
async function mensagensDesde(graph: GraphGet, chatId: string, desde: string): Promise<unknown[]> {
  const achadas: unknown[] = [];
  let proxima: string | null =
    `/chats/${encodeURIComponent(chatId)}/messages?$top=${POR_PAGINA}` +
    `&$orderby=lastModifiedDateTime desc&$filter=lastModifiedDateTime gt ${desde}`;
  for (let pagina = 0; pagina < PAGINAS && proxima !== null; pagina++) {
    const resposta = await graph(proxima);
    if (Array.isArray(resposta.value)) achadas.push(...resposta.value);
    proxima = typeof resposta["@odata.nextLink"] === "string" ? resposta["@odata.nextLink"] : null;
  }
  return achadas;
}

/** Uma mensagem do Teams, já traduzida. */
export interface TeamsInboxMessage {
  kind: TeamsInboxKind;
  chatId: string;
  chatType: string;
  messageId: string;
  author: string | null;
  authorId: string | null;
  text: string;
  createdAt: string;
  webUrl: string | null;
}

/**
 * Qual das duas perguntas a mensagem responde, ou nenhuma.
 *
 * Menção ganha de mensagem direta quando as duas valem, porque diz mais: a
 * pessoa foi chamada pelo nome.
 */
export function kindOf(item: unknown, eu: string, watch: TeamsInboxWatch): TeamsInboxKind | null {
  const bruto = (item ?? {}) as Record<string, unknown>;
  const mencoes = Array.isArray(bruto.mentions) ? bruto.mentions : [];
  const mencionada = mencoes.some(
    (m) => ((m as { mentioned?: { user?: { id?: unknown } } })?.mentioned?.user?.id) === eu,
  );
  if (mencionada && watch.mentions) return "mention";
  const direta = bruto.chatType === "oneOnOne" || bruto.chatType === "group";
  if (direta && watch.dms) return "dm";
  return null;
}

/**
 * Onde estão as mensagens na resposta, já sem o que não pede atenção.
 *
 * Fica de fora o que a própria pessoa escreveu, aviso do sistema ("fulano
 * entrou na conversa"), mensagem apagada e mensagem de app: acordar o agent com qualquer uma delas
 * é trabalho que ninguém pediu.
 */
export function inboxMessages(payload: unknown, eu: string, watch: TeamsInboxWatch): unknown[] {
  const lista = (payload as { messages?: unknown } | null | undefined)?.messages;
  if (!Array.isArray(lista)) return [];
  return lista.filter((item) => {
    const bruto = (item ?? {}) as Record<string, unknown>;
    const autor = ((bruto.from ?? {}) as { user?: { id?: unknown } | null }).user;
    return (
      typeof bruto.id === "string" &&
      typeof bruto.chatId === "string" &&
      bruto.messageType === "message" &&
      (bruto.deletedDateTime === null || bruto.deletedDateTime === undefined) &&
      typeof autor?.id === "string" &&
      autor.id !== eu &&
      carimbo(bruto.createdDateTime) !== null &&
      kindOf(item, eu, watch) !== null
    );
  });
}

/** O item do Graph virando mensagem. */
export function normalizeInbox(item: unknown, kind: TeamsInboxKind): TeamsInboxMessage {
  const bruto = (item ?? {}) as Record<string, unknown>;
  const messageId = texto(bruto.id);
  const chatId = texto(bruto.chatId);
  const createdAt = carimbo(bruto.createdDateTime);
  if (messageId === null || chatId === null || createdAt === null) {
    throw new Error("mensagem do Teams sem conversa, identificador ou data");
  }
  const autor = ((bruto.from ?? {}) as { user?: { id?: unknown; displayName?: unknown } | null }).user ?? {};
  const corpo = (bruto.body ?? {}) as { contentType?: unknown; content?: unknown };
  const conteudo = typeof corpo.content === "string" ? corpo.content : "";
  return {
    kind,
    chatId,
    chatType: String(bruto.chatType ?? ""),
    messageId,
    author: texto(autor.displayName) ?? texto(autor.id),
    authorId: texto(autor.id),
    text: corpo.contentType === "html" ? semHtml(conteudo) : conteudo.trim(),
    createdAt,
    webUrl: texto(bruto.webUrl),
  };
}

/**
 * O texto de uma mensagem em HTML, como a pessoa leu.
 *
 * O Teams manda quase toda mensagem em HTML, e o modelo que vai responder não
 * precisa das tags. Não é um conversor completo: quebra de linha onde havia
 * parágrafo, tag fora, e as entidades que aparecem em mensagem comum.
 */
export function semHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function inboxShape(watch: TeamsInboxWatch, eu: string): McpPollShape {
  const tipo = (item: unknown) => kindOf(item, eu, watch) ?? "dm";
  return {
    source: TEAMS_SOURCE,
    key: TEAMS_INBOX_CURSOR,
    initialCursor: inicial(),
    items: (payload) => inboxMessages(payload, eu, watch),
    externalId: (item) => {
      const mensagem = normalizeInbox(item, tipo(item));
      return `teams:${mensagem.chatId}:${mensagem.messageId}`;
    },
    stamp: (item) => normalizeInbox(item, tipo(item)).createdAt,
    payload: (item) => {
      const mensagem = normalizeInbox(item, tipo(item));
      return {
        repo: `teams/${mensagem.chatId}`,
        changedFiles: [],
        server: TEAMS_SERVER,
        kind: mensagem.kind,
        chatId: mensagem.chatId,
        chatType: mensagem.chatType,
        author: mensagem.author,
        authorId: mensagem.authorId,
        text: mensagem.text,
        messageId: mensagem.messageId,
        webUrl: mensagem.webUrl,
        item,
      };
    },
  };
}

/**
 * Carimbo ISO normalizado em milissegundos, ou nulo.
 *
 * O Graph manda a fração com quantos dígitos quiser, e às vezes sem fração.
 * Comparar esses textos direto erraria a ordem (`"…00Z"` vem depois de
 * `"…00.5Z"`), e o cursor da varredura é comparado como texto.
 */
export function carimbo(valor: unknown): string | null {
  if (typeof valor !== "string" || valor === "") return null;
  const ms = Date.parse(valor);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Cursor de quem nunca varreu: um dia atrás, pelo mesmo motivo da caixa do
 * Slack. Ligar o gatilho não deve acordar o agent para a história inteira.
 */
function inicial(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor !== "" ? valor : null;
}
