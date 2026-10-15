import { ehLeituraDa } from "../config/leitura.js";
import { temCredencialLiteral } from "./mcp-credencial.js";
import { CATALOG, conexaoDoServidor, type CatalogEntry } from "./conexao-catalogo.js";
import { IMAGEM_DO_GRAFANA } from "./grafana-service.js";
import { claudeImportService } from "./claude-import.js";
import { estadoDoServidor, type ConnectionReason, type ConnectionState } from "./conexao-estado.js";
import { carregarFontesDeUso, quemUsa, type FontesDeUso, type UsoDaConexao } from "./conexao-uso.js";
import { githubService, type GithubService } from "./github-service.js";
import { chaveDoClienteOAuth, mcpOAuthService, type McpOAuthService, type PreRegisteredClient } from "./mcp-oauth-service.js";
import { mcpService, type McpServerEntry, type McpService } from "./mcp-service.js";
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
import { trackerService } from "./tracker-service.js";
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

export { CATALOG, conexaoDoServidor, type CatalogEntry, type ConnectionCategory, type ConnectionKind } from "./conexao-catalogo.js";

/**
 * O GitHub tem duas partes que a pessoa conhece por um nome só: o token (gatilhos
 * e prévia de pull request) e o servidor MCP (ferramentas dos agents). O estado
 * de cada uma vai separado para a tela dizer qual está faltando.
 */
export interface PartesDoGithub {
  token: "ok" | "missing";
  /** Nulo quando não há servidor MCP do GitHub cadastrado. */
  servidor: "ok" | "untested" | "disabled" | "no-credential" | "needs-auth" | "failing" | null;
  /** O servidor de que `servidor` fala: o de nome `github`, ou o primeiro do item. */
  nome: string | null;
  /** Os demais servidores do item, cada um com o seu estado, para o detalhe mostrar o que falha. */
  outros: { nome: string; estado: NonNullable<PartesDoGithub["servidor"]> }[];
}

/**
 * O que desconectar faz com os servidores do item, para a tela confirmar:
 * `remove` sai do cadastro, `forget` só perde a credencial, `literal` tem a
 * credencial escrita na própria configuração (não há o que esquecer) e `keep`
 * é vinculado a uma origem e fica como está.
 */
export interface PlanoDeDesconexao {
  remove: string[];
  forget: string[];
  literal: string[];
  keep: string[];
}
export type { ConnectionReason, ConnectionState } from "./conexao-estado.js";

export interface Connection extends CatalogEntry {
  state: ConnectionState;
  /** Quem está conectado, quando o serviço diz (login do GitHub, por exemplo). */
  account: string | null;
  /** Servidor MCP cadastrado por fora do catálogo, mostrado como conexão própria. */
  custom: boolean;
  /** Por que não está ok, quando não está. */
  reason: ConnectionReason | null;
  /** O que o servidor respondeu na última falha, para `error`. */
  detail: string | null;
  /** Ferramentas da última lista guardada, sem subir o servidor. Nulo quando nunca listou. */
  toolCount: number | null;
  /** Os nomes das ferramentas da última lista guardada, para a busca da tela. */
  toolNames: string[];
  /** Quantas dessas ferramentas escrevem, pelas anotações do servidor e, sem elas, pelo nome. */
  toolWrites: number;
  /** O que desconectar faria; nulo quando a conexão não desconecta por aqui. */
  desligar: PlanoDeDesconexao | null;
  /**
   * Os servidores MCP cadastrados que esta conexão realmente usa: um para o
   * serviço do catálogo, um para o próprio, todas as instâncias do Grafana, e
   * o servidor escolhido como origem do Slack. Vazio quando não há nenhum.
   */
  servers: string[];
  /** Trackers de tarefas ligados que moram nesta conexão (Jira, Shortcut, GitHub Issues). */
  trackers: number;
  /** O estado de cada parte, só no GitHub; nulo nas demais. */
  partes: PartesDoGithub | null;
}

