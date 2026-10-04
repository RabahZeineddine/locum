import { claudeCodeService, type ClaudeCodeService } from "./claude-code-service.js";
import { claudeImportService } from "./claude-import.js";
import { githubService, type GithubService } from "./github-service.js";
import { chaveDoClienteOAuth, mcpOAuthService, type McpOAuthService, type PreRegisteredClient } from "./mcp-oauth-service.js";
import { mcpService, type McpService } from "./mcp-service.js";
import { settingsService, type SettingsService } from "./settings-service.js";
import {
  SLACK_MCP_URL,
  SLACK_OFFICIAL_SOURCE,
  SLACK_REDIRECT_URI,
  SLACK_USER_SCOPES,
  slackManifest,
  slackManifestUrl,
  validSlackClientId,
} from "./slack-app.js";
import { slackService, type SlackService } from "./slack-service.js";
import {
  TEAMS_CHANNEL_SCOPES,
  TEAMS_REDIRECT_URI,
  TEAMS_SERVER,
  entraAuthorizationServer,
  entraMetadata,
  teamsAdminConsentUrl,
  teamsAppCommand,
  teamsScope,
  teamsScopes,
  validTeamsClientId,
  validTeamsTenant,
} from "./teams-app.js";

/** Onde fica o client id do app de Slack desta máquina. Não é segredo: app público com PKCE. */
const CHAVE_CLIENT_ID_SLACK = "slack:clientId";

/** Tenant e client id do app do Entra desta máquina. Também não são segredo. */
const CHAVE_TENANT_TEAMS = "teams:tenantId";
const CHAVE_CLIENT_ID_TEAMS = "teams:clientId";

/**
 * Se a conexão do Teams pede os escopos de canal. Vale para o próximo
 * conectar: o token de agora tem os escopos com que foi pedido.
 */
const CHAVE_CANAIS_TEAMS = "teams:channels";

/** O que a tela precisa para guiar o registro do app do Teams. */
export interface TeamsAppSetup {
  redirectUri: string;
  /** Permissões delegadas do Graph que o app pede, para a tela listar. */
  scopes: string[];
  /** Os escopos que ligar canais acrescenta, para a tela avisar antes. */
  channelScopes: string[];
  /** Se o próximo conectar pede os escopos de canal. */
  channels: boolean;
  /** O registro pela CLI do Azure, para copiar. */
  command: string;
  tenantId: string | null;
  clientId: string | null;
  connected: boolean;
}

/** O que a tela precisa para guiar a criação do app de Slack. */
export interface SlackAppSetup {
  manifest: string;
  manifestUrl: string;
  redirectUri: string;
  /** Client id já informado nesta máquina, para reconectar sem colar de novo. */
  clientId: string | null;
  /** Há token do servidor oficial no cofre. */
  connected: boolean;
}

export type ConnectionCategory = "dev" | "communication" | "work" | "observability" | "data";

/**
 * Como cada conexão liga.
 *
 * - `claude-code`: cadastra o Locum no Claude Code.
 * - `github`: token pessoal no cofre, pelo painel.
 * - `oauth`: servidor MCP remoto que aceita registro automático; um clique abre o navegador.
 * - `panel`: liga por um formulário do próprio Locum (Jira, Slack, Teams).
 * - `soon`: ainda sem caminho que não exija terminal, e a tela diz o porquê.
 */
export type ConnectionKind = "claude-code" | "github" | "oauth" | "panel" | "soon";

export type ConnectionState = "connected" | "attention" | "available" | "soon";

export interface CatalogEntry {
  id: string;
  name: string;
  category: ConnectionCategory;
  kind: ConnectionKind;
  /** Endereço do servidor MCP remoto, para `oauth`. */
  url?: string;
  /** Chave da logo em `renderer/src/marcas.ts`, ou nula para ícone genérico. */
  logo: string | null;
  /** Cor da marca, sem #, para o ícone genérico. */
  color: string;
}

/**
 * O catálogo. Endereços de `oauth` foram conferidos à mão: cada um responde
 * 401 com metadado de recurso e anuncia `registration_endpoint`, que é o que
 * deixa conectar sem client id. Slack, GitHub remoto e Asana não anunciam, e
 * por isso não estão aqui como `oauth`.
 */
export const CATALOG: CatalogEntry[] = [
  { id: "claude-code", name: "Claude Code", category: "dev", kind: "claude-code", logo: "claude", color: "D97757" },
  { id: "github", name: "GitHub", category: "dev", kind: "github", logo: "github", color: "181717" },
  { id: "notion", name: "Notion", category: "work", kind: "oauth", url: "https://mcp.notion.com/mcp", logo: "notion", color: "000000" },
  { id: "atlassian", name: "Atlassian", category: "work", kind: "oauth", url: "https://mcp.atlassian.com/v1/mcp", logo: "atlassian", color: "0052CC" },
  { id: "slack", name: "Slack", category: "communication", kind: "panel", logo: null, color: "4A154B" },
  { id: "teams", name: "Microsoft Teams", category: "communication", kind: "panel", logo: null, color: "5059C9" },
  { id: "figma", name: "Figma", category: "work", kind: "oauth", url: "https://mcp.figma.com/mcp", logo: "figma", color: "F24E1E" },
];

