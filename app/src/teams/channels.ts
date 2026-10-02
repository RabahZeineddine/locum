import { mcpOAuthService } from "../services/mcp-oauth-service.js";
import { GRAPH_URL, TEAMS_SERVER } from "../services/teams-app.js";
import { clienteHttp } from "../net/http.js";

/** Um canal que a pessoa pode observar, com o nome da equipe para a tela. */
export interface TeamsChannelOption {
  teamId: string;
  teamName: string;
  channelId: string;
  channelName: string;
}

/** Teto de equipes lidas, para quem está em centenas delas. */
const TETO_DE_EQUIPES = 50;

export interface ListTeamsChannelsOptions {
  token?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  graphUrl?: string;
}

/**
 * As equipes de que a pessoa participa e os canais de cada uma.
 *
 * Só leitura de nome, para a tela montar a escolha. Pede `Team.ReadBasic.All`
 * e `Channel.ReadBasic.All`, que entram com os escopos de canal: sem eles o
 * Graph responde 403, e a mensagem diz o que fazer.
 */
export async function listTeamsChannels(options: ListTeamsChannelsOptions = {}): Promise<TeamsChannelOption[]> {
  const token = await (options.token ?? (() => mcpOAuthService.accessToken(TEAMS_SERVER)))();
  if (token === null) throw new Error("o Teams não está conectado");
  const fetchFn = options.fetchFn ?? clienteHttp;
  const graphUrl = options.graphUrl ?? GRAPH_URL;

  const get = async (caminho: string): Promise<Record<string, unknown>[]> => {
    const resposta = await fetchFn(`${graphUrl}${caminho}`, { headers: { Authorization: `Bearer ${token}` } });
    if (resposta.status === 403) {
      throw new Error("o token não tem os escopos de canal; ligue canais e conecte de novo");
    }
    if (!resposta.ok) throw new Error(`Graph respondeu ${resposta.status}`);
    const corpo = (await resposta.json()) as { value?: unknown };
    return Array.isArray(corpo.value) ? (corpo.value as Record<string, unknown>[]) : [];
  };

  const equipes = (await get("/me/joinedTeams?$select=id,displayName")).slice(0, TETO_DE_EQUIPES);
  const opcoes: TeamsChannelOption[] = [];
  for (const equipe of equipes) {
    if (typeof equipe.id !== "string") continue;
    const canais = await get(`/teams/${encodeURIComponent(equipe.id)}/channels?$select=id,displayName`);
    for (const canal of canais) {
      if (typeof canal.id !== "string") continue;
      opcoes.push({
        teamId: equipe.id,
        teamName: String(equipe.displayName ?? equipe.id),
        channelId: canal.id,
        channelName: String(canal.displayName ?? canal.id),
      });
    }
  }
  return opcoes;
}
