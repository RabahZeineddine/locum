import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { claudeSessionsService, type SessaoDoClaude } from "../services/claude-sessions-service.js";
import { connectionService } from "../services/connection-service.js";
import { githubService } from "../services/github-service.js";
import { listTeamsChannels, type TeamsChannelOption } from "../teams/channels.js";
import { listTeamsChats, type TeamsChatOption } from "../teams/chats.js";
import { redactSecrets } from "./redact.js";
import { respond } from "./respond.js";

/**
 * O que lê de fora do banco: o Teams, pelo Graph com a conta da pessoa, e as
 * pastas do Claude Code e do opencode no home dela. Entra por parametro para o
 * teste trocar, porque nenhum teste chama o Teams de verdade nem lê o home.
 */
export interface LeituraDeFora {
  teamsChats: (opcoes: { triggerId?: string }) => Promise<TeamsChatOption[]>;
  teamsChannels: () => Promise<TeamsChannelOption[]>;
  sessions: () => Promise<SessaoDoClaude[]>;
}

export const leituraPadrao: LeituraDeFora = {
  teamsChats: (opcoes) => listTeamsChats(opcoes),
  teamsChannels: () => listTeamsChannels(),
  sessions: () => claudeSessionsService.list(),
};

/**
 * Ferramentas de leitura de conexões, de listas para configurar gatilho e de
 * sessões do Claude Code.
 *
 * Só leitura. Conectar e desconectar conta, guardar segredo e usar o vínculo do
 * `gh` ficam na tela: são decisões da pessoa sobre o que o Locum pode usar em
 * nome dela. Nada daqui devolve token, e o texto livre passa pela redação.
 */
export function registerConnectionTools(server: McpServer, fora: LeituraDeFora = leituraPadrao): void {
  server.registerTool(
    "list_connections",
    {
      description:
        "State of each connection on this machine: the catalog (GitHub, Slack, Teams, Atlassian...) and the MCP servers registered outside it, with state, account, reason when it is not ok, tool counts and the servers behind it. GitHub also reports its status: stored token, link to a gh account (host and login) or token from the environment, and the last check. Never returns a secret.",
      inputSchema: {},
    },
    async () =>
      respond(async () =>
        redactSecrets({ connections: await connectionService.list(), github: await githubService.status() }),
      ),
  );

  server.registerTool(
    "list_teams_chats",
    {
      description:
        "Group and direct Teams chats of the connected account, with id, label and type, to fill the chats of a teams-inbox trigger (set_trigger, save_automation). Reads Teams: needs the Teams connection. With triggerId, reads through the account that trigger saved.",
      inputSchema: { triggerId: z.string().optional() },
    },
    async ({ triggerId }) => respond(() => fora.teamsChats(triggerId === undefined ? {} : { triggerId })),
  );

  server.registerTool(
    "list_teams_channels",
    {
      description:
        "Teams channels of the connected account, with team id, channel id and label, to fill the channels of a teams-inbox trigger. Reads Teams: needs the Teams connection with the channel scopes.",
      inputSchema: {},
    },
    async () => respond(() => fora.teamsChannels()),
  );

  server.registerTool(
    "list_sessions",
    {
      description:
        "Claude Code and opencode sessions on this machine (read from their own folders): id, title, directory, branch, state, last activity, last prompt and reply. Read only: marking done and resuming are the person's.",
      inputSchema: {},
    },
    async () => respond(async () => redactSecrets(await fora.sessions())),
  );
}
