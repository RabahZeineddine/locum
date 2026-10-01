import { claudeCodeService, type ClaudeCodeService } from "./claude-code-service.js";
import { githubService, type GithubService } from "./github-service.js";
import { mcpOAuthService, type McpOAuthService } from "./mcp-oauth-service.js";
import { mcpService, type McpService } from "./mcp-service.js";
import { slackService, type SlackService } from "./slack-service.js";
import { trackerService, type TrackerService } from "./tracker-service.js";

export type ConnectionCategory = "dev" | "communication" | "work" | "observability" | "data";

/**
 * Como cada conexão liga.
 *
 * - `claude-code`: cadastra o Locum no Claude Code.
 * - `github`: token pessoal no cofre, pelo painel.
 * - `oauth`: servidor MCP remoto que aceita registro automático; um clique abre o navegador.
 * - `panel`: liga por um formulário do próprio Locum (Jira, Slack sobre um servidor MCP).
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
  { id: "linear", name: "Linear", category: "work", kind: "oauth", url: "https://mcp.linear.app/mcp", logo: "linear", color: "5E6AD2" },
  { id: "notion", name: "Notion", category: "work", kind: "oauth", url: "https://mcp.notion.com/mcp", logo: "notion", color: "000000" },
  { id: "atlassian", name: "Atlassian", category: "work", kind: "oauth", url: "https://mcp.atlassian.com/v1/mcp", logo: "atlassian", color: "0052CC" },
  { id: "jira", name: "Jira", category: "work", kind: "panel", logo: "atlassian", color: "0052CC" },
  { id: "slack", name: "Slack", category: "communication", kind: "panel", logo: null, color: "4A154B" },
  { id: "teams", name: "Microsoft Teams", category: "communication", kind: "soon", logo: null, color: "5059C9" },
  { id: "sentry", name: "Sentry", category: "observability", kind: "oauth", url: "https://mcp.sentry.dev/mcp", logo: "sentry", color: "362D59" },
  { id: "cloudflare", name: "Cloudflare", category: "observability", kind: "oauth", url: "https://mcp.cloudflare.com/mcp", logo: "cloudflare", color: "F38020" },
  { id: "vercel", name: "Vercel", category: "dev", kind: "oauth", url: "https://mcp.vercel.com", logo: "vercel", color: "000000" },
  { id: "supabase", name: "Supabase", category: "data", kind: "oauth", url: "https://mcp.supabase.com/mcp", logo: "supabase", color: "3FCF8E" },
  { id: "stripe", name: "Stripe", category: "data", kind: "oauth", url: "https://mcp.stripe.com", logo: "stripe", color: "635BFF" },
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
  trackers: TrackerService;
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
      trackers: trackerService,
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

    const url = entry?.url ?? (await this.deps.mcp.get(id))?.config.url;
    if (url === undefined) throw new Error(`"${id}" não conecta por um clique`);
    if ((await this.deps.mcp.get(id)) === undefined) {
      await this.deps.mcp.register({ name: id, transport: "http", url });
    }
    await this.deps.oauth.connect(id);
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
        if (entry.id === "jira") {
          const jira = (await this.deps.trackers.list()).filter((t) => t.kind === "jira");
          return { ...base, state: jira.some((t) => t.stored) ? "connected" : "available" };
        }
        if (entry.id === "slack") {
          const s = await this.deps.slack.get();
          return { ...base, state: s.server === null ? "available" : "connected" };
        }
        return { ...base, state: "available" };
      }
      case "soon":
        return { ...base, state: "soon" };
    }
  }
}

export const connectionService = new ConnectionService();
