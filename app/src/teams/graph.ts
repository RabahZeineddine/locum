import { McpRegistry } from "../mcp/registry.js";
import type { McpToolInfo } from "../mcp/registry.js";
import { mcpOAuthService } from "../services/mcp-oauth-service.js";
import { mcpService, type McpService } from "../services/mcp-service.js";
import { GRAPH_URL, TEAMS_SERVER } from "../services/teams-app.js";
import { clienteHttp } from "../net/http.js";
import { unwrap, type McpCaller } from "../sources/mcp-poll.js";

/** Um GET no Graph, com o endereço relativo ou o `@odata.nextLink` inteiro. */
export type GraphGet = (caminho: string) => Promise<Record<string, unknown>>;

/**
 * Por onde o Locum fala com o Teams: o login nativo (Graph direto) ou um
 * servidor MCP que já expõe as ferramentas de Teams. Quem varre e quem escreve
 * só conhece esta interface, e as rotas são as do Graph nos dois casos.
 */
export interface TeamsGraph {
  get: GraphGet;
  /** `recusa` completa "o Graph recusou ...", para a mensagem de erro dizer o que não saiu. */
  post(caminho: string, corpo: unknown, recusa: string): Promise<void>;
  /** Nulo é o login nativo; senão, o nome do servidor MCP. */
  servidor: string | null;
  /** Solta o que a sessão segurou (o servidor MCP aberto para a batida). */
  close(): Promise<void>;
}

export interface TeamsGraphOptions {
  /** Token do Graph. Ausente é o que a conexão do Teams guardou. */
  token?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  graphUrl?: string;
  /** Já pronto, para o teste. Sobrepõe tudo. */
  graph?: TeamsGraph;
  /** Onde achar o servidor MCP do Teams. Existe para o teste trocar. */
  mcp?: Pick<McpService, "list" | "cachedTools">;
  /** Quem chama a ferramenta do servidor. Ausente sobe o servidor cadastrado. */
  call?: McpCaller;
}

/** O Graph pelo login nativo do Teams. */
export function graphNativo(token: string, fetchFn: typeof fetch, graphUrl: string): TeamsGraph {
  const cabecalho = { Authorization: `Bearer ${token}` };
  const codigoDe = async (resposta: Response) => {
    const corpo = (await resposta.json().catch(() => ({}))) as { error?: { code?: unknown } };
    return typeof corpo.error?.code === "string" ? `: ${corpo.error.code}` : "";
  };
  return {
    servidor: null,
    async close() {},
    async get(caminho) {
      const url = caminho.startsWith("https://") ? caminho : `${graphUrl}${caminho}`;
      const resposta = await fetchFn(url, { headers: cabecalho });
      if (!resposta.ok) throw new Error(`Graph respondeu ${resposta.status}${await codigoDe(resposta)}`);
      return (await resposta.json()) as Record<string, unknown>;
    },
    async post(caminho, corpo, recusa) {
      const resposta = await fetchFn(`${graphUrl}${caminho}`, {
        method: "POST",
        headers: { ...cabecalho, "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
      });
      // Falha precisa estourar: a gate fecha a pendência quando `publish`
      // volta, e fechar a de uma resposta que não saiu esconderia a falha.
      if (!resposta.ok) throw new Error(`Graph recusou ${recusa} com ${resposta.status}${await codigoDe(resposta)}`);
    },
  };
}

/** O que cada passo do Teams precisa que o servidor MCP ofereça. */
const LEITURA = ["get-current-user", "list-chats", "list-chat-messages"] as const;
const CANAL = ["list-channel-messages", "list-channel-message-replies"] as const;

export interface TeamsNoMcp {
  server: string;
  ligado: boolean;
  tools: string[];
  /** Ler as conversas: é o que liga o gatilho. */
  leitura: boolean;
  /** Ler as threads de canal de equipe. */
  canal: boolean;
  /** Mandar mensagem no chat, na thread do canal ou os dois. */
  responder: boolean;
  /** Reagir à mensagem, que é o 👀 de "peguei o PR". */
  reagir: boolean;
}

/** O que o conjunto de ferramentas de um servidor libera no Teams. */
export function capacidadesDoTeams(nomes: readonly string[]): Omit<TeamsNoMcp, "server" | "ligado" | "tools"> {
  const tem = (lista: readonly string[]) => lista.every((n) => nomes.includes(n));
  return {
    leitura: tem(LEITURA),
    canal: tem(CANAL),
    responder: nomes.includes("send-chat-message") || nomes.includes("reply-to-channel-message"),
    reagir: nomes.includes("set-chat-message-reaction") || nomes.includes("set-channel-message-reaction"),
  };
}

/**
 * O servidor MCP cadastrado que expõe as ferramentas de leitura do Teams, pela
 * lista de ferramentas que o Locum já guardou, e não pelo nome. O ligado ganha
 * do desligado; só um desligado ainda é devolvido, para o erro dizer qual ligar.
 */
export async function teamsNoMcp(
  mcp: Pick<McpService, "list" | "cachedTools"> = mcpService,
): Promise<TeamsNoMcp | null> {
  let desligado: TeamsNoMcp | null = null;
  for (const entrada of await mcp.list()) {
    const nome = entrada.config.name;
    const guardado = await mcp.cachedTools(nome);
    if (guardado === null) continue;
    const tools = guardado.tools.map((t) => t.name);
    const cap = capacidadesDoTeams(tools);
    if (!cap.leitura) continue;
    const achado: TeamsNoMcp = { server: nome, ligado: entrada.enabled, tools, ...cap };
    if (entrada.enabled) return achado;
    desligado ??= achado;
  }
  return desligado;
}

/** Normaliza nome de parâmetro: `chat-id`, `chatId` e `$top` viram `chatid` e `top`. */
const chaveDe = (nome: string) => nome.replace(/^\$/, "").replace(/[^a-z0-9]/gi, "").toLowerCase();

/** O nome que o servidor deu ao parâmetro, lido do esquema; sem esquema, o padrão do ms365. */
function nomeDoArg(tool: McpToolInfo | undefined, chave: string, padrao: string): string | null {
  const props = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (props === undefined) return padrao;
  return Object.keys(props).find((n) => chaveDe(n) === chave) ?? null;
}

/** Valor de cada argumento pela chave normalizada, com o nome que o ms365 usa. */
type Valores = Record<string, { valor: unknown; padrao: string }>;

const ROTA_DO_CANAL = /^\/teams\/([^/]+)\/channels\/([^/]+)\/messages$/;

/** O texto puro que o Graph aceita vira o HTML simples que o Teams desenha sem estragar. */
function comoHtml(corpo: unknown): unknown {
  const mensagem = (corpo as { body?: { contentType?: unknown; content?: unknown } } | null)?.body;
  if (mensagem?.contentType !== "text" || typeof mensagem.content !== "string") return corpo;
  const html = mensagem.content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, "<br>");
  return { ...(corpo as object), body: { contentType: "html", content: html } };
}

