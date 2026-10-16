import { mcpOAuthService } from "../services/mcp-oauth-service.js";
import { SLACK_SERVER } from "../services/slack-app.js";
import { slackService } from "../services/slack-service.js";
import { SlackChannelsError } from "./channels-erro.js";
import { clienteHttpDeLeitura } from "../net/http.js";
import { SLACK_API_URL } from "../sources/slack-inbox.js";

/** Um canal que a pessoa pode observar. `id` é o que o cadastro e a varredura usam. */
export interface SlackChannelOption {
  id: string;
  name: string;
  isPrivate: boolean;
}

/** O resultado da listagem. */
export interface SlackChannelList {
  canais: SlackChannelOption[];
  /** A lista parou no teto de páginas: há canais que não vieram. */
  truncado: boolean;
  /** Quantos canais vieram, para a tela dizer onde a lista parou. */
  total: number;
  /** Dos ids pedidos, os que a lista não trouxe e o Slack diz estar arquivados. */
  arquivados: SlackChannelOption[];
  /** Dos ids pedidos, os que nem a consulta direta achou. */
  naoEncontrados: string[];
}

export { SlackChannelsError, codigoDoErroDeCanais, type SlackChannelsErrorCode } from "./channels-erro.js";

export interface ListSlackChannelsOptions {
  /** Token de usuário do Slack. Ausente é o que a conexão oficial guardou. */
  token?: () => Promise<string | null>;
  /** O servidor MCP de origem do Slack no cadastro. Ausente é o do cadastro desta máquina. */
  origem?: () => Promise<string | null>;
  /** Se o token tem grant de OAuth. Ausente é o cofre do Locum. */
  temGrant?: () => boolean;
  fetchFn?: typeof fetch;
  apiUrl?: string;
  /** Canais já escolhidos: os que a lista não trouxer são consultados um a um, para saber de arquivado. */
  ids?: readonly string[];
  tetoDePaginas?: number;
}

/** Páginas lidas no máximo, para quem está em milhares de canais. */
export const TETO_DE_PAGINAS = 20;
const POR_PAGINA = 200;
/** Consultas diretas no máximo, uma por canal escolhido que a lista não trouxe. */
const TETO_DE_CONSULTAS = 30;

/**
 * Os canais, públicos e privados, de que a pessoa participa.
 *
 * Vai à API Web com o token da conexão oficial, como a varredura de menções:
 * a resposta do servidor MCP é texto corrido, e id de canal montado de texto
 * corrido seria adivinhado. `users.conversations` devolve só onde a pessoa
 * está, e pede `channels:read` e `groups:read`, que o manifesto passou a ter.
 *
 * Só vale para a origem oficial com grant de OAuth. Servidor importado traz o
 * token em variável de ambiente, que pode ser de bot (`xoxb`) ou de navegador
 * (`xoxc`), e usá-lo aqui listaria o que a pessoa não escolheu ver.
 */
export async function listSlackChannels(options: ListSlackChannelsOptions = {}): Promise<SlackChannelList> {
  const servidor = await (options.origem ?? (async () => (await slackService.get()).server))();
  if (servidor !== null && servidor !== SLACK_SERVER) throw new SlackChannelsError("outro-servidor");
  const token = await (options.token ?? (() => mcpOAuthService.accessToken(SLACK_SERVER)))();
  if (token === null) throw new SlackChannelsError("sem-conexao");
  if (!(options.temGrant ?? (() => mcpOAuthService.hasGrant(SLACK_SERVER)))()) throw new SlackChannelsError("outro-servidor");

  const fetchFn = options.fetchFn ?? clienteHttpDeLeitura;
  const apiUrl = options.apiUrl ?? SLACK_API_URL;
  const chamar = async (metodo: string, parametros: Record<string, string>): Promise<Record<string, unknown>> => {
    const resposta = await fetchFn(`${apiUrl}/${metodo}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(parametros),
    });
    if (!resposta.ok) throw new Error(`Slack respondeu ${resposta.status} em ${metodo}`);
    return (await resposta.json()) as Record<string, unknown>;
  };

  const teto = options.tetoDePaginas ?? TETO_DE_PAGINAS;
  const canais: SlackChannelOption[] = [];
  let cursor = "";
  let truncado = false;
  for (let pagina = 0; ; pagina++) {
    if (pagina >= teto) {
      truncado = true;
      break;
    }
    const json = await chamar("users.conversations", {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: String(POR_PAGINA),
      ...(cursor === "" ? {} : { cursor }),
    });
    if (json.ok !== true) {
      if (json.error === "missing_scope") throw new SlackChannelsError("sem-escopo");
      throw new Error(`Slack recusou users.conversations: ${typeof json.error === "string" ? json.error : "sem motivo"}`);
    }
    for (const item of Array.isArray(json.channels) ? (json.channels as Record<string, unknown>[]) : []) {
      const canal = canalDe(item);
      if (canal !== null) canais.push(canal);
    }
    const proximo = (json.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
    if (typeof proximo !== "string" || proximo === "") break;
    cursor = proximo;
  }

  const total = canais.length;
  const arquivados: SlackChannelOption[] = [];
  const naoEncontrados: string[] = [];
  const vistos = new Set(canais.map((c) => c.id));
  // Com a lista truncada, ausência não diz nada: o canal pode estar na parte que não veio.
  const faltando = (options.ids ?? []).filter((id) => !vistos.has(id)).slice(0, TETO_DE_CONSULTAS);
  for (const id of faltando) {
    const json = await chamar("conversations.info", { channel: id });
    const canal = json.ok === true ? canalDe((json.channel ?? {}) as Record<string, unknown>) : null;
    if (canal === null) {
      naoEncontrados.push(id);
    } else if ((json.channel as { is_archived?: unknown }).is_archived === true) {
      arquivados.push(canal);
    } else {
      canais.push(canal);
    }
  }
  canais.sort((a, b) => a.name.localeCompare(b.name));
  return { canais, truncado, total, arquivados, naoEncontrados };
}

function canalDe(item: Record<string, unknown>): SlackChannelOption | null {
  if (typeof item.id !== "string" || typeof item.name !== "string" || item.id === "" || item.name === "") return null;
  return { id: item.id, name: item.name, isPrivate: item.is_private === true };
}
