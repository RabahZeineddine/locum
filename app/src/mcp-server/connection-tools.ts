import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { claudeAccountService } from "../runtimes/claude-account.js";
import { claudeCodeService } from "../services/claude-code-service.js";
import { claudeImportService } from "../services/claude-import.js";
import { connectionService } from "../services/connection-service.js";
import { credentialService } from "../services/credential-service.js";
import { githubService } from "../services/github-service.js";
import { grafanaService } from "../services/grafana-service.js";
import { opencodeService } from "../services/opencode-service.js";
import { slackService, type SlackSourceInput } from "../services/slack-service.js";
import { trackerService, type TrackerRegistration } from "../services/tracker-service.js";
import type { Ambiente } from "./ambiente.js";
import { def } from "./tool-def.js";

/**
 * Conexões, contas e segredos, o que a tela de Conexões faz.
 *
 * Segredo entra e não sai: as ferramentas que guardam token ou chave aceitam o
 * valor como argumento e devolvem só o estado, e toda saída ainda passa pela
 * redação. Conexão que autoriza no navegador (OAuth) abre o fluxo no aplicativo
 * e volta em seguida, dizendo para concluir lá: esperar a pessoa clicar no
 * navegador estouraria o tempo da chamada.
 */

/** Espera um pouco o fluxo falhar cedo (dado inválido); se segue, devolve o aviso de concluir no navegador. */
async function abrirFluxo(fluxo: Promise<unknown>, aviso: string): Promise<{ status: "aguardando" | "concluido"; aviso?: string }> {
  fluxo.catch((erro: unknown) => console.error("conexão:", erro instanceof Error ? erro.message : erro));
  const primeiro = await Promise.race([
    fluxo.then(() => "concluido" as const),
    new Promise<"aguardando">((resolve) => setTimeout(() => resolve("aguardando"), 2_500)),
  ]);
  return primeiro === "concluido" ? { status: "concluido" } : { status: "aguardando", aviso };
}

const NO_NAVEGADOR = "o navegador foi aberto no Locum: conclua a autorização lá e confira com list_connections";

