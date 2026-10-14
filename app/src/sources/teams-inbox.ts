import { and, eq, gte, notInArray } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { mcpOAuthService } from "../services/mcp-oauth-service.js";
import { GRAPH_URL, TEAMS_SERVER } from "../services/teams-app.js";
import { pollMcpServer, CURSOR_TOKEN, type McpCaller, type McpPollShape } from "./mcp-poll.js";
import { clienteHttp } from "../net/http.js";
import { alvoDaReacao, reagirNoTeams, REACAO_PEGOU } from "../teams/reaction.js";
import { githubService } from "../services/github-service.js";
import { fetchPr as defaultFetchPr } from "./github.js";
import { extractGithubPrLinks } from "./github-pr-link.js";
import type { ParsedGithubPr } from "./slack.js";

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
 *
 * "pr" é a mensagem que acordou por trazer link de pull request, com ou sem
 * menção: o evento é do PR, e a mensagem de onde ele veio fica nos campos
 * `teams*`.
 */
export type TeamsInboxKind = "mention" | "dm" | "pr";

export interface TeamsInboxWatch {
  mentions: boolean;
  dms: boolean;
  /**
   * Link de pull request do GitHub acorda, sem menção, nos canais da lista e
   * nos chats em grupo e diretos. Chat de reunião segue só com menção. Uma
   * mensagem com vários links vira um evento por PR, até `MAX_PR_POR_MENSAGEM`.
   */
  prLinks?: boolean;
  /**
   * Só para a varredura: link de PR de mensagem criada antes disto não conta.
   * Preenchido na primeira batida de um cursor, para ligar o gatilho não
   * revisar a história que já estava lá.
   */
  prDesde?: string;
  /** Canais de equipe onde a menção também conta. */
  channels?: readonly TeamsChannelRef[];
}

export interface TeamsChannelRef {
  teamId: string;
  channelId: string;
  label?: string;
}

/** Prefixo do `repo` de evento que veio de canal de equipe. */
export const TEAMS_CHANNEL_PREFIX = "teams-channel/";

export interface TeamsInboxOptions {
  db?: Db;
  /** Token do Graph. Ausente é o que a conexão do Teams guardou. */
  token?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  graphUrl?: string;
  /** Busca do contexto do PR. Existe para o teste trocar. */
  fetchPr?: typeof defaultFetchPr;
  /**
   * O gatilho que varre. O cursor é dele: dois gatilhos com configuração
   * diferente sobre a mesma conversa leriam a mesma janela e o segundo a
   * encontraria já consumida. Ausente é o cursor compartilhado de antes.
   */
  triggerId?: string;
  /** Login do GitHub de quem usa o Locum. Existe para o teste trocar. */
  viewerLogin?: () => Promise<string | null>;
}

export interface TeamsInboxOutcome {
  eventIds: string[];
  /** Evento de cada item da janela, novo ou já conhecido. Ver `McpPollOutcome.inWindow`. */
  inWindow: string[];
  seen: number;
  errors: { kind: "inbox" | "channel"; channel?: string; error: string }[];
  /** PR que a mensagem trouxe e não virou review, com o motivo, para o detail do gatilho. */
  descartes: { pr: string; motivo: string }[];
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

  const graph = graphGet(token, options.fetchFn ?? clienteHttp, options.graphUrl ?? GRAPH_URL);
  const outcome: TeamsInboxOutcome = { eventIds: [], inWindow: [], seen: 0, errors: [], descartes: [] };
  const revisados = memoizar(() => carregarRevisados(db));
  const canais = watch.mentions || watch.prLinks ? (watch.channels ?? []) : [];
  if (!watch.mentions && !watch.dms && !watch.prLinks) return outcome;

  let eu: string;
  try {
    eu = await quemSou(graph);
  } catch (err) {
    outcome.errors.push({ kind: "inbox", error: err instanceof Error ? err.message : String(err) });
    return outcome;
  }

  const sufixo = options.triggerId === undefined ? "" : `:${options.triggerId}`;