export interface Connection extends CatalogEntry {
  state: ConnectionState;
  /** Quem está conectado, quando o serviço diz (login do GitHub, por exemplo). */
  account: string | null;
  /** Servidor MCP cadastrado por fora do catálogo, mostrado como conexão própria. */
  custom: boolean;
}

export interface ConnectionServiceDeps {
  mcp: McpService;
  oauth: McpOAuthService;
  claudeCode: ClaudeCodeService;
  github: GithubService;
  slack: SlackService;
  settings: SettingsService;
  /** App OAuth que o Claude Code declara para o servidor, quando a importação não guardou. */
  clienteDoClaude?: (nome: string) => Promise<PreRegisteredClient | undefined>;
}

/**
 * A vitrine de conexões: o catálogo somado ao estado de cada uma nesta máquina.
 *
 * Servidor MCP cadastrado que não está no catálogo aparece também, como
 * conexão própria, para que a tela seja o lugar único de ver o que está ligado.
 */
export class ConnectionService {
  private readonly deps: ConnectionServiceDeps;

  constructor(deps: Partial<ConnectionServiceDeps> = {}) {
    this.deps = {
      mcp: mcpService,
      oauth: mcpOAuthService,
      claudeCode: claudeCodeService,
      github: githubService,
      slack: slackService,
      settings: settingsService,
      clienteDoClaude: (nome) => claudeImportService.clienteOAuth(nome),
      ...deps,
    };
  }

  async list(): Promise<Connection[]> {
    const servidores = await this.deps.mcp.list();
    const porNome = new Map(servidores.map((s) => [s.config.name, s]));

    const doCatalogo = await Promise.all(CATALOG.map((entry) => this.estado(entry, porNome.has(entry.id))));

    const proprios: Connection[] = servidores
      .filter((s) => !CATALOG.some((c) => c.id === s.config.name))
      .map((s) => ({
        id: s.config.name,
        name: s.config.name,
        category: "data",
        kind: s.config.transport === "stdio" ? "panel" : "oauth",
        url: s.config.url,
        logo: null,
        color: "64748B",
        // Servidor próprio sem credencial é o que não pede OAuth: `addCustom`
        // só cadastra sem conectar quando a sonda não achou autorização.
        state: s.enabled ? "connected" : "attention",
        account: null,
        custom: true,
      }));

    return [...doCatalogo, ...proprios];
  }

  /**
   * Liga uma conexão de um clique: Claude Code ou servidor `oauth`.
   *
   * O servidor do catálogo é cadastrado aqui mesmo, com o id como nome, antes
   * de abrir o navegador. Escopo de leitura por padrão: escrever em serviço de
   * fora continua exigindo passo de ação aprovado na fila.
   */
  async connect(id: string): Promise<Connection> {
    const entry = CATALOG.find((c) => c.id === id);
    if (entry?.kind === "claude-code") {
      await this.deps.claudeCode.connect();
      return this.um(id);
    }

    const atual = await this.deps.mcp.get(id);
    const url = entry?.url ?? atual?.config.url;
    if (url === undefined) throw new Error(`"${id}" não conecta por um clique`);
    // Um cadastro com o nome do catálogo e outro endereço faria a autorização
    // acontecer no servidor errado, com a vitrine mostrando o endereço certo.
    // Como no Slack, quem clica na vitrine liga o servidor da vitrine.
    if (atual === undefined || atual.config.transport !== "http" || atual.config.url !== url) {
      await this.deps.mcp.register({ name: id, transport: "http", url });
    }
    const cliente =
      (await clienteGuardado(this.deps.settings, id)) ??
      (entry === undefined ? await this.deps.clienteDoClaude?.(id) : undefined);
    await this.deps.oauth.connect(id, cliente);
    return this.um(id);
  }

  /**
   * Esquece a credencial e tira o servidor do cadastro. Do catálogo, a
   * conexão volta a aparecer como disponível; própria, some da vitrine.
   */
  async disconnect(id: string): Promise<Connection | null> {
    const entry = CATALOG.find((c) => c.id === id);
    if (entry !== undefined && entry.kind !== "oauth") {
      throw new Error(`"${entry.name}" desliga pelo próprio painel`);
    }
    await this.deps.oauth.disconnect(id);
    await this.deps.mcp.remove(id);
    return (await this.list()).find((c) => c.id === id) ?? null;
  }