export function registerConnectionTools(server: McpServer, amb: Ambiente): void {
  /* ----------------------------------------------------------- vitrine */
  def(server, "list_connections", "read",
    "State of each connection on this machine: the catalog (GitHub, Slack, Teams, Atlassian...) and the MCP servers registered outside it, with state, account, reason when it is not ok, tool counts and the servers behind it. Never returns a secret.",
    {}, async () => ({ connections: await connectionService.list(), github: await githubService.status() }));

  def(server, "get_connection_usage", "read",
    "Where a connection is used: the automations, agents and toolsets that cite it.",
    { id: z.string().min(1) }, ({ id }) => connectionService.usage(id));

  def(server, "connect_connection", "external",
    "Connects a catalog service or a registered server by OAuth. Registers the server (read scope) and OPENS THE BROWSER in the Locum app for you to authorize at the service; returns at once, and you finish there. Check with list_connections.",
    { id: z.string().min(1) },
    ({ id }) => abrirFluxo(connectionService.connect(id), NO_NAVEGADOR));

  def(server, "disconnect_connection", "danger",
    "Forgets the credential of a connection and removes the server the connection registered. The catalog item goes back to available. Reconnecting needs the browser again.",
    { id: z.string().min(1) }, ({ id }) => connectionService.disconnect(id));

  def(server, "add_custom_connection", "external",
    "Registers a remote MCP server by URL. If it asks for OAuth with automatic registration, opens the browser in the Locum app to authorize and returns at once.",
    { name: z.string().min(1), url: z.string().min(1) },
    ({ name, url }) => abrirFluxo(connectionService.addCustom({ name, url }), NO_NAVEGADOR));

  def(server, "enable_github_mcp_server", "write",
    "Registers the official GitHub MCP server of the catalog, which uses the GitHub token already stored.",
    {}, () => connectionService.ligarServidorDoGithub());

  /* ------------------------------------------------------------- GitHub */
  def(server, "get_github_status", "read",
    "The GitHub credential as the screen shows it: stored token or link to a gh account (host and login), token from the environment, last check and identity. Never the token.",
    {}, () => githubService.status());

  def(server, "save_github_token", "danger",
    "Stores a GitHub token in the keychain, OVERWRITING the token or the gh account link that was there. The value is accepted and never returned.",
    { token: z.string().min(1).describe("the personal access token") },
    async ({ token }) => {
      await githubService.setToken(token);
      return githubService.status();
    });

  def(server, "forget_github_token", "danger",
    "Forgets the stored GitHub token (or the link to a gh account). Triggers and runs that need GitHub stop working until a new one is saved.",
    {}, async () => ({ removed: await githubService.clearToken() }));

  def(server, "check_github", "read-external",
    "Asks GitHub who owns the stored token and which permissions it has. Without a stored token it answers from this machine, without going out.",
    {}, () => githubService.check());

  def(server, "list_gh_accounts", "read",
    "The accounts the gh command line of this machine knows (host and login), to link the connection to one. Never the token.",
    { configDir: z.string().optional().describe("a separate GH_CONFIG_DIR") },
    ({ configDir }) => githubService.contasDoGh(configDir));

  def(server, "use_gh_account", "danger",
    "Links the GitHub connection to an account of the gh command line: from then on the app asks gh for the token when it needs one, and nothing is stored. OVERWRITES the stored token (or the previous link).",
    { host: z.string().min(1), login: z.string().min(1), configDir: z.string().optional() },
    async ({ host, login, configDir }) => {
      await githubService.usarGh({ origem: "gh", host, login, ...(configDir === undefined ? {} : { configDir }) });
      return githubService.status();
    });

  /* ---------------------------------------------------- Claude Code etc */
  def(server, "get_claude_code_status", "read",
    "Whether Claude Code on this machine sees the Locum MCP server.", {}, () => claudeCodeService.status());

  def(server, "connect_claude_code", "danger",
    "Runs `claude mcp add` to register Locum in the user scope of Claude Code on this machine (writes its configuration).",
    {}, () => claudeCodeService.connect());

  def(server, "get_opencode_status", "read",
    "Whether opencode on this machine sees the Locum MCP server.", {}, () => opencodeService.status());

  def(server, "connect_opencode", "danger",
    "Registers Locum in the configuration of opencode on this machine (writes its configuration).",
    {}, () => opencodeService.connect());

  def(server, "list_claude_account_connectors", "read-external",
    "The connectors of claude.ai and the plugin MCP servers of the Claude account, read only. renew true asks again instead of using the cache.",
    { renew: z.boolean().optional() }, ({ renew }) => claudeAccountService.listar(renew === true));

  def(server, "list_claude_import", "read",
    "The MCP servers of Claude Code (user and enabled plugins) that can be brought into Locum.",
    {}, () => claudeImportService.listar());

  def(server, "list_claude_import_origins", "read",
    "Where each already imported server came from, to group them.", {}, () => claudeImportService.origens());

  def(server, "apply_claude_import", "write",
    "Imports the chosen Claude Code servers, registered DISABLED, with their secrets moved to the keychain. Turning one on is a separate step.",
    { names: z.array(z.string().min(1)).min(1) }, ({ names }) => claudeImportService.importar(names));

  /* ----------------------------------------------------------- Grafana */
  def(server, "list_grafana_instances", "read",
    "The Grafana instances registered (name and URL). Never the token.", {}, () => grafanaService.list());

  def(server, "save_grafana_instance", "danger",
    "Registers or updates a Grafana instance. The token is stored in the keychain, OVERWRITING the one of an instance with the same name, and is never returned.",
    { name: z.string().min(1), url: z.string().min(1), token: z.string().min(1) },
    ({ name, url, token }) => grafanaService.save({ nome: name, url, token }));

  def(server, "remove_grafana_instance", "danger",
    "Removes a Grafana instance and its token.", { name: z.string().min(1) }, ({ name }) => grafanaService.remove(name));

  /* ------------------------------------------------------- credenciais */
  def(server, "get_credentials_overview", "read",
    "Where each credential lives and whether a value is stored in it. Never the value.", {}, () => credentialService.overview());

  /* ------------------------------------------------------------- Slack */
  def(server, "get_slack_app", "read",
    "What the Slack screen shows: the app manifest and the client id already given.", {}, () => connectionService.slackApp());

  def(server, "open_slack_manifest", "external",
    "Opens, in the browser of the Locum app, the page that creates the Slack app from the manifest.", {}, async () => {
      await connectionService.openSlackManifest();
      return { aviso: "aberto no navegador do Locum" };
    });

  def(server, "connect_slack", "external",
    "Connects Slack through the official server with the app you created in the workspace: registers the server, OPENS THE BROWSER in the Locum app to authorize, and points the Slack source to it. Returns at once; finish in the browser.",
    { clientId: z.string().min(1).describe("the Slack app client id, like 1234567890.1234567890") },
    ({ clientId }) => abrirFluxo(connectionService.connectSlack(clientId), NO_NAVEGADOR));

  def(server, "disconnect_slack", "danger",
    "Disconnects the official Slack server: token, registration and source. The client id stays.", {}, () => connectionService.disconnectSlack());

  def(server, "get_slack_config", "read",
    "What this machine watches in Slack: the server, the tool names, the limit and the watched channels.", {}, () => slackService.get());

  def(server, "set_slack_source", "write",
    "Sets the Slack server, tools and argument names (the format of get_slack_config). Fields left out keep their current value.",
    { source: z.record(z.string(), z.unknown()) }, ({ source }) => slackService.setSource(source as SlackSourceInput));

  def(server, "add_slack_channel", "write",
    "Adds a channel (by its Slack id) to the watched ones.", { channel: z.string().min(1) }, ({ channel }) => slackService.addChannel(channel));

  def(server, "remove_slack_channel", "write",
    "Removes a channel from the watched ones.", { channel: z.string().min(1) }, ({ channel }) => slackService.removeChannel(channel));

  /* ------------------------------------------------------------- Teams */
  def(server, "get_teams_app", "read",
    "What the Teams screen shows: tenant, client id, whether channel scopes are on, and the connection state.", {}, () => connectionService.teamsApp());

  def(server, "connect_teams", "external",
    "Connects Teams through Graph with the app your organization registered in Entra: OPENS THE BROWSER in the Locum app to sign in, and returns at once; finish there.",
    { tenantId: z.string().min(1), clientId: z.string().min(1) },
    ({ tenantId, clientId }) => abrirFluxo(connectionService.connectTeams(tenantId, clientId), NO_NAVEGADOR));

  def(server, "teams_admin_consent", "external",
    "Opens the admin consent page of the tenant in the browser of the Locum app, for organizations that do not let the user consent. Returns at once; the administrator finishes there.",
    { tenantId: z.string().min(1), clientId: z.string().min(1) },
    ({ tenantId, clientId }) => abrirFluxo(connectionService.teamsAdminConsent(tenantId, clientId), NO_NAVEGADOR));

  def(server, "set_teams_channels", "write",
    "Turns the channel scopes of Teams on or off. The token is not touched: reconnect (connect_teams) for Entra to ask again.",
    { enabled: z.boolean() }, ({ enabled }) => connectionService.setTeamsChannels(enabled));

  def(server, "get_teams_mcp", "read",
    "How Teams reaches Locum through an MCP server: the registered server that brings it (enabled, last health, whether it has the Teams read tools) or, if none, the Claude Code servers worth importing. Only reads files and the registry, starts no server.",
    {}, () => connectionService.teamsPeloMcp());

  def(server, "use_claude_teams_server", "publish",
    "Imports ONE Teams server from the Claude Code config, linked and ENABLED, and tests it: this registers a command that runs on this machine and reaches Teams with your account. Fails when the server is not a Teams one or is missing variables.",
    { name: z.string().min(1), origin: z.string().optional().describe("origin shown by get_teams_mcp, when the same name exists in more than one") },
    ({ name, origin }) => connectionService.usarTeamsDoClaude(name, origin));

  def(server, "disconnect_teams", "danger",
    "Forgets the Teams token. Tenant and client id stay.", {}, () => connectionService.disconnectTeams());

  def(server, "list_teams_chats", "read-external",
    "Group and direct Teams chats of the connected account, with id, label and type, to fill the chats of a teams-inbox trigger. Reads Teams with your account; with an expired access it says to open Locum to renew it. With triggerId, reads through the account that trigger saved.",
    { triggerId: z.string().optional() }, ({ triggerId }) => amb.teamsChats(triggerId === undefined ? {} : { triggerId }));

  def(server, "list_teams_channels", "read-external",
    "Teams channels of the connected account, with team id, channel id and label, to fill the channels of a teams-inbox trigger. Reads Teams with your account; needs the channel scopes.",
    {}, () => amb.teamsChannels());

  /* ---------------------------------------------------------- trackers */
  def(server, "list_trackers", "read",
    "The task trackers registered (Jira, Shortcut, GitHub Issues): address, whether a credential is stored, and the last check. Never the credential.", {}, () => trackerService.list());

  def(server, "register_tracker", "publish",
    "Registers or updates a tracker (id, kind, label, baseUrl, project, account). Changing the baseUrl of an existing tracker sends the credential already stored for it to the new host on the next call, so it is a dangerous, outward-facing write. The credential is saved with save_tracker_secret.",
    { id: z.string().min(1), kind: z.string().min(1), label: z.string().min(1), baseUrl: z.string().optional(), project: z.string().nullable().optional(), account: z.string().nullable().optional() },
    async (entrada) => {
      await trackerService.register(entrada as TrackerRegistration);
      return (await trackerService.list()).find((t) => t.id === entrada.id) ?? null;
    });

  def(server, "remove_tracker", "danger", "Removes a tracker and its credential.", { id: z.string().min(1) },
    async ({ id }) => ({ removed: await trackerService.remove(id) }));

  def(server, "set_tracker_enabled", "write", "Turns a tracker on or off as a destination for tasks.", { id: z.string().min(1), enabled: z.boolean() },
    async ({ id, enabled }) => {
      await trackerService.setEnabled(id, enabled);
      return (await trackerService.list()).find((t) => t.id === id) ?? null;
    });

  def(server, "set_tracker_project", "write", "Sets the default project of a tracker (null clears it).", { id: z.string().min(1), project: z.string().nullable() },
    async ({ id, project }) => {
      await trackerService.setProject(id, project);
      return (await trackerService.list()).find((t) => t.id === id) ?? null;
    });

  def(server, "save_tracker_secret", "danger",
    "Stores the credential of a tracker in the keychain, OVERWRITING the one stored. The value is accepted and never returned.",
    { id: z.string().min(1), secret: z.string().min(1) },
    async ({ id, secret }) => {
      await trackerService.setSecret(id, secret);
      return (await trackerService.list()).find((t) => t.id === id) ?? null;
    });

  def(server, "forget_tracker_secret", "danger", "Forgets the credential of a tracker.", { id: z.string().min(1) },
    async ({ id }) => ({ removed: await trackerService.clearSecret(id) }));

  def(server, "test_tracker", "read-external",
    "Asks the tracker which projects the credential sees and counts them. Publishes nothing.", { id: z.string().min(1) }, ({ id }) => trackerService.testConnection(id));

  def(server, "list_tracker_projects", "read-external",
    "The projects the credential of the tracker sees.", { id: z.string().min(1) }, ({ id }) => trackerService.listProjects(id));
}