/** Que tipo de tracker mora em qual conexão. */
const CONEXAO_DO_TRACKER: Readonly<Record<string, string>> = {
  jira: "atlassian",
  "jira-atlassian": "atlassian",
  shortcut: "shortcut",
  "github-issues": "github",
};

export interface ConnectionServiceDeps {
  mcp: McpService;
  oauth: McpOAuthService;
  github: GithubService;
  slack: SlackService;
  settings: SettingsService;
  /** App OAuth que o Claude Code declara para o servidor, quando a importação não guardou. */
  clienteDoClaude?: (nome: string) => Promise<PreRegisteredClient | undefined>;
  /** Os trackers cadastrados, para a conexão a que cada um pertence acender. */
  trackers?: () => Promise<{ kind: string; enabled: boolean }[]>;
  /** De onde sai "quem usa": automações, agents e toolsets gravados. */
  fontesDeUso?: () => Promise<FontesDeUso>;
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
      github: githubService,
      slack: slackService,
      settings: settingsService,
      clienteDoClaude: (nome) => claudeImportService.clienteOAuth(nome),
      fontesDeUso: carregarFontesDeUso,
      trackers: () => trackerService.list(),
      ...deps,
    };
  }

  async list(): Promise<Connection[]> {
    const servidores = await this.deps.mcp.list();
    const porNome = new Map(servidores.map((s) => [s.config.name, s]));

    const ligados = new Map<string, number>();
    for (const tracker of await this.deps.trackers!()) {
      const dono = CONEXAO_DO_TRACKER[tracker.kind];
      if (dono !== undefined && tracker.enabled) ligados.set(dono, (ligados.get(dono) ?? 0) + 1);
    }

    // O servidor que é de um item do catálogo mora na conexão dele, qualquer
    // que seja o nome com que foi cadastrado ou importado.
    const doItem = new Map<string, McpServerEntry[]>();
    for (const s of servidores) {
      const dono = conexaoDoServidor(s.config);
      if (dono !== undefined && !ehDoGrafana(s.config)) doItem.set(dono.id, [...(doItem.get(dono.id) ?? []), s]);
    }

    // Ler a credencial de um servidor vinculado abre o arquivo da origem: uma
    // vez por servidor em cada listagem, e não a cada cartão que o cita.
    const memo = new Map<string, Promise<Credencial>>();
    const credencial = (nome: string): Promise<Credencial> => {
      let lida = memo.get(nome);
      if (lida === undefined) {
        lida = this.deps.mcp.credencialDoServidor(nome);
        memo.set(nome, lida);
      }
      return lida;
    };

    const doCatalogo = await Promise.all(
      CATALOG.map((entry) => this.estado(entry, porNome, ligados.get(entry.id) ?? 0, doItem.get(entry.id) ?? [], credencial)),
    );

    const proprios: Connection[] = await Promise.all(
      servidores
        .filter((s) => conexaoDoServidor(s.config) === undefined)
        // As instâncias do Grafana moram no cartão dele, e não cada uma no seu.
        .filter((s) => !ehDoGrafana(s.config))
        .map(async (s) => ({
          id: s.config.name,
          name: s.config.name,
          category: "data" as const,
          kind: s.config.transport === "stdio" ? ("panel" as const) : ("oauth" as const),
          url: s.config.url,
          logo: null,
          color: "64748B",
          custom: true,
          account: null,
          ...(await this.ferramentas([s.config.name])),
          desligar: null,
          servers: [s.config.name],
          trackers: 0,
          partes: null,
          // Servidor próprio sem credencial é o que não pede OAuth: `addCustom`
          // só cadastra sem conectar quando a sonda não achou autorização.
          ...estadoDoServidor(s, true),
        })),
    );

    return [...doCatalogo, ...proprios];
  }

  /** Automações e agents que dependem do servidor desta conexão. */
  async usage(id: string): Promise<UsoDaConexao[]> {
    const conexao = (await this.list()).find((c) => c.id === id);
    const fontes = await this.deps.fontesDeUso!();
    const porId = new Map<string, UsoDaConexao>();
    for (const servidor of conexao?.servers ?? []) {
      for (const uso of quemUsa(servidor, fontes)) {
        const chave = `${uso.tipo}:${uso.id}`;
        const antes = porId.get(chave);
        porId.set(chave, antes === undefined ? uso : { ...antes, como: [...new Set([...antes.como, ...uso.como])] });
      }
    }
    // O agent escolhe por conexão, e não pelo nome do servidor.
    for (const agent of fontes.agents) {
      if (!agent.connections.some((c) => c.connectionId === id)) continue;
      const chave = `agent:${agent.id}`;
      const antes = porId.get(chave);
      porId.set(
        chave,
        antes === undefined
          ? { tipo: "agent", id: agent.id, nome: agent.name, como: ["ferramenta"] }
          : { ...antes, como: [...new Set([...antes.como, "ferramenta" as const])] },
      );
    }
    return [...porId.values()];
  }

  /**
   * Nomes, total e quantas escrevem, da última lista guardada de todos os
   * servidores dados: as três contas partem da mesma base. Nulo no total quando
   * nenhum nunca listou.
   */
  private async ferramentas(servidores: string[]): Promise<{ toolNames: string[]; toolWrites: number; toolCount: number | null }> {
    const listas = await Promise.all(servidores.map((nome) => this.deps.mcp.cachedTools(nome)));
    const todas = listas.flatMap((l) => l?.tools ?? []);
    return {
      toolNames: todas.map((t) => t.name),
      toolWrites: todas.filter((t) => !ehLeituraDa(t)).length,
      toolCount: listas.every((l) => l === null) ? null : todas.length,
    };
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

    const atual = await this.deps.mcp.get(id);
    const url = entry?.url ?? atual?.config.url;
    if (url === undefined) throw new Error(`"${id}" não conecta por um clique`);
    // Servidor do mesmo item cadastrado com outro nome (importado) e o mesmo
    // endereço: é ele que autoriza, em vez de cadastrar um segundo.
    const irmao =
      atual !== undefined || entry === undefined
        ? undefined
        : (await this.deps.mcp.list()).find((s) => s.config.url === url && conexaoDoServidor(s.config)?.id === id);
    const nome = irmao?.config.name ?? id;
    // Um cadastro com o nome do catálogo e outro endereço faria a autorização
    // acontecer no servidor errado, com a vitrine mostrando o endereço certo.
    // Como no Slack, quem clica na vitrine liga o servidor da vitrine.
    if (irmao === undefined && (atual === undefined || atual.config.transport !== "http" || atual.config.url !== url)) {
      await this.deps.mcp.register({ name: id, transport: "http", url });
    }
    const cliente =
      (await clienteGuardado(this.deps.settings, id)) ??
      (entry === undefined ? await this.deps.clienteDoClaude?.(id) : undefined);
    await this.deps.oauth.connect(nome, cliente);
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
    if (entry === undefined) {
      await this.deps.oauth.disconnect(id);
      await this.deps.mcp.remove(id);
      return (await this.list()).find((c) => c.id === id) ?? null;
    }
    // Só sai o servidor que a própria conexão cadastrou; o importado com outro
    // nome perde a credencial e continua cadastrado, e o vinculado a uma
    // origem não se toca.
    const plano = (await this.list()).find((c) => c.id === id)?.desligar;
    if (plano === undefined || plano === null || (plano.remove.length === 0 && plano.forget.length === 0)) {
      throw new Error(
        plano !== undefined && plano !== null && plano.keep.length > 0
          ? `${plano.keep.join(", ")} está vinculado a uma origem: edite na origem, ou desvincule em Conexões, nos detalhes técnicos do servidor, antes de remover`
          : `"${entry.name}" não tem servidor para desconectar`,
      );
    }
    for (const nome of plano.remove) {
      await this.deps.oauth.disconnect(nome);
      await this.deps.mcp.remove(nome);
    }
    for (const nome of plano.forget) await this.deps.oauth.disconnect(nome);
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

  /**
   * O estado de um servidor que mora numa conexão do catálogo. O servidor que a
   * própria vitrine cadastrou (nome igual ao id) só vale com OAuth feito ou
   * credencial; o importado, que pode autenticar fora daqui (header escrito à
   * mão, OAuth no Claude Code), vale como não testado enquanto nada disser o
   * contrário.
   */
  private async estadoDe(
    s: McpServerEntry,
    id: string,
    credencial: (nome: string) => Promise<Credencial>,
    { token = false }: { token?: boolean } = {},
  ): Promise<EstadoDoServidor> {
    const nome = s.config.name;
    const cred = await credencial(nome);
    const sem = cred === "falta";
    const autorizado = this.deps.oauth.status(nome).connected || cred === "ok" || (nome !== id && !sem);
    // O OAuth sem token no cofre é "falta autorizar", e não "falta o token".
    return estadoDoServidor(s, autorizado, token && sem);
  }

  private async estado(
    entry: CatalogEntry,
    porNome: Map<string, McpServerEntry>,
    trackers: number,
    doItem: McpServerEntry[],
    credencial: (nome: string) => Promise<Credencial>,
  ): Promise<Connection> {
    // O servidor com o id do catálogo manda; outro do mesmo item vem depois.
    const principal = doItem.find((s) => s.config.name === entry.id) ?? doItem[0];
    const nomes = doItem.map((s) => s.config.name);
    const base = {
      servers: nomes,
      trackers,
      ...entry,
      custom: false,
      account: null,
      reason: null,
      detail: null,
      ...(await this.ferramentas(nomes)),
      desligar: entry.kind === "oauth" ? planoDeDesconexao(entry.id, doItem) : null,
      partes: null,
    };
    switch (entry.kind) {
      case "github": {
        const s = await this.deps.github.status();
        const token = s.stored || s.env;
        const conta = s.identity?.login ?? null;
        if (principal === undefined) {
          return {
            ...base,
            state: token || trackers > 0 ? "connected" : "available",
            account: conta,
            partes: { token: token ? "ok" : "missing", servidor: null, nome: null, outros: [] },
          };
        }
        const estados = await Promise.all(doItem.map(async (sv) => ({ nome: sv.config.name, est: await this.estadoDe(sv, entry.id, credencial, { token: true }) })));
        const doPrincipal = estados.find((e) => e.nome === principal.config.name)!.est;
        const pior = piorEstado(estados.map((e) => e.est));
        // Uma parte falhando basta para a conexão não dizer "conectado", e o
        // servidor de pé sem o token dos gatilhos também é meia conexão.
        const geral =
          pior.state === "attention" || pior.state === "error"
            ? pior
            : !token
              ? { state: "attention" as const, reason: "no-token" as const, detail: null }
              : { state: "connected" as const, reason: doPrincipal.reason, detail: null };
        return {
          ...base,
          ...geral,
          account: conta,
          partes: {
            token: token ? "ok" : "missing",
            servidor: parteDoServidor(doPrincipal.reason),
            nome: principal.config.name,
            outros: estados.filter((e) => e.nome !== principal.config.name).map((e) => ({ nome: e.nome, estado: parteDoServidor(e.est.reason) })),
          },
        };
      }
      case "oauth": {
        // Jira e Shortcut por token não passam por servidor MCP: o tracker já é a conexão.
        if (principal === undefined) return { ...base, state: trackers > 0 ? "connected" : "available" };
        return { ...base, ...piorEstado(await Promise.all(doItem.map((sv) => this.estadoDe(sv, entry.id, credencial)))) };
      }
      case "panel": {
        if (entry.id === "slack") {
          const s = await this.deps.slack.get();
          const outros = await Promise.all(doItem.filter((sv) => sv.config.name !== s.server).map((sv) => this.estadoDe(sv, entry.id, credencial)));
          if (s.server === null) {
            // Servidor do Slack importado, sem origem escolhida: ainda assim é a conexão.
            return outros.length === 0 ? { ...base, state: "available" } : { ...base, ...piorEstado(outros) };
          }
          // A conexão do Slack é o servidor que serve de origem, o oficial ou
          // outro; a saúde e as ferramentas vêm dele, e os demais servidores do
          // item continuam na conexão.
          const origem = porNome.get(s.server);
          const daOrigem: EstadoDoServidor =
            origem === undefined ? { state: "connected", reason: null, detail: null } : estadoDoServidor(origem, true);
          const servers = [...new Set([...(origem === undefined ? [] : [s.server]), ...nomes])];
          return {
            ...base,
            servers,
            ...(await this.ferramentas(servers)),
            ...piorEstado([daOrigem, ...outros]),
          };
        }
        if (entry.id === "grafana") {
          const instancias = [...porNome.values()].filter((s) => ehDoGrafana(s.config));
          if (instancias.length === 0) return { ...base, state: "available" };
          // A pior instância decide: uma com falha basta para a conexão pedir olhar.
          return { ...base, ...piorEstado(instancias.map((i) => estadoDoServidor(i, true))), servers: instancias.map((i) => i.config.name) };
        }
        if (entry.id === TEAMS_SERVER) {
          const login = this.deps.oauth.status(TEAMS_SERVER).connected;
          const servidores = await Promise.all(doItem.map((sv) => this.estadoDe(sv, entry.id, credencial)));
          // O login no Graph e o servidor do Microsoft 365 são duas formas da
          // mesma conexão: o servidor falhando não some por haver login.
          if (servidores.length === 0) return { ...base, state: login ? "connected" : "available" };
          const pior = piorEstado(servidores);
          return { ...base, ...(login && pior.state !== "attention" && pior.state !== "error" ? { state: "connected" as const, reason: null, detail: null } : pior) };
        }
        return { ...base, state: "available" };
      }
      case "soon":
        return { ...base, state: "soon" };
    }
  }
}