  /** Manifesto do app e o client id já informado, para a tela do Slack. */
  async slackApp(): Promise<SlackAppSetup> {
    return {
      manifest: JSON.stringify(slackManifest(), null, 2),
      manifestUrl: slackManifestUrl(),
      redirectUri: SLACK_REDIRECT_URI,
      clientId: (await this.deps.settings.get(CHAVE_CLIENT_ID_SLACK)) ?? null,
      connected: this.deps.oauth.status("slack").connected,
    };
  }

  /** Abre a criação de app no Slack com o manifesto já preenchido. */
  async openSlackManifest(): Promise<void> {
    await this.deps.oauth.openInBrowser(slackManifestUrl());
  }

  /**
   * Liga o Slack pelo servidor MCP oficial, com o app que a pessoa criou.
   *
   * Cadastra o servidor, autoriza no navegador com o client id informado, e
   * aponta a origem do Slack para as ferramentas oficiais. Os canais já
   * observados ficam como estavam.
   */
  async connectSlack(clientId: string): Promise<Connection> {
    const id = clientId.trim();
    if (!validSlackClientId(id)) throw new Error("client id do Slack tem o formato 1234567890.1234567890");
    await this.deps.settings.set(CHAVE_CLIENT_ID_SLACK, id);

    const atual = await this.deps.mcp.get("slack");
    if (atual === undefined || atual.config.url !== SLACK_MCP_URL) {
      await this.deps.mcp.register({ name: "slack", transport: "http", url: SLACK_MCP_URL });
    }
    await this.deps.oauth.connect("slack", {
      clientId: id,
      redirectUri: SLACK_REDIRECT_URI,
      scope: SLACK_USER_SCOPES.join(" "),
    });
    const origem = await this.deps.slack.get();
    await this.deps.slack.setSource({ ...SLACK_OFFICIAL_SOURCE, server: "slack", limit: Math.min(origem.limit, 100) });
    return this.um("slack");
  }

  /**
   * Desliga o servidor oficial: token, cadastro e origem. O client id fica,
   * porque o app continua existindo no Slack e reconectar não deve pedir de novo.
   */
  async disconnectSlack(): Promise<Connection> {
    await this.deps.oauth.disconnect("slack");
    if ((await this.deps.mcp.get("slack")) !== undefined) await this.deps.mcp.remove("slack");
    const origem = await this.deps.slack.get();
    if (origem.server === "slack") await this.deps.slack.setSource({ server: null });
    return this.um("slack");
  }

  /** Comando de registro e o que já foi informado, para a tela do Teams. */
  async teamsApp(): Promise<TeamsAppSetup> {
    const canais = await this.teamsChannelsOn();
    return {
      redirectUri: TEAMS_REDIRECT_URI,
      scopes: teamsScopes(canais),
      channelScopes: TEAMS_CHANNEL_SCOPES,
      channels: canais,
      command: teamsAppCommand(),
      tenantId: (await this.deps.settings.get(CHAVE_TENANT_TEAMS)) ?? null,
      clientId: (await this.deps.settings.get(CHAVE_CLIENT_ID_TEAMS)) ?? null,
      connected: this.deps.oauth.status(TEAMS_SERVER).connected,
    };
  }

  /**
   * Liga o Teams com o app que a organização registrou no Entra.
   *
   * Não há servidor MCP para cadastrar: o token vai para o cofre e quem o usa
   * é a caixa do Teams e a resposta aprovada, direto no Graph.
   */
  async connectTeams(tenantId: string, clientId: string): Promise<Connection> {
    const { tenant, client } = await this.guardarTeams(tenantId, clientId);
    await this.deps.oauth.connectDirect(TEAMS_SERVER, entraAuthorizationServer(tenant), entraMetadata(tenant), {
      clientId: client,
      redirectUri: TEAMS_REDIRECT_URI,
      scope: teamsScope(await this.teamsChannelsOn()),
    });
    return this.um(TEAMS_SERVER);
  }

  /**
   * Abre o consentimento do administrador para o tenant inteiro e espera a
   * volta. Serve para a empresa que não deixa o próprio usuário consentir.
   */
  async teamsAdminConsent(tenantId: string, clientId: string): Promise<void> {
    const { tenant, client } = await this.guardarTeams(tenantId, clientId);
    const canais = await this.teamsChannelsOn();
    const volta = await this.deps.oauth.openAndWait(TEAMS_REDIRECT_URI, (state) =>
      teamsAdminConsentUrl(tenant, client, state, canais),
    );
    if (volta.get("admin_consent")?.toLowerCase() !== "true") {
      throw new Error("o Entra voltou sem confirmar o consentimento do administrador");
    }
  }

