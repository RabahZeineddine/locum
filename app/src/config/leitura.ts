// Sem dependência de Node: a janela usa o mesmo critério para marcar cada
// ferramenta como leitura ou escrita na tela de servidores.

const VERBOS_DE_ESCRITA =
  /(^|_)(send|create|delete|update|modify|move|rename|upload|copy|trash|untrash|forward|respond|reply|set|add|remove|ack|resolve|close|cancel|declare|assign|transition|link|unlink|publish|merge|push|fork|write|edit|execute|run|login|rotate|revoke|complete|reopen|post|schedule|share|restore|sync|request|emit|change|batch|import|invite|approve|submit|start|stop|trigger|draft|mark|archive|pin|unpin|enable|disable|graphql|call|drop|purge|clear|destroy|kill|lock|unlock|grant|snooze|subscribe|unsubscribe|acknowledge|export|reset|truncate|wipe|erase|deploy|rollback|revert|disconnect|connect|reopen)(_|$)/i;

/** Verbos de escrita que, sozinhos, não pesam quando o nome abre com verbo de leitura: `get_pull_request`, `get_workflow_run`. */
const VERBOS_FRACOS = new Set(["request", "run"]);
const PREFIXOS_DE_LEITURA = /^(get|list|search|read|fetch|query|describe|show|view|find|lookup|count|retrieve|analyze|preview)_/;
const VERBOS_DE_LEITURA =
  /(^|_)(get|list|search|read|find|query|fetch|describe|analyze|show|preview|lookup|catalog|status|metrics|trend|insights|stats|statistics|history|logs|deeplink|whoami|who|me|info|resource|resources|availability|codetable|codetables|trace|details|events|tree|schema|versions|branches|products|product|policy|proposal|documents|underwriting|endorsement|report|convert|natural)(_|$)/i;

function normalizar(ferramenta: string): string {
  return ferramenta.replace(/^mcp__.+?__/, "").replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/-/g, "_");
}

/** Nome que escreve em algum lugar, ainda que local (`download-bytes-to-file`): vale sobre qualquer anotação. Só o verbo inicial ou `to_file`/`upload` decidem: `get-update-status` lê. */
function escreveNoNome(curto: string): boolean {
  if (/(^|_)(to_file|upload)(_|$)/.test(curto)) return true;
  const primeiro = curto.split("_")[0] ?? "";
  return VERBOS_DE_ESCRITA.test(primeiro) && !VERBOS_FRACOS.has(primeiro);
}

/**
 * Leitura ou escrita pelo nome, porque o Claude Code não entrega as anotações
 * da ferramenta. Na dúvida é escrita: só passa o nome com verbo de leitura e
 * sem verbo de escrita. Escrita fica de fora do passo de modelo como em
 * qualquer servidor; sair para fora é nó de ação.
 */
export function ehLeitura(ferramenta: string): boolean {
  const curto = normalizar(ferramenta);
  if (escreveNoNome(curto)) return false;
  // Nome composto com hífen (ms365): leitura só com verbo de leitura na frente.
  // Substantivo solto (`drop-schema`, `clear-logs`) não basta.
  const composto = /-/.test(ferramenta.replace(/^mcp__.+?__/, ""));
  if (!composto && VERBOS_DE_LEITURA.test(curto) && !VERBOS_DE_ESCRITA.test(curto)) return true;
  // `get_pull_request` e `pull_request_read` leem, mesmo com `request` no nome.
  // Verbo de escrita de verdade (`get_and_delete`) ainda ganha da regra.
  if (PREFIXOS_DE_LEITURA.test(curto) || curto.endsWith("_read")) {
    return !curto.split("_").some((p) => VERBOS_DE_ESCRITA.test(p) && !VERBOS_FRACOS.has(p));
  }
  return false;
}

/** O que o servidor diz de cada ferramenta, quando diz. */
export interface FerramentaClassificavel {
  name: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/**
 * Leitura ou escrita de uma ferramenta de servidor MCP: a anotação do servidor
 * manda, e o nome só decide quando o servidor não anotou, exceto o nome que
 * escreve (`escreveNoNome`), que nunca é leitura.
 */
export function ehLeituraDa(f: FerramentaClassificavel): boolean {
  if (escreveNoNome(normalizar(f.name))) return false;
  if (f.readOnlyHint !== undefined) return f.readOnlyHint;
  if (f.destructiveHint === true) return false;
  return ehLeitura(f.name);
}

/** Servidor com mais leituras que isto não liga todas por padrão: a pessoa escolhe as que o agent precisa. */
export const LIMITE_DE_LEITURA_PADRAO = 30;

/**
 * Se a ferramenta vem ligada quando a pessoa não escolheu nada. Leitura liga
 * sozinha, a não ser na conexão de modo `limitada` com servidor grande (ms365
 * tem mais de cem), onde ligar tudo gasta contexto. O agent salvo antes não
 * tem modo e segue com toda leitura ligada.
 */
export function ligadaPorPadrao(
  f: FerramentaClassificavel,
  leiturasDoServidor: number,
  modo: "todas" | "limitada" | undefined,
): boolean {
  if (modo === "limitada" && leiturasDoServidor > LIMITE_DE_LEITURA_PADRAO) return false;
  return ehLeituraDa(f);
}

/**
 * O que a tela grava ao adicionar a conexão a um agent. Servidor com lista
 * conhecida e de até `LIMITE_DE_LEITURA_PADRAO` leituras: cada leitura vira
 * escolha explícita, e nenhuma regra reavaliada depois tira o que estava
 * ligado. Servidor grande, ou sem lista guardada ainda, fica em `limitada`: nada
 * ligado até a pessoa escolher.
 */
export function escolhaInicial(
  servidores: readonly { nome: string; ferramentas: readonly FerramentaClassificavel[] | null }[],
): { tools: Record<string, boolean>; leituraPadrao?: "limitada" } {
  const tools: Record<string, boolean> = {};
  let limitada = false;
  for (const { nome, ferramentas } of servidores) {
    if (ferramentas === null) {
      limitada = true;
      continue;
    }
    const leituras = ferramentas.filter(ehLeituraDa).length;
    if (leituras > LIMITE_DE_LEITURA_PADRAO) {
      limitada = true;
      continue;
    }
    for (const f of ferramentas) if (ehLeituraDa(f)) tools[`${nome}/${f.name}`] = true;
  }
  return limitada ? { tools, leituraPadrao: "limitada" } : { tools };
}

/** Valor de `AgentConnection.tools`: liga, desliga, ou liga declarando que a ferramenta lê. */
export type EscolhaDeFerramenta = boolean | "read";

/** A escolha da pessoa para uma ferramenta: a chave `servidor/ferramenta` vale sobre a antiga, só pelo nome. */
export function escolhaDe(
  tools: Readonly<Record<string, EscolhaDeFerramenta>>,
  servidor: string,
  nome: string,
): EscolhaDeFerramenta | undefined {
  return tools[`${servidor}/${nome}`] ?? tools[nome];
}
