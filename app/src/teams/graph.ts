import { createHash } from "node:crypto";
import type { McpServerConfig } from "../config/types.js";
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
  /**
   * A conta do servidor MCP que esta sessão usa, quando ele atende mais de uma.
   * Vai gravada no evento, para a resposta e a reação saírem pela mesma conta
   * que leu, mesmo que a conta padrão do servidor mude no meio do caminho.
   */
  conta(): string | null;
  /** O servidor MCP atende mais de uma conta: a resposta precisa saber por qual sair. */
  multiConta: boolean;
  /** As contas que o servidor MCP atende (vazio no login nativo, ou sem a ferramenta que as lista). */
  contas?(): Promise<string[]>;
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
  /** A conta do servidor MCP com que o evento foi lido. Sem ela vale a padrão do servidor. */
  account?: string;
  /** A configuração do servidor ligado hoje, ou nulo. Ausente é a do cadastro. Existe para o teste trocar. */
  configDoServidor?: (servidor: string) => Promise<McpServerConfig | null>;
  /** Abre a sessão do servidor. Ausente sobe o servidor cadastrado. Existe para o teste trocar. */
  abrir?: (config: McpServerConfig) => Promise<SessaoMcp>;
}

/** Quem chama as ferramentas de um servidor e o solta quando acaba. */
export interface SessaoMcp {
  call: McpCaller;
  close: () => Promise<void>;
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
    conta: () => null,
    multiConta: false,
    async contas() {
      return [];
    },
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
  /** Reagir à mensagem, pelo passo `teams.react`. */
  reagir: boolean;
}