  /**
   * Liga ou desliga os escopos de canal. Não mexe no token: quem já conectou
   * reconecta para o Entra perguntar de novo, e a tela diz isso.
   */
  async setTeamsChannels(ligado: boolean): Promise<TeamsAppSetup> {
    await this.deps.settings.set(CHAVE_CANAIS_TEAMS, ligado ? "sim" : "nao");
    return this.teamsApp();
  }

  private async teamsChannelsOn(): Promise<boolean> {
    return (await this.deps.settings.get(CHAVE_CANAIS_TEAMS)) === "sim";
  }

  /** Esquece o token. Tenant e client id ficam, porque o app continua registrado. */
  async disconnectTeams(): Promise<Connection> {
    await this.deps.oauth.disconnect(TEAMS_SERVER);
    return this.um(TEAMS_SERVER);
  }

  private async guardarTeams(tenantId: string, clientId: string): Promise<{ tenant: string; client: string }> {
    const tenant = tenantId.trim().toLowerCase();
    const client = clientId.trim().toLowerCase();
    if (!validTeamsTenant(tenant)) throw new Error("tenant do Entra é um GUID ou um domínio, como empresa.com.br");
    if (!validTeamsClientId(client)) throw new Error("client id do Entra é um GUID");
    await this.deps.settings.set(CHAVE_TENANT_TEAMS, tenant);
    await this.deps.settings.set(CHAVE_CLIENT_ID_TEAMS, client);
    return { tenant, client };
  }

  /**
   * Servidor MCP remoto qualquer, pelo endereço. Pergunta antes se ele pede
   * OAuth com registro automático: sendo assim, cadastra e conecta no mesmo
   * clique; não pedindo OAuth, só cadastra.
   */
  async addCustom(input: { name: string; url: string }): Promise<Connection> {
    const name = input.name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
      throw new Error("nome com letra minúscula, número, ponto, hífen ou sublinhado");
    }
    if (CATALOG.some((c) => c.id === name)) throw new Error(`"${name}" já está no catálogo`);
    const url = new URL(input.url.trim());
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      throw new Error("servidor remoto precisa de https");
    }

    const sonda = await this.deps.oauth.probe(url.toString());
    if (sonda.oauth && !sonda.registration) {
      throw new Error("esse servidor pede OAuth mas não aceita registro automático de cliente");
    }
    await this.deps.mcp.register({ name, transport: "http", url: url.toString() });
    if (sonda.oauth) await this.deps.oauth.connect(name);
    return this.um(name);
  }

  private async um(id: string): Promise<Connection> {
    const achada = (await this.list()).find((c) => c.id === id);
    if (achada === undefined) throw new Error(`conexão "${id}" sumiu depois de ligar`);
    return achada;
  }

  private async estado(entry: CatalogEntry, cadastrado: boolean): Promise<Connection> {
    const base = { ...entry, custom: false, account: null };
    switch (entry.kind) {
      case "claude-code": {
        const s = await this.deps.claudeCode.status().catch(() => null);
        const state: ConnectionState = s?.current ? "connected" : s?.registered ? "attention" : "available";
        return { ...base, state };
      }
      case "github": {
        const s = await this.deps.github.status();
        return {
          ...base,
          state: s.stored || s.env ? "connected" : "available",
          account: s.identity?.login ?? null,
        };
      }
      case "oauth": {
        if (!cadastrado) return { ...base, state: "available" };
        const s = this.deps.oauth.status(entry.id);
        return { ...base, state: s.connected ? "connected" : "attention" };
      }
      case "panel": {
        if (entry.id === "slack") {
          const s = await this.deps.slack.get();
          return { ...base, state: s.server === null ? "available" : "connected" };
        }
        if (entry.id === TEAMS_SERVER) {
          return { ...base, state: this.deps.oauth.status(TEAMS_SERVER).connected ? "connected" : "available" };
        }
        return { ...base, state: "available" };
      }
      case "soon":
        return { ...base, state: "soon" };
    }
  }
}

export const connectionService = new ConnectionService();

/**
 * O app OAuth cadastrado no serviço para este servidor, quando há um. Sem ele
 * vale o registro automático, que servidor da casa (backoffice no Entra)
 * costuma não aceitar.
 */
async function clienteGuardado(settings: Pick<SettingsService, "get">, nome: string): Promise<PreRegisteredClient | undefined> {
  const bruto = await settings.get(chaveDoClienteOAuth(nome));
  if (bruto === undefined) return undefined;
  try {
    const c = JSON.parse(bruto) as Partial<PreRegisteredClient>;
    return typeof c.clientId === "string" && typeof c.redirectUri === "string"
      ? { clientId: c.clientId, redirectUri: c.redirectUri, ...(typeof c.scope === "string" ? { scope: c.scope } : {}) }
      : undefined;
  } catch {
    return undefined;
  }
}