/** O motivo do estado de um servidor, como parte do GitHub: sem motivo é `ok`. */
function parteDoServidor(reason: EstadoDoServidor["reason"]): NonNullable<PartesDoGithub["servidor"]> {
  return reason === null || reason === "no-token" ? "ok" : reason;
}

type Credencial = "ok" | "falta" | "dispensa";
type EstadoDoServidor = ReturnType<typeof estadoDoServidor>;

/** A pior entre as instâncias: erro, depois atenção, depois a primeira. */
function piorEstado(estados: EstadoDoServidor[]): EstadoDoServidor {
  return estados.find((e) => e.state === "error") ?? estados.find((e) => e.state === "attention") ?? estados[0]!;
}

/**
 * O que desconectar faz: o servidor de nome igual ao id, que a vitrine
 * cadastrou, sai; os outros do item perdem a credencial e ficam; o vinculado a
 * uma origem nunca é tocado.
 */
function planoDeDesconexao(id: string, servidores: McpServerEntry[]): PlanoDeDesconexao {
  const plano: PlanoDeDesconexao = { remove: [], forget: [], literal: [], keep: [] };
  for (const s of servidores) {
    if (s.source !== null) plano.keep.push(s.config.name);
    else if (s.config.name === id) plano.remove.push(s.config.name);
    else if (s.credentialRef === null && temCredencialLiteral(s.config.headers)) plano.literal.push(s.config.name);
    else plano.forget.push(s.config.name);
  }
  return plano;
}

export const connectionService = new ConnectionService();

function ehDoGrafana(config: { transport: string; command?: string[] }): boolean {
  return config.transport === "stdio" && (config.command ?? []).includes(IMAGEM_DO_GRAFANA);
}

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