/**
 * O Graph traduzido para as ferramentas de um servidor MCP do Teams (as do
 * `@softeria/ms-365-mcp-server`). Os nomes dos argumentos saem do esquema que o
 * Locum guardou, não de uma lista fixa.
 */
export function graphPeloMcp(
  servidor: string,
  ferramentas: McpToolInfo[],
  chamar: McpCaller,
  fechar: () => Promise<void> = async () => {},
): TeamsGraph {
  const porNome = new Map(ferramentas.map((t) => [t.name, t]));

  const acionar = async (nome: string, valores: Valores, escrita = false) => {
    const tool = porNome.get(nome);
    if (tool === undefined) {
      throw new Error(
        `O servidor "${servidor}" não oferece o que o Teams pede aqui (${nome}). Confira em Conexões se a ferramenta está liberada.`,
      );
    }
    const args: Record<string, unknown> = {};
    for (const [chave, { valor, padrao }] of Object.entries(valores)) {
      const arg = nomeDoArg(tool, chave, padrao);
      if (arg !== null) args[arg] = valor;
    }
    // O ms365 pede confirmação em toda escrita; quando o Locum chega aqui a
    // pessoa já aprovou na Fila (ou é o 👀 que a regra da reação autoriza).
    const confirmar = escrita ? nomeDoArg(tool, "confirm", "confirm") : null;
    if (confirmar !== null) args[confirmar] = true;
    try {
      return unwrap(await chamar(servidor, nome, args));
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      throw new Error(
        `O Teams vem pelo servidor "${servidor}", e ele não respondeu (${motivo.slice(0, 200)}). ` +
          `Em Conexões, confira se ele está ligado e com login.`,
      );
    }
  };

  const v = (valor: unknown, padrao: string) => ({ valor, padrao });
  const consulta = (url: URL) => {
    const q: Valores = {};
    for (const [nome, valor] of url.searchParams) q[chaveDe(nome)] = v(valor, nome);
    return q;
  };

  const lista = async (nome: string, valores: Valores) => {
    const resposta = await acionar(nome, valores);
    return (resposta !== null && typeof resposta === "object" ? resposta : {}) as Record<string, unknown>;
  };

  return {
    servidor,
    close: fechar,

    async get(caminho) {
      const url = new URL(caminho, "https://graph.microsoft.com");
      const rota = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ""));
      const q = consulta(url);

      if (rota === "/me") return lista("get-current-user", q);
      if (rota === "/me/chats") return lista("list-chats", q);
      const chat = rota.match(/^\/chats\/([^/]+)\/messages$/);
      if (chat) return lista("list-chat-messages", { chatid: v(chat[1], "chatId"), ...q });

      const canal = rota.match(ROTA_DO_CANAL);
      if (canal) {
        const { expand: _expand, ...resto } = q;
        const raizes = await lista("list-channel-messages", {
          teamid: v(canal[1], "teamId"),
          channelid: v(canal[2], "channelId"),
          ...resto,
        });
        // O `$expand=replies` do Graph vira uma leitura de respostas por thread:
        // o servidor MCP não promete o expand.
        if (_expand?.valor !== "replies" || !Array.isArray(raizes.value)) return raizes;
        const value: unknown[] = [];
        for (const raiz of raizes.value) {
          const id = (raiz as { id?: unknown } | null)?.id;
          if (typeof id !== "string") {
            value.push(raiz);
            continue;
          }
          const respostas = await lista("list-channel-message-replies", {
            teamid: v(canal[1], "teamId"),
            channelid: v(canal[2], "channelId"),
            chatmessageid: v(id, "chatMessageId"),
            top: v("50", "$top"),
          });
          value.push({ ...(raiz as object), replies: Array.isArray(respostas.value) ? respostas.value : [] });
        }
        return { ...raizes, value };
      }
      throw new Error(`a rota ${rota} não tem ferramenta no servidor "${servidor}"`);
    },

    async post(caminho, corpo, _recusa) {
      const rota = decodeURIComponent(caminho.replace(/^\/v1\.0/, ""));
      const chat = rota.match(/^\/chats\/([^/]+)\/messages$/);
      if (chat) {
        await acionar("send-chat-message", { chatid: v(chat[1], "chatId"), body: v(comoHtml(corpo), "body") }, true);
        return;
      }
      const resposta = rota.match(/^\/teams\/([^/]+)\/channels\/([^/]+)\/messages\/([^/]+)\/replies$/);
      if (resposta) {
        await acionar(
          "reply-to-channel-message",
          {
            teamid: v(resposta[1], "teamId"),
            channelid: v(resposta[2], "channelId"),
            chatmessageid: v(resposta[3], "chatMessageId"),
            body: v(comoHtml(corpo), "body"),
          },
          true,
        );
        return;
      }
      const reacaoChat = rota.match(/^\/chats\/([^/]+)\/messages\/([^/]+)\/(set|unset)Reaction$/);
      if (reacaoChat) {
        await acionar(
          `${reacaoChat[3]}-chat-message-reaction`,
          { chatid: v(reacaoChat[1], "chatId"), chatmessageid: v(reacaoChat[2], "chatMessageId"), body: v(corpo, "body") },
          true,
        );
        return;
      }
      const reacaoCanal = rota.match(/^\/teams\/([^/]+)\/channels\/([^/]+)\/messages\/([^/]+)\/(set|unset)Reaction$/);
      if (reacaoCanal) {
        await acionar(
          `${reacaoCanal[4]}-channel-message-reaction`,
          {
            teamid: v(reacaoCanal[1], "teamId"),
            channelid: v(reacaoCanal[2], "channelId"),
            chatmessageid: v(reacaoCanal[3], "chatMessageId"),
            body: v(corpo, "body"),
          },
          true,
        );
        return;
      }
      throw new Error(`o servidor "${servidor}" não reage nem responde em ${rota}`);
    },
  };
}

