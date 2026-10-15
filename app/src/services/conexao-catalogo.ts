/**
 * O catálogo de conexões e a regra que diz a qual item dele um servidor MCP
 * cadastrado pertence. Puro: o cadastro, o cofre e a tela leem daqui.
 */

export type ConnectionCategory = "dev" | "communication" | "work" | "observability" | "data";

/**
 * Como cada conexão liga.
 *
 * Claude Code e opencode não estão aqui: são o Locum dentro da ferramenta de
 * código, e moram na Configuração.
 *
 * - `github`: token pessoal no cofre, pelo painel.
 * - `oauth`: servidor MCP remoto que aceita registro automático; um clique abre o navegador.
 * - `panel`: liga por um formulário do próprio Locum (Jira, Slack, Teams, Grafana).
 * - `soon`: ainda sem caminho que não exija terminal, e a tela diz o porquê.
 */
export type ConnectionKind = "github" | "oauth" | "panel" | "soon";

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
 * deixa conectar sem client id. Slack e GitHub remoto não anunciam, e por isso
 * não estão aqui como `oauth`. O Asana anuncia só no endereço `v2`.
 */
export const CATALOG: CatalogEntry[] = [
  { id: "github", name: "GitHub", category: "dev", kind: "github", logo: "github", color: "181717" },
  { id: "notion", name: "Notion", category: "work", kind: "oauth", url: "https://mcp.notion.com/mcp", logo: "notion", color: "000000" },
  { id: "atlassian", name: "Atlassian", category: "work", kind: "oauth", url: "https://mcp.atlassian.com/v1/mcp", logo: "atlassian", color: "0052CC" },
  { id: "slack", name: "Slack", category: "communication", kind: "panel", logo: null, color: "4A154B" },
  { id: "teams", name: "Microsoft Teams", category: "communication", kind: "panel", logo: null, color: "5059C9" },
  { id: "grafana", name: "Grafana", category: "observability", kind: "panel", logo: "grafana", color: "F46800" },
  { id: "figma", name: "Figma", category: "work", kind: "oauth", url: "https://mcp.figma.com/mcp", logo: "figma", color: "F24E1E" },
  { id: "shortcut", name: "Shortcut", category: "work", kind: "oauth", url: "https://mcp.shortcut.com/mcp", logo: "shortcut", color: "58B1E4" },
  { id: "linear", name: "Linear", category: "work", kind: "oauth", url: "https://mcp.linear.app/mcp", logo: "linear", color: "5E6AD2" },
  { id: "asana", name: "Asana", category: "work", kind: "oauth", url: "https://mcp.asana.com/v2/mcp", logo: "asana", color: "F06A6A" },
  { id: "miro", name: "Miro", category: "work", kind: "oauth", url: "https://mcp.miro.com/", logo: "miro", color: "050038" },
  { id: "canva", name: "Canva", category: "work", kind: "oauth", url: "https://mcp.canva.com/mcp", logo: null, color: "00C4CC" },
  { id: "vercel", name: "Vercel", category: "dev", kind: "oauth", url: "https://mcp.vercel.com", logo: "vercel", color: "000000" },
  { id: "sentry", name: "Sentry", category: "observability", kind: "oauth", url: "https://mcp.sentry.dev/mcp", logo: "sentry", color: "362D59" },
  { id: "newrelic", name: "New Relic", category: "observability", kind: "oauth", url: "https://mcp.newrelic.com/mcp", logo: "newrelic", color: "008C99" },
  { id: "amplitude", name: "Amplitude", category: "data", kind: "oauth", url: "https://mcp.amplitude.com/mcp", logo: null, color: "1E61F0" },
  { id: "posthog", name: "PostHog", category: "data", kind: "oauth", url: "https://mcp.posthog.com/mcp", logo: "posthog", color: "F54E00" },
  { id: "intercom", name: "Intercom", category: "communication", kind: "oauth", url: "https://mcp.intercom.com/mcp", logo: "intercom", color: "1F8DED" },
];


/**
 * Hosts que também identificam o item, além do de `url`: o GitHub e o Slack
 * remotos não são `oauth` no catálogo, mas os servidores deles existem.
 */
const HOSTS_EXTRAS: Readonly<Record<string, readonly string[]>> = {
  github: ["api.githubcopilot.com", "githubcopilot.com"],
  slack: ["mcp.slack.com"],
};

/** Nomes que as ferramentas de origem dão ao servidor de um item. */
const NOMES_EXTRAS: Readonly<Record<string, string>> = {
  ms365: "teams",
  "ms-365": "teams",
  microsoft365: "teams",
};

/** Pacotes de servidores stdio que são de um item. */
const PACOTES: Readonly<Record<string, string>> = {
  "@softeria/ms-365-mcp-server": "teams",
};

/**
 * A qual item do catálogo um servidor cadastrado pertence: pelo nome (o id, ou
 * um apelido conhecido), pelo host do endereço ou pelo pacote do comando.
 * Quem não casa é conexão própria.
 */
export function conexaoDoServidor(config: { name: string; url?: string; command?: string[] }): CatalogEntry | undefined {
  const nome = config.name.toLowerCase();
  const porId = CATALOG.find((c) => c.id === nome);
  if (porId !== undefined) return porId;
  const porApelido = NOMES_EXTRAS[nome];
  if (porApelido !== undefined) return CATALOG.find((c) => c.id === porApelido);

  const host = hostDe(config.url);
  if (host !== null) {
    const porHost = CATALOG.find((c) => hostDe(c.url) === host || (HOSTS_EXTRAS[c.id] ?? []).includes(host));
    if (porHost !== undefined) return porHost;
  }
  for (const parte of config.command ?? []) {
    const dono = PACOTES[parte.replace(/@[^@/]+$/, "")];
    if (dono !== undefined) return CATALOG.find((c) => c.id === dono);
  }
  return undefined;
}

function hostDe(url: string | undefined): string | null {
  if (url === undefined) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
