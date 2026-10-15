/** O que a tela oferece para ligar uma conexão de catálogo que fala OAuth. */
export interface ParaLigar {
  kind: "github" | "oauth" | "panel" | "soon";
  custom: boolean;
  state: "connected" | "attention" | "error" | "off" | "available" | "soon";
  /** Os servidores MCP cadastrados da conexão. */
  servers: readonly string[];
}

/**
 * A ação principal do detalhe. Desconectar só existe com servidor MCP
 * cadastrado: uma conexão que está de pé só por causa de um tracker (Jira por
 * token) não tem o que desconectar, e o que falta é conectar o servidor.
 */
export function acaoDeLigar(c: ParaLigar): "connect" | "reconnect" | "disconnect" | null {
  if (c.kind !== "oauth" || c.custom) return null;
  if (c.servers.length === 0) return "connect";
  if (c.state === "connected") return "disconnect";
  return c.state === "available" ? "connect" : "reconnect";
}

const CONEXAO_DO_TRACKER: Readonly<Record<string, string>> = {
  jira: "atlassian",
  "jira-atlassian": "atlassian",
  shortcut: "shortcut",
  "github-issues": "github",
};

/**
 * Para onde leva um destino `connections/<x>` que não é uma conexão: o id de um
 * tracker (a seção de trackers que saiu da Configuração), ou o Claude Code e o
 * opencode, que deixaram de ser conexões. Qualquer outra coisa cai na lista.
 */
export function destinoDeConexaoAntiga(
  id: string,
  trackers: readonly { id: string; kind: string }[],
): { rota: "connections" | "settings"; detalhe?: string } {
  if (id === "claude-code" || id === "opencode") return { rota: "settings", detalhe: "tools" };
  const dona = CONEXAO_DO_TRACKER[trackers.find((t) => t.id === id)?.kind ?? ""];
  return dona === undefined ? { rota: "connections" } : { rota: "connections", detalhe: dona };
}

/**
 * O que olhar no endereço do Ollama antes de salvar: `invalid` não é um
 * endereço http, e `noV1` não termina em `/v1`, onde fica a API compatível com
 * OpenAI (o aviso não bloqueia).
 */
export function avisoDoEnderecoDoOllama(endereco: string): "invalid" | "noV1" | null {
  const limpo = endereco.trim();
  if (limpo === "") return null;
  let url: URL;
  try {
    url = new URL(limpo);
  } catch {
    return "invalid";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "invalid";
  return url.pathname.replace(/\/$/, "").endsWith("/v1") ? null : "noV1";
}