/** Sobe o servidor cadastrado uma vez para a sessão e o encerra no `close`. */
async function sessaoNoServidor(
  servidor: string,
): Promise<{ call: McpCaller; close: () => Promise<void> }> {
  const configs = await mcpService.enabledConfigs();
  const registry = McpRegistry.fromList(configs);
  if (!registry.has(servidor)) {
    return {
      call: async () => {
        throw new Error(`servidor MCP "${servidor}" nao esta habilitado`);
      },
      close: async () => {},
    };
  }
  return { call: (s, t, a) => registry.callTool(s, t, a), close: () => registry.closeAll() };
}

/**
 * Abre o Teams: o login nativo quando existe, senão o servidor MCP que expõe as
 * ferramentas de Teams. Sem nenhum dos dois, o erro diz onde resolver.
 */
export async function abrirTeams(options: TeamsGraphOptions = {}): Promise<TeamsGraph> {
  if (options.graph !== undefined) return options.graph;
  const token = await (options.token ?? (() => mcpOAuthService.accessToken(TEAMS_SERVER)))();
  if (token !== null) return graphNativo(token, options.fetchFn ?? clienteHttp, options.graphUrl ?? GRAPH_URL);

  const mcp = options.mcp ?? mcpService;
  const achado = await teamsNoMcp(mcp);
  if (achado === null) {
    throw new Error(
      "O Teams não está conectado. Em Conexões, entre com o Teams ou ligue um servidor que o traga, como o ms365.",
    );
  }
  if (!achado.ligado) {
    throw new Error(`O Teams vem pelo servidor "${achado.server}", que está desligado. Ligue em Conexões.`);
  }
  const guardado = await mcp.cachedTools(achado.server);
  const ferramentas = guardado?.tools ?? [];
  if (options.call !== undefined) return graphPeloMcp(achado.server, ferramentas, options.call);
  const sessao = await sessaoNoServidor(achado.server);
  return graphPeloMcp(achado.server, ferramentas, sessao.call, sessao.close);
}