  // O que cada resposta traz entra no resultado só depois de enriquecida: o
  // evento descartado (PR meu, fechado, repetido, sem contexto) não acorda o agent.
  const acolher = async (
    varredura: { eventIds: string[]; inWindow: string[]; seen: number },
    kind: "inbox" | "channel",
    channel?: string,
  ) => {
    const { erros, fora, descartes } = await enriquecerPrs(varredura.inWindow, kind, channel, db, options, revisados);
    outcome.descartes.push(...descartes);
    outcome.eventIds.push(...varredura.eventIds.filter((id) => !fora.has(id)));
    for (const id of varredura.inWindow) {
      if (!fora.has(id) && !outcome.inWindow.includes(id)) outcome.inWindow.push(id);
    }
    outcome.seen += varredura.seen;
    outcome.errors.push(...erros);
  };

  try {
    const chave = `${TEAMS_INBOX_CURSOR}${sufixo}`;
    const primeira = await prepararCursor(db, chave, TEAMS_INBOX_CURSOR);
    const vigia = primeira ? { ...watch, prDesde: new Date().toISOString() } : watch;
    await acolher(
      await pollMcpServer(
        { server: TEAMS_SERVER, tool: "inbox", args: { since: CURSOR_TOKEN } },
        { db, call: caixa(graph), shape: inboxShape(vigia, eu, chave) },
      ),
      "inbox",
    );
  } catch (err) {
    outcome.errors.push({ kind: "inbox", error: err instanceof Error ? err.message : String(err) });
  }

