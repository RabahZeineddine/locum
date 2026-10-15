import { GATILHOS, PASSOS, type AppDoComponente } from "./automacao";

/** O que uma conexão libera na montagem de automação, pelos ids da paleta. */
export interface Libera {
  /** Gatilhos que ela acorda (`GATILHOS`). */
  gatilhos: string[];
  /** Ações de app que ela permite (`PASSOS`). */
  acoes: string[];
}

/**
 * Que app da paleta cada conexão acende. O Shortcut abre tarefa pelo mesmo
 * passo que a Atlassian, porque o destino é um tracker cadastrado.
 */
const APP_DA_CONEXAO: Readonly<Record<string, AppDoComponente>> = {
  slack: "slack",
  teams: "teams",
  github: "github",
  atlassian: "atlassian",
  shortcut: "atlassian",
};

/**
 * O que a conexão libera, nas palavras da automação: gatilhos e ações de app.
 * Quem tem servidor MCP libera ainda a ação genérica de chamar uma ferramenta.
 * Quantas ferramentas são vem da lista do servidor, e não daqui.
 */
export function liberaDaConexao(id: string, { servidor }: { servidor: boolean }): Libera {
  const app = APP_DA_CONEXAO[id];
  const gatilhos = app === undefined ? [] : GATILHOS.filter((g) => g.app === app).map((g) => g.id);
  const acoes = app === undefined ? [] : PASSOS.filter((p) => p.app === app).map((p) => p.id);
  if (servidor) acoes.push("mcp.call");
  return { gatilhos, acoes };
}
