import { abrirTeams, contasDoServidor, type TeamsGraphOptions } from "./graph.js";

/** Um canal que a pessoa pode observar, com o nome da equipe para a tela. */
export interface TeamsChannelOption {
  teamId: string;
  teamName: string;
  channelId: string;
  channelName: string;
  /** A conta do servidor MCP por onde a lista saiu; o destino fixo grava junto com a conversa. */
  conta?: string;
}

/** Teto de equipes lidas, para quem está em centenas delas. */
const TETO_DE_EQUIPES = 50;

export type ListTeamsChannelsOptions = TeamsGraphOptions;

/**
 * As equipes de que a pessoa participa e os canais de cada uma.
 *
 * Só leitura de nome, para a tela montar a escolha. Pede `Team.ReadBasic.All`
 * e `Channel.ReadBasic.All`, que entram com os escopos de canal: sem eles o
 * Graph responde 403, e a mensagem diz o que fazer.
 */
export async function listTeamsChannels(options: ListTeamsChannelsOptions = {}): Promise<TeamsChannelOption[]> {
  // Servidor com várias contas e nenhuma dada: a lista traz as de todas, cada uma marcada.
  if (options.account === undefined) {
    const contas = await contasDoServidor(options);
    if (contas.length > 0) {
      const porConta: TeamsChannelOption[][] = [];
      for (const conta of contas) porConta.push(await listTeamsChannels({ ...options, account: conta }));
      return porConta.flat();
    }
  }
  const teams = await abrirTeams(options);
  try {
    const get = async (caminho: string): Promise<Record<string, unknown>[]> => {
      let corpo: Record<string, unknown>;
      try {
        corpo = await teams.get(caminho);
      } catch (err) {
        if (teams.servidor === null && err instanceof Error && /^Graph respondeu 403/.test(err.message)) {
          throw new Error("o token não tem os escopos de canal; ligue canais e conecte de novo");
        }
        throw err;
      }
      return Array.isArray(corpo.value) ? (corpo.value as Record<string, unknown>[]) : [];
    };

    // A conta do servidor só é descoberta na primeira chamada a /me.
    if (teams.multiConta) await teams.get("/me?$select=id,userPrincipalName");
    const equipes = (await get("/me/joinedTeams?$select=id,displayName")).slice(0, TETO_DE_EQUIPES);
    const conta = teams.conta();
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
          ...(conta === null ? {} : { conta }),
        });
      }
    }
    return opcoes;
  } finally {
    await teams.close();
  }
}