/** O que o conjunto de ferramentas de um servidor libera no Teams. */
export function capacidadesDoTeams(nomes: readonly string[]): Omit<TeamsNoMcp, "server" | "ligado" | "tools"> {
  const tem = (lista: readonly string[]) => lista.every((n) => nomes.includes(n));
  return {
    leitura: tem(LEITURA),
    canal: tem(CANAL),
    responder: ["send-chat-message", "reply-to-channel-message", "send-channel-message"].some((n) => nomes.includes(n)),
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


type Prop = Record<string, unknown>;

/** Normaliza nome de parâmetro: `chat-id`, `chatId` e `$top` viram `chatid` e `top`. */
const chaveDe = (nome: string) => nome.replace(/^\$/, "").replace(/[^a-z0-9]/gi, "").toLowerCase();

/** O parâmetro como o servidor o chamou, lido do esquema; sem esquema, o padrão do ms365. */
function achar(tool: McpToolInfo | undefined, chave: string, padrao: string): { nome: string; prop?: Prop } | null {
  const props = (tool?.inputSchema as { properties?: Record<string, Prop> } | undefined)?.properties;
  if (props === undefined) return { nome: padrao };
  const nome = Object.keys(props).find((n) => chaveDe(n) === chave);
  return nome === undefined ? null : { nome, prop: props[nome] as Prop };
}

/** Os tipos que o esquema aceita, entrando nos `anyOf`, `oneOf` e `allOf`. */
function tiposDe(prop: Prop, achados = new Set<string>()): Set<string> {
  const tipo = prop.type;
  for (const t of Array.isArray(tipo) ? tipo : tipo === undefined ? [] : [tipo]) achados.add(String(t));
  for (const chave of ["anyOf", "oneOf", "allOf"]) {
    const lista = prop[chave];
    if (Array.isArray(lista)) for (const item of lista) tiposDe(item as Prop, achados);
  }
  return achados;
}

/**
 * O valor da URL (sempre texto) no tipo que o esquema pede: `$top` e `$skip`
 * são inteiros no ms365, e texto ali volta como `invalid_query_parameter`.
 * Onde o esquema aceita texto, o texto vale.
 */
function noTipoDe(valor: unknown, prop: Prop | undefined): unknown {
  if (typeof valor !== "string" || prop === undefined) return valor;
  const tipos = tiposDe(prop);
  if (tipos.size === 0 || tipos.has("string")) return valor;
  if (tipos.has("integer") || tipos.has("number")) {
    const n = Number(valor);
    return valor.trim() !== "" && Number.isFinite(n) ? n : valor;
  }
  if (tipos.has("boolean")) return valor === "true";
  if (tipos.has("array")) return [valor];
  return valor;
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

const SEM_LOGIN = /\blogin\b|authenticat|unauthori[sz]ed|\b401\b|no accounts found|access token/i;
const VARIAS_CONTAS = /multiple accounts/i;

/**
 * O Graph traduzido para as ferramentas de um servidor MCP do Teams (as do
 * `@softeria/ms-365-mcp-server`). Os nomes e os tipos dos argumentos saem do
 * esquema que o Locum guardou, não de uma lista fixa.
 */
export function graphPeloMcp(
  servidor: string,
  ferramentas: McpToolInfo[],
  chamar: McpCaller,
  fechar: () => Promise<void> = async () => {},
  contaDada: string | null = null,
): TeamsGraph {
  const porNome = new Map(ferramentas.map((t) => [t.name, t]));
  const multiConta = ferramentas.some((t) => achar(t, "account", "account")?.prop !== undefined);
  let conta = contaDada;

  const acionar = async (nome: string, valores: Valores, escrita = false) => {
    const tool = porNome.get(nome);
    if (tool === undefined) {
      throw new Error(
        `O servidor "${servidor}" não oferece o que o Teams pede aqui (${nome}). Confira em Conexões se a ferramenta está liberada.`,
      );
    }
    const args: Record<string, unknown> = {};
    for (const [chave, { valor, padrao }] of Object.entries(valores)) {
      const arg = achar(tool, chave, padrao);
      if (arg !== null) args[arg.nome] = noTipoDe(valor, arg.prop);
    }
    // O ms365 pede confirmação em toda escrita; quando o Locum chega aqui a
    // pessoa já aprovou na Fila (ou o passo é de reação em modo automático, que a pessoa montou).
    const confirmar = escrita ? achar(tool, "confirm", "confirm") : null;
    if (confirmar !== null) args[confirmar.nome] = true;
    // Com mais de uma conta no servidor, a padrão muda quando a pessoa troca de
    // conta em outro lugar: a conta da leitura vai em toda chamada seguinte.
    const daConta = conta === null ? null : achar(tool, "account", "account");
    if (daConta?.prop !== undefined) args[daConta.nome] = conta;

    let bruto: unknown;
    try {
      bruto = await chamar(servidor, nome, args);
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      throw new Error(
        `O Teams vem pelo servidor "${servidor}", que não respondeu (${motivo.slice(0, 200)}). ` +
          `Em Conexões, confira se ele está ligado e com login.`,
      );
    }
    try {
      return unwrap(bruto);
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      if (VARIAS_CONTAS.test(motivo)) {
        throw new Error(
          `O servidor "${servidor}" tem várias contas e nenhuma escolhida. Escolha a conta padrão dele (select-account) e tente de novo.`,
        );
      }
      if (SEM_LOGIN.test(motivo)) {
        throw new Error(`O servidor "${servidor}" está sem login no Microsoft 365. Refaça o login dele em Conexões.`);
      }
      throw new Error(`O servidor "${servidor}" recusou o pedido do Teams: ${motivo.slice(0, 200)}`);
    }
  };

  const v = (valor: unknown, padrao: string) => ({ valor, padrao });
  const consulta = (url: URL) => {
    const q: Valores = {};
    for (const [nome, valor] of url.searchParams) q[chaveDe(nome)] = v(valor, nome);
    return q;
  };

  // O ms365 casa a conta pelo `username` do MSAL, que costuma ser o UPN mas não
  // garante: com `list-accounts`, vale o e-mail dele que bate com o UPN.
  const usernameDoServidor = async (upn: string): Promise<string> => {
    if (!porNome.has("list-accounts")) return upn;
    try {
      const contas = (await acionar("list-accounts", {})) as { accounts?: { email?: unknown }[] } | null;
      const achada = contas?.accounts?.find((c) => typeof c.email === "string" && c.email.toLowerCase() === upn.toLowerCase());
      return typeof achada?.email === "string" ? achada.email : upn;
    } catch {
      return upn;
    }
  };

  const lista = async (nome: string, valores: Valores) => {
    const resposta = await acionar(nome, valores);
    if (resposta === null || typeof resposta !== "object") {
      throw new Error(
        `O servidor "${servidor}" responde num formato que o Locum não lê. Desligue o modo toon dele e tente de novo.`,
      );
    }
    return resposta as Record<string, unknown>;
  };

  return {
    servidor,
    conta: () => conta,
    multiConta,
    close: fechar,
    async contas() {
      if (!porNome.has("list-accounts")) return [];
      try {
        const r = (await acionar("list-accounts", {})) as { accounts?: { email?: unknown }[] } | null;
        return (r?.accounts ?? []).flatMap((c) => (typeof c.email === "string" && c.email !== "" ? [c.email] : []));
      } catch {
        return [];
      }
    },

    async get(caminho) {
      const url = new URL(caminho, "https://graph.microsoft.com");
      const rota = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ""));
      const q = consulta(url);

      if (rota === "/me") {
        const eu = await lista("get-current-user", q);
        // A primeira resposta diz de que conta o servidor falou, para as outras
        // chamadas e para o evento.
        if (conta === null && multiConta && typeof eu.userPrincipalName === "string") {
          conta = await usernameDoServidor(eu.userPrincipalName);
        }
        return eu;
      }
      if (rota === "/me/chats") return lista("list-chats", q);
      if (rota === "/me/joinedTeams") return lista("list-joined-teams", q);
      const canaisDaEquipe = rota.match(/^\/teams\/([^/]+)\/channels$/);
      if (canaisDaEquipe) return lista("list-team-channels", { teamid: v(canaisDaEquipe[1], "teamId"), ...q });
      const chat = rota.match(/^\/chats\/([^/]+)\/messages$/);
      if (chat) return lista("list-chat-messages", { chatid: v(chat[1], "chatId"), ...q });

      const canal = rota.match(ROTA_DO_CANAL);
      if (canal) {
        const { expand, ...resto } = q;
        const raizes = await lista("list-channel-messages", {
          teamid: v(canal[1], "teamId"),
          channelid: v(canal[2], "channelId"),
          ...resto,
        });
        // O `$expand=replies` do Graph vira uma leitura de respostas por thread:
        // o servidor MCP não promete o expand.
        if (expand?.valor !== "replies" || !Array.isArray(raizes.value)) return raizes;
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
      const novaNoCanal = rota.match(/^\/teams\/([^/]+)\/channels\/([^/]+)\/messages$/);
      if (novaNoCanal) {
        await acionar(
          "send-channel-message",
          { teamid: v(novaNoCanal[1], "teamId"), channelid: v(novaNoCanal[2], "channelId"), body: v(comoHtml(corpo), "body") },
          true,
        );
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
      // O ms365 só reage na mensagem de canal, não na resposta de uma thread:
      // a reação de quem veio numa resposta fica na raiz da thread.
      const reacaoCanal = rota.match(
        /^\/teams\/([^/]+)\/channels\/([^/]+)\/messages\/([^/]+)(?:\/replies\/[^/]+)?\/(set|unset)Reaction$/,
      );
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

/** Quanto a sessão do servidor MCP fica de pé depois da última operação. */
const OCIOSA_MS = 20_000;

let viva: {
  servidor: string;
  marca: string;
  sessao: Promise<SessaoMcp>;
  usos: number;
  timer: NodeJS.Timeout | null;
  /** A configuração mudou: quem ainda usa termina, e a sessão fecha ao soltar a última. */
  descartada: boolean;
} | null = null;

const marcaDe = (config: McpServerConfig) => createHash("sha1").update(JSON.stringify(config)).digest("hex");

/**
 * A sessão do servidor MCP, reaproveitada entre operações próximas: a batida, o
 * `unset` e o `set` do fim do review e a resposta aprovada pegam o mesmo
 * processo em vez de subir um do ms365 cada um. Fecha depois de `OCIOSA_MS` sem uso.
 *
 * A sessão viva só vale enquanto a configuração do servidor for a de quando
 * abriu: servidor desligado ou editado descarta a sessão e reabre.
 */
export async function compartilhar(
  servidor: string,
  config: McpServerConfig,
  abrir: (config: McpServerConfig) => Promise<SessaoMcp>,
): Promise<SessaoMcp> {
  const marca = marcaDe(config);
  if (viva !== null && viva.servidor === servidor && viva.marca !== marca) {
    const velha = viva;
    viva = null;
    velha.descartada = true;
    if (velha.timer !== null) clearTimeout(velha.timer);
    if (velha.usos === 0) void velha.sessao.then((s) => s.close()).catch(() => undefined);
  }
  if (viva !== null && viva.servidor !== servidor) return abrir(config);
  const atual = (viva ??= { servidor, marca, sessao: abrir(config), usos: 0, timer: null, descartada: false });
  if (atual.timer !== null) clearTimeout(atual.timer);
  atual.timer = null;
  atual.usos++;
  let sessao: SessaoMcp;
  try {
    sessao = await atual.sessao;
  } catch (err) {
    atual.usos--;
    if (viva === atual) viva = null;
    throw err;
  }
  let solta = false;
  return {
    call: sessao.call,
    close: async () => {
      if (solta) return;
      solta = true;
      if (--atual.usos > 0) return;
      if (atual.descartada) {
        await sessao.close().catch(() => undefined);
        return;
      }
      atual.timer = setTimeout(() => {
        if (viva === atual) viva = null;
        void sessao.close().catch(() => undefined);
      }, OCIOSA_MS);
      atual.timer.unref();
    },
  };
}

/** Fecha já a sessão compartilhada, se houver. */
export async function soltarSessoes(): Promise<void> {
  const atual = viva;
  viva = null;
  if (atual === null) return;
  if (atual.timer !== null) clearTimeout(atual.timer);
  await (await atual.sessao).close().catch(() => undefined);
}

/** A configuração do servidor se ele está ligado agora, ou nulo. */
async function configLigada(servidor: string): Promise<McpServerConfig | null> {
  return (await mcpService.enabledConfigs()).find((c) => c.name === servidor) ?? null;
}

/** Sobe o servidor da configuração dada. */
async function abrirNoRegistro(config: McpServerConfig): Promise<SessaoMcp> {
  const registry = McpRegistry.fromList([config]);
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
  const ferramentas = (await mcp.cachedTools(achado.server))?.tools ?? [];
  const conta = options.account ?? null;
  if (options.call !== undefined) return graphPeloMcp(achado.server, ferramentas, options.call, undefined, conta);
  // Entre o cadastro lido e a chamada o servidor pode ter sido desligado ou editado.
  const config = await (options.configDoServidor ?? configLigada)(achado.server);
  if (config === null) {
    throw new Error(`O Teams vem pelo servidor "${achado.server}", que está desligado. Ligue em Conexões.`);
  }
  const sessao = await compartilhar(achado.server, config, options.abrir ?? abrirNoRegistro);
  return graphPeloMcp(achado.server, ferramentas, sessao.call, sessao.close, conta);
}

/**
 * O servidor MCP do Teams que atende mais de uma conta, lido do esquema que o
 * Locum guardou, sem subir sessão. Nulo no login nativo ou com conta única.
 */
export async function servidorDeVariasContas(options: TeamsGraphOptions = {}): Promise<string | null> {
  if (options.graph !== undefined) return options.graph.multiConta ? (options.graph.servidor ?? "") : null;
  const token = await (options.token ?? (() => mcpOAuthService.accessToken(TEAMS_SERVER)))();
  if (token !== null) return null;
  const mcp = options.mcp ?? mcpService;
  const achado = await teamsNoMcp(mcp);
  if (achado === null) return null;
  const ferramentas = (await mcp.cachedTools(achado.server))?.tools ?? [];
  return ferramentas.some((t) => achar(t, "account", "account")?.prop !== undefined) ? achado.server : null;
}

/** As contas do servidor MCP quando ele atende mais de uma; vazio no login nativo ou com conta única. */
export async function contasDoServidor(options: TeamsGraphOptions = {}): Promise<string[]> {
  if ((await servidorDeVariasContas(options)) === null) return [];
  const teams = await abrirTeams(options);
  try {
    return (await teams.contas?.()) ?? [];
  } finally {
    await teams.close();
  }
}