  // Um cursor por canal, como no Slack: o canal que falha não segura o
  // cursor dos outros, e o que entrou depois começa do próprio dia.
  for (const canal of canais) {
    try {
      const antiga = `channel:${canal.teamId}:${canal.channelId}`;
      const primeira = await prepararCursor(db, `${antiga}${sufixo}`, antiga);
      const vigia = primeira ? { ...watch, prDesde: new Date().toISOString() } : watch;
      await acolher(
        await pollMcpServer(
          { server: TEAMS_SERVER, tool: "channel", args: { since: CURSOR_TOKEN } },
          { db, call: doCanal(graph, canal), shape: canalShape(canal, eu, vigia, `${antiga}${sufixo}`) },
        ),
        "channel",
        canal.label ?? canal.channelId,
      );
    } catch (err) {
      outcome.errors.push({
        kind: "channel",
        channel: canal.label ?? canal.channelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcome;
}

/** Idade máxima do cursor compartilhado para um gatilho herdá-lo. */
const JANELA_DO_CURSOR_HERDADO_MS = 24 * 60 * 60 * 1000;

/**
 * Garante o cursor do gatilho. Quem ainda não tem o próprio parte do
 * compartilhado de antes, se existir, para não reprocessar nem perder nada.
 * Devolve verdadeiro quando não havia cursor nenhum: a primeira batida.
 */
async function prepararCursor(db: Db, chave: string, antiga: string): Promise<boolean> {
  const ler = async (key: string) =>
    (
      await db
        .select({ value: schema.cursors.value })
        .from(schema.cursors)
        .where(and(eq(schema.cursors.source, TEAMS_SOURCE), eq(schema.cursors.key, key)))
    )[0]?.value;
  if ((await ler(chave)) !== undefined) return false;
  const herdado = chave === antiga ? undefined : await ler(antiga);
  // O cursor compartilhado deixou de andar quando os gatilhos ganharam o
  // próprio. Um valor velho herdado reprocessaria semanas de conversa, então só
  // vale o recente; o resto é primeira batida, com a janela de um dia.
  const recente = herdado !== undefined && Date.now() - Date.parse(herdado) < JANELA_DO_CURSOR_HERDADO_MS;
  if (herdado === undefined || !recente) return true;
  await db.insert(schema.cursors).values({ source: TEAMS_SOURCE, key: chave, value: herdado }).onConflictDoNothing();
  return false;
}

/**
 * Põe no evento com link de PR o contexto que o agent de revisão lê: título,
 * diff, CI e o dono e número que a ação de review precisa, como o Slack faz.
 *
 * O que não deve acordar o agent sai do resultado (`fora`) em vez de virar
 * run: PR que não deu para buscar (o erro sobe em `erros`, sem 👀), PR da
 * própria pessoa, PR fechado, já mergeado ou em rascunho, e PR no mesmo commit
 * que um evento das últimas 24h já pegou. O evento fica gravado com
 * `prDescartado` ou `prError`, para a mensagem não voltar como novidade.
 *
 * O `author` passa a ser o do PR, que é o que o bloqueio de auto-review
 * compara, e o do Teams fica em `teamsAuthor`. O `repo` também vira o do PR, o
 * que tira o evento do `teams.post`, que acha a conversa por ele.
 */
async function enriquecerPrs(
  ids: string[],
  kind: "inbox" | "channel",
  channel: string | undefined,
  db: Db,
  options: TeamsInboxOptions,
  revisados: () => Promise<Set<string>>,
): Promise<{ erros: TeamsInboxOutcome["errors"]; fora: Set<string>; descartes: TeamsInboxOutcome["descartes"] }> {
  const erros: TeamsInboxOutcome["errors"] = [];
  const descartes: TeamsInboxOutcome["descartes"] = [];
  const fora = new Set<string>();
  const buscar = options.fetchPr ?? defaultFetchPr;
  const quemSouNoGithub = options.viewerLogin ?? (() => githubService.viewerLogin());
  const falha = (error: string) =>
    erros.push({ kind, ...(channel === undefined ? {} : { channel }), error });
  const gravar = (id: string, payload: Record<string, unknown>) =>
    db.update(schema.events).set({ payload }).where(eq(schema.events.id, id));

  for (const id of ids) {
    try {
      const [evento] = await db.select().from(schema.events).where(eq(schema.events.id, id)).limit(1);
      const payload = evento?.payload as Record<string, unknown> | null | undefined;
      if (!payload?.prOwner || !payload.prRepo || !payload.prNumber) continue;
      if (payload.prDescartado !== undefined) {
        fora.add(id);
        continue;
      }
      if (payload.diff !== undefined) continue;

      const nome = `${payload.prOwner}/${payload.prRepo}#${payload.prNumber}`;
      let contexto: Awaited<ReturnType<typeof defaultFetchPr>>;
      try {
        contexto = await buscar(String(payload.prOwner), String(payload.prRepo), Number(payload.prNumber));
      } catch (err) {
        const erro = err instanceof Error ? err.message : String(err);
        await gravar(id, { ...payload, prError: erro });
        fora.add(id);
        falha(`PR ${nome}: ${erro}`);
        continue;
      }

      const motivo = await motivoDeDescarte(contexto, quemSouNoGithub, revisados);
      if (motivo !== null) {
        const { prError: _resolvido, ...resto } = payload;
        await gravar(id, { ...resto, prDescartado: motivo });
        fora.add(id);
        descartes.push({ pr: nome, motivo });
        continue;
      }
      (await revisados()).add(chaveDoCommit(contexto));

      const { prError: _resolvido, ...resto } = payload;
      await gravar(id, { ...resto, ...contexto, teamsAuthor: payload.author });
      await reagirAoPegar(payload, options);
    } catch (err) {
      falha(err instanceof Error ? err.message : String(err));
    }
  }
  return { erros, fora, descartes };
}

/** Janela em que o mesmo PR no mesmo commit não é revisado de novo. */
const JANELA_DO_MESMO_COMMIT_S = 24 * 60 * 60;

const chaveDoCommit = (c: { owner: string; repoName: string; pull: number; headSha: string }) =>
  `${c.owner}/${c.repoName}#${c.pull}@${c.headSha}`.toLowerCase();

function memoizar<T>(fn: () => Promise<T>): () => Promise<T> {
  let valor: Promise<T> | undefined;
  return () => (valor ??= fn());
}

/**
 * Os PRs e commits que já têm review, lidos uma vez por batida: a review da
 * ação `github.review_comment` publicada ou ainda em andamento nas últimas 24h
 * (rejeitada, falha ou em conflito não segura), e o evento do Teams que já
 * pegou o PR naquele commit, que é o link colado de novo. O evento do poll do
 * GitHub sozinho não conta: outro agent revisando não é este.
 */
async function carregarRevisados(db: Db): Promise<Set<string>> {
  const desde = Math.floor(Date.now() / 1000) - JANELA_DO_MESMO_COMMIT_S;
  const chave = (p: Record<string, unknown> | null | undefined, repo: unknown) =>
    p?.headSha === undefined || p.owner === undefined
      ? null
      : chaveDoCommit({ owner: String(p.owner), repoName: String(repo), pull: Number(p.pull), headSha: String(p.headSha) });

  const revisoes = await db
    .select({ payload: schema.approvals.payload })
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.kind, "github.review_comment"),
        gte(schema.approvals.createdAt, desde),
        notInArray(schema.approvals.status, ["rejected", "failed", "conflict"]),
      ),
    );
  const doTeams = await db
    .select({ payload: schema.events.payload })
    .from(schema.events)
    .where(and(eq(schema.events.source, TEAMS_SOURCE), gte(schema.events.receivedAt, desde)));

  const vistos = new Set<string>();
  for (const { payload } of revisoes) {
    const p = payload as Record<string, unknown> | null;
    const k = chave(p, p?.repo);
    if (k !== null) vistos.add(k);
  }
  for (const { payload } of doTeams) {
    const p = payload as Record<string, unknown> | null;
    if (p?.prDescartado !== undefined) continue;
    const k = chave(p, p?.repoName);
    if (k !== null) vistos.add(k);
  }
  return vistos;
}

/** Por que o PR não merece revisão agora, ou nulo se merece. */
async function motivoDeDescarte(
  contexto: Awaited<ReturnType<typeof defaultFetchPr>>,
  quemSouNoGithub: () => Promise<string | null>,
  revisados: () => Promise<Set<string>>,
): Promise<string | null> {
  if (contexto.state !== undefined && contexto.state !== "open") return "fechado";
  if (contexto.merged === true) return "mergeado";
  if (contexto.draft === true) return "rascunho";

  // Sem saber quem sou (token ausente, rede), segue: o `propose` da ação
  // ainda barra a review no próprio PR.
  const eu = await quemSouNoGithub().catch(() => null);
  if (eu !== null && contexto.author.toLowerCase() === eu.toLowerCase()) return "proprio";

  return (await revisados()).has(chaveDoCommit(contexto)) ? "repetido" : null;
}

/** O 👀 de "peguei". Recusa do Graph vira log: a revisão não depende da reação. */
async function reagirAoPegar(payload: Record<string, unknown>, options: TeamsInboxOptions): Promise<void> {
  const alvo = alvoDaReacao(payload);
  if (alvo === null) return;
  try {
    await reagirNoTeams(alvo, "set", REACAO_PEGOU, options);
  } catch (err) {
    console.error(`reagir com ${REACAO_PEGOU} no Teams falhou: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * As mensagens novas de um canal, das threads e das respostas.
 *
 * O Graph não filtra mensagem de canal por data fora da consulta delta, que
 * devolve o canal inteiro na primeira vez. A lista comum vem com as threads
 * mais recentes primeiro e as respostas junto, e uma página de cinquenta
 * cobre com folga os cinco minutos entre batidas. Quem fica além disso é o
 * mais velho, e o cursor anda por cima dele, pelo mesmo motivo de `PAGINAS`.
 */
function doCanal(graph: GraphGet, canal: TeamsChannelRef): McpCaller {
  return async (_server, _tool, args) => {
    const desde = String(args.since);
    const resposta = await graph(
      `/teams/${encodeURIComponent(canal.teamId)}/channels/${encodeURIComponent(canal.channelId)}` +
        `/messages?$top=${POR_PAGINA}&$expand=replies`,
    );
    const threads = Array.isArray(resposta.value) ? resposta.value : [];
    const mensagens: unknown[] = [];
    for (const item of threads) {
      const raiz = (item ?? {}) as Record<string, unknown>;
      const respostas = Array.isArray(raiz.replies) ? raiz.replies : [];
      for (const mensagem of [raiz, ...respostas]) {
        const criada = carimbo((mensagem as { createdDateTime?: unknown } | null)?.createdDateTime);
        if (criada === null || criada <= desde) continue;
        const { replies: _fora, ...sem } = mensagem as Record<string, unknown>;
        mensagens.push({ ...sem, threadId: typeof raiz.id === "string" ? raiz.id : null });
      }
    }
    return { messages: mensagens };
  };
}

/**
 * Mensagem de canal que pede atenção: alguém marcou a pessoa, ou ela traz
 * link de PR com `prLinks` ligado. A mensagem da própria pessoa só conta
 * pelo link, que ela pode ter colado.
 */
export function channelMessages(
  payload: unknown,
  eu: string,
  watch: TeamsInboxWatch = { mentions: true, dms: false },
): unknown[] {
  const lista = (payload as { messages?: unknown } | null | undefined)?.messages;
  if (!Array.isArray(lista)) return [];
  return lista.filter((item) => {
    const bruto = (item ?? {}) as Record<string, unknown>;
    const autor = ((bruto.from ?? {}) as { user?: { id?: unknown } | null }).user;
    return (
      typeof bruto.id === "string" &&
      typeof bruto.threadId === "string" &&
      bruto.messageType === "message" &&
      (bruto.deletedDateTime === null || bruto.deletedDateTime === undefined) &&
      typeof autor?.id === "string" &&
      carimbo(bruto.createdDateTime) !== null &&
      (autor.id === eu
        ? comLinkDePr(bruto, "channel", watch)
        : kindOf({ ...bruto, chatType: "channel" }, eu, { ...watch, dms: false }) === "mention" ||
          comLinkDePr(bruto, "channel", watch))
    );
  });
}

/**
 * O `repo` de um evento de canal: equipe, canal e a thread onde a resposta
 * entra. É por ele que a resposta aprovada acha o destino, como a conversa.
 */
export function channelRepo(teamId: string, channelId: string, threadId: string): string {
  return `${TEAMS_CHANNEL_PREFIX}${teamId}/${channelId}/${threadId}`;
}

function canalShape(canal: TeamsChannelRef, eu: string, watch: TeamsInboxWatch, chave: string): McpPollShape {
  const traduzir = (item: unknown) => {
    const bruto = (item ?? {}) as Record<string, unknown>;
    const pr = prDoItem(item);
    const mensagem = normalizeInbox(
      { ...bruto, chatId: canal.channelId, chatType: "channel" },
      pr === null ? "mention" : "pr",
    );
    return { mensagem, threadId: String(bruto.threadId), pr };
  };
  return {
    source: TEAMS_SOURCE,
    key: chave,
    initialCursor: inicial(),
    items: (payload) => umEventoPorPr(channelMessages(payload, eu, watch), watch),
    externalId: (item) =>
      `teams:channel:${canal.channelId}:${traduzir(item).mensagem.messageId}${sufixoDoPr(prDoItem(item))}`,
    stamp: (item) => traduzir(item).mensagem.createdAt,
    payload: (item) => {
      const { mensagem, threadId, pr } = traduzir(item);
      return {
        repo: channelRepo(canal.teamId, canal.channelId, threadId),
        changedFiles: [],
        server: TEAMS_SERVER,
        kind: mensagem.kind,
        teamId: canal.teamId,
        channelId: canal.channelId,
        channel: canal.label ?? canal.channelId,
        threadId,
        chatType: "channel",
        author: mensagem.author,
        authorId: mensagem.authorId,
        text: mensagem.text,
        messageId: mensagem.messageId,
        webUrl: mensagem.webUrl,
        item,
        ...(pr === null
          ? {}
          : {
              ...camposDoPr(pr),
              teamsTeamId: canal.teamId,
              teamsChannelId: canal.channelId,
              teamsMessageId: mensagem.messageId,
              // Resposta numa thread reage pelo caminho de reply.
              ...(threadId !== mensagem.messageId ? { teamsReplyToId: threadId } : {}),
            }),
      };
    },
  };
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
      carimbo(bruto.createdDateTime) !== null &&
      (autor.id === eu
        ? comLinkDePr(bruto, String(bruto.chatType ?? ""), watch)
        : kindOf(item, eu, watch) !== null || comLinkDePr(bruto, String(bruto.chatType ?? ""), watch))
    );
  });
}

/** Os links de PR do corpo cru da mensagem, onde o `href` ainda existe. */
function linksDe(bruto: Record<string, unknown>): ParsedGithubPr[] {
  const corpo = (bruto.body ?? {}) as { content?: unknown };
  return typeof corpo.content === "string" ? extractGithubPrLinks(corpo.content) : [];
}

/**
 * A mensagem traz link de PR e o gatilho quer isso naquela conversa. Reunião
 * fica de fora: só a menção acorda ali, pelo mesmo motivo de `dms`.
 */
function comLinkDePr(bruto: Record<string, unknown>, chatType: string, watch: TeamsInboxWatch): boolean {
  if (!watch.prLinks) return false;
  if (antesDaAtivacao(bruto, watch)) return false;
  if (chatType !== "channel" && chatType !== "oneOnOne" && chatType !== "group") return false;
  return linksDe(bruto).length > 0;
}

/**
 * Com `prLinks`, a mensagem com link vira um item por PR, cada um com o seu
 * `prLink`. O evento é do PR e não da mensagem, e a chave de deduplicação leva
 * o PR junto: editar a mensagem não duplica, e acrescentar um segundo link
 * gera só o evento novo.
 */
function umEventoPorPr(itens: unknown[], watch: TeamsInboxWatch): unknown[] {
  if (!watch.prLinks) return itens;
  return itens.flatMap((item) => {
    if (antesDaAtivacao((item ?? {}) as Record<string, unknown>, watch)) return [item];
    const prs = linksDe((item ?? {}) as Record<string, unknown>);
    return prs.length === 0 ? [item] : prs.map((prLink) => ({ ...(item as object), prLink }));
  });
}

/** Mensagem criada antes de o gatilho começar a olhar link de PR. */
function antesDaAtivacao(bruto: Record<string, unknown>, watch: TeamsInboxWatch): boolean {
  if (watch.prDesde === undefined) return false;
  const criada = carimbo(bruto.createdDateTime);
  return criada === null || criada < watch.prDesde;
}

function prDoItem(item: unknown): ParsedGithubPr | null {
  const pr = (item as { prLink?: ParsedGithubPr } | null)?.prLink;
  return pr ?? null;
}

const sufixoDoPr = (pr: ParsedGithubPr | null): string =>
  pr === null ? "" : `:pr:${pr.owner}/${pr.repo}#${pr.pull}`.toLowerCase();

function camposDoPr(pr: ParsedGithubPr) {
  return { repo: `${pr.owner}/${pr.repo}`, prOwner: pr.owner, prRepo: pr.repo, prNumber: pr.pull };
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

function inboxShape(watch: TeamsInboxWatch, eu: string, chave: string): McpPollShape {
  const tipo = (item: unknown): TeamsInboxKind =>
    prDoItem(item) !== null ? "pr" : (kindOf(item, eu, watch) ?? "dm");
  return {
    source: TEAMS_SOURCE,
    key: chave,
    initialCursor: inicial(),
    items: (payload) => umEventoPorPr(inboxMessages(payload, eu, watch), watch),
    externalId: (item) => {
      const mensagem = normalizeInbox(item, tipo(item));
      return `teams:${mensagem.chatId}:${mensagem.messageId}${sufixoDoPr(prDoItem(item))}`;
    },
    stamp: (item) => normalizeInbox(item, tipo(item)).createdAt,
    payload: (item) => {
      const mensagem = normalizeInbox(item, tipo(item));
      const pr = prDoItem(item);
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
        ...(pr === null ? {} : { ...camposDoPr(pr), teamsChatId: mensagem.chatId, teamsMessageId: mensagem.messageId }),
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
