import { mcpOAuthService } from "../services/mcp-oauth-service.js";
import { SLACK_SERVER } from "../services/slack-app.js";
import { clienteHttpDeLeitura } from "../net/http.js";
import { SLACK_API_URL } from "../sources/slack-inbox.js";

/** Um canal que a pessoa pode observar. `id` é o que o cadastro e a varredura usam. */
export interface SlackChannelOption {
  id: string;
  name: string;
  isPrivate: boolean;
}

export interface ListSlackChannelsOptions {
  /** Token de usuário do Slack. Ausente é o que a conexão oficial guardou. */
  token?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  apiUrl?: string;
}

/** Páginas lidas no máximo, para quem está em milhares de canais. */
const TETO_DE_PAGINAS = 20;

/**
 * Os canais, públicos e privados, de que a pessoa participa.
 *
 * Vai à API Web com o token da conexão oficial, como a varredura de menções:
 * a resposta do servidor MCP é texto corrido, e id de canal montado de texto
 * corrido seria adivinhado. `users.conversations` devolve só onde a pessoa
 * está, e pede `channels:read` e `groups:read`, que o manifesto passou a ter.
 * Quem conectou antes precisa conectar de novo.
 */
export async function listSlackChannels(options: ListSlackChannelsOptions = {}): Promise<SlackChannelOption[]> {
  const token = await (options.token ?? (() => mcpOAuthService.accessToken(SLACK_SERVER)))();
  if (token === null) throw new Error("O Slack não está conectado. Em Conexões, entre pelo servidor oficial.");
  const fetchFn = options.fetchFn ?? clienteHttpDeLeitura;
  const apiUrl = options.apiUrl ?? SLACK_API_URL;

  const canais: SlackChannelOption[] = [];
  let cursor = "";
  for (let pagina = 0; pagina < TETO_DE_PAGINAS; pagina++) {
    const corpo = new URLSearchParams({ types: "public_channel,private_channel", exclude_archived: "true", limit: "200" });
    if (cursor !== "") corpo.set("cursor", cursor);
    const resposta = await fetchFn(`${apiUrl}/users.conversations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: corpo,
    });
    if (!resposta.ok) throw new Error(`Slack respondeu ${resposta.status} em users.conversations`);
    const json = (await resposta.json()) as {
      ok?: unknown;
      error?: unknown;
      channels?: unknown;
      response_metadata?: { next_cursor?: unknown };
    };
    if (json.ok !== true) {
      if (json.error === "missing_scope") {
        throw new Error("o token não tem os escopos de canal; atualize o app do Slack com o manifesto novo e conecte de novo");
      }
      throw new Error(`Slack recusou users.conversations: ${typeof json.error === "string" ? json.error : "sem motivo"}`);
    }
    for (const item of Array.isArray(json.channels) ? (json.channels as Record<string, unknown>[]) : []) {
      if (typeof item.id !== "string" || typeof item.name !== "string" || item.id === "" || item.name === "") continue;
      canais.push({ id: item.id, name: item.name, isPrivate: item.is_private === true });
    }
    const proximo = json.response_metadata?.next_cursor;
    if (typeof proximo !== "string" || proximo === "") break;
    cursor = proximo;
  }
  return canais.sort((a, b) => a.name.localeCompare(b.name));
}
