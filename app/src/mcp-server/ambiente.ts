import { join } from "node:path";
import type { ConversasDeAgent } from "../agent-chat/conversas.js";
import type { SessaoDoClaude } from "../services/claude-sessions-service.js";
import { claudeSessionsService } from "../services/claude-sessions-service.js";
import { mcpOAuthService } from "../services/mcp-oauth-service.js";
import { SLACK_SERVER } from "../services/slack-app.js";
import { listSlackChannels, type SlackChannelOption } from "../slack/channels.js";
import { TEAMS_SERVER } from "../services/teams-app.js";
import { TemplateSource } from "../services/template-source.js";
import { listTeamsChannels, type TeamsChannelOption } from "../teams/channels.js";
import { listTeamsChats, type TeamsChatOption } from "../teams/chats.js";

export const RENOVAR_SLACK = "o acesso ao Slack venceu; abra o Locum para renovar o Slack";
export const RENOVAR_TEAMS = "o acesso ao Teams venceu; abra o Locum para renovar o Teams";

/**
 * O que o servidor pede de fora do banco: o Teams (Graph, com a conta da
 * pessoa), as pastas do Claude Code, o que só o processo do Electron tem e o
 * executor. Cada parte entra por aqui para o teste trocar, porque nenhum teste
 * chama o Teams nem publica de verdade, e para este módulo não importar o
 * Electron: quem sobe o `--mcp` entrega o que é dele.
 */
export interface Ambiente {
  teamsChats: (opcoes: { triggerId?: string }) => Promise<TeamsChatOption[]>;
  teamsChannels: () => Promise<TeamsChannelOption[]>;
  slackChannels: () => Promise<SlackChannelOption[]>;
  sessions: () => Promise<SessaoDoClaude[]>;
  /** O marketplace de agents: o repositório remoto, com a cópia empacotada de reserva. */
  templates: () => TemplateSource;
  /** O chat de cada agent da biblioteca. Só existe com o aplicativo; sem ele as ferramentas dizem isso. */
  agentChat: ConversasDeAgent | null;
  /** A etiqueta de idioma do sistema, que só o Electron sabe. */
  systemLocale: () => string;
  appVersion: () => string;
  /** A decisão da fila, pela gate do executor: a única porta de saída (ADR 0002). */
  decidir: (approvalId: string, decision: "approved" | "rejected") => Promise<{ status: string }>;
  resolverEstancada: (approvalId: string, outcome: "published" | "retry") => Promise<{ status: string }>;
}

/**
 * Este processo não faz o papel do aplicativo: renovar o acesso grava o grant
 * novo no cofre, e quem renova é o Locum aberto. Com o token nativo vencido o
 * pedido volta com o aviso, sem gravar nada. Sem login nativo, o Graph vem pelo
 * servidor MCP do Teams (ms365), que cuida da própria sessão.
 */
function tokenDoTeamsSemRenovar(): () => Promise<string | null> {
  return async () => {
    const { token, vencido } = mcpOAuthService.lerSemRenovar(TEAMS_SERVER);
    if (vencido) throw new Error(RENOVAR_TEAMS);
    return token;
  };
}

/** Mesma regra do Teams: o `--mcp` não renova, e o aviso manda abrir o Locum. */
function tokenDoSlackSemRenovar(): () => Promise<string | null> {
  return async () => {
    const { token, vencido } = mcpOAuthService.lerSemRenovar(SLACK_SERVER);
    if (vencido) throw new Error(RENOVAR_SLACK);
    return token;
  };
}

let fonte: TemplateSource | undefined;

export const ambientePadrao: Ambiente = {
  teamsChats: (opcoes) => listTeamsChats({ ...opcoes, token: tokenDoTeamsSemRenovar() }),
  teamsChannels: () => listTeamsChannels({ token: tokenDoTeamsSemRenovar() }),
  slackChannels: () => listSlackChannels({ token: tokenDoSlackSemRenovar() }),
  sessions: () => claudeSessionsService.list(),
  templates: () => (fonte ??= new TemplateSource({ pastaLocal: process.env.LOCUM_TEMPLATES_DIR ?? join(process.cwd(), "examples", "agents") })),
  agentChat: null,
  systemLocale: () => Intl.DateTimeFormat().resolvedOptions().locale,
  appVersion: () => process.env.npm_package_version ?? "desconhecida",
  decidir: async (id, decision) => (await (await import("../executor/build.js")).buildExecutor()).decide(id, decision),
  resolverEstancada: async (id, outcome) => (await (await import("../executor/build.js")).buildExecutor()).settleStuck(id, outcome),
};
