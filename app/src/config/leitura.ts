// Sem dependência de Node: a janela usa o mesmo critério para marcar cada
// ferramenta como leitura ou escrita na tela de servidores.

const VERBOS_DE_ESCRITA =
  /(^|_)(send|create|delete|update|modify|move|rename|upload|copy|trash|untrash|forward|respond|reply|set|add|remove|ack|resolve|close|cancel|declare|assign|transition|link|unlink|publish|merge|push|fork|write|edit|execute|run|login|rotate|revoke|complete|reopen|post|schedule|share|restore|sync|request|emit|change|batch|import|invite|approve|submit|start|stop|trigger|draft|mark|archive|pin|unpin|enable|disable|graphql|call|drop|purge|clear|destroy|kill|lock|unlock|grant|snooze|subscribe|unsubscribe|acknowledge|export|reset|truncate|wipe|erase|deploy|rollback|revert)(_|$)/i;

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
  // `connect` e `disconnect` só pesam na frente: `get_code_connect_map` lê.
  if (primeiro === "connect" || primeiro === "disconnect") return true;
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
    const partes = curto.split("_");
    if (partes.some((p) => VERBOS_DE_ESCRITA.test(p) && !VERBOS_FRACOS.has(p))) return false;
    // `run` e `request` só passam como substantivo (`get_workflow_run`, `get_pull_request`):
    // depois de `and`/`then`/`or` ou colados no verbo de leitura (`preview_run`) são ação.
    if (PREFIXOS_DE_LEITURA.test(curto)) {
      const fraco = (i: number) => VERBOS_FRACOS.has(partes[i] ?? "");
      if (fraco(1) || partes.some((p, i) => i > 0 && fraco(i) && ["and", "then", "or"].includes(partes[i - 1] ?? ""))) return false;
    }
    return true;
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

/**
 * Se o passo `mcp.call` desta ferramenta só lê: o servidor tem de ter anotado
 * `readOnlyHint` (o nome sozinho engana: `query`, `report_issue`), e o nome não
 * pode escrever. Sem anotação conta como escrita. É o critério do executor
 * para o ensaio e o da paleta do editor para o selo e o modo de nascimento.
 */
export function ehLeituraNaAcao(f: FerramentaClassificavel): boolean {
  return f.readOnlyHint === true && ehLeituraDa(f);
}

/** Servidor com mais leituras que isto não liga todas por padrão: a pessoa escolhe as que o agent precisa. */
export const LIMITE_DE_LEITURA_PADRAO = 30;

/**
 * Se a ferramenta vem ligada quando a pessoa não escolheu nada. Leitura liga
 * sozinha. Na conexão de modo `limitada`, que a tela grava ao adicionar a um
 * servidor grande (ms365 tem mais de cem), nada liga por padrão: só o que está
 * em `tools`. O agent salvo antes não tem modo e segue com toda leitura ligada.
 */
export function ligadaPorPadrao(
  f: FerramentaClassificavel,
  modo: "todas" | "limitada" | undefined,
): boolean {
  if (modo === "limitada") return false;
  return ehLeituraDa(f);
}

/** Servidor com lista conhecida e de até `LIMITE_DE_LEITURA_PADRAO` leituras liga cada leitura; servidor grande não liga nada. */
function ligaLeituras(ferramentas: readonly FerramentaClassificavel[]): boolean {
  return ferramentas.filter(ehLeituraDa).length <= LIMITE_DE_LEITURA_PADRAO;
}

/**
 * O que a tela grava ao adicionar a conexão a um agent: sempre a lista
 * explícita. Servidor com lista conhecida e de até `LIMITE_DE_LEITURA_PADRAO`
 * leituras liga cada leitura; o resto fica desligado e registrado. Servidor
 * grande não liga nada: a pessoa escolhe. Sem lista guardada de algum
 * servidor, a linha de base fica `pendente` até a lista chegar. A ferramenta
 * que o servidor ganhar depois não está no mapa, e ausente é desligada.
 */
export function escolhaInicial(
  servidores: readonly { nome: string; ferramentas: readonly FerramentaClassificavel[] | null }[],
): { tools: Record<string, boolean>; leituraPadrao: "limitada"; linhaDeBase: "pendente" | "feita" } {
  const tools: Record<string, boolean> = {};
  let pendente = false;
  for (const { nome, ferramentas } of servidores) {
    if (ferramentas === null) {
      pendente = true;
      continue;
    }
    const ligar = ligaLeituras(ferramentas);
    for (const f of ferramentas) tools[`${nome}/${f.name}`] = ligar && ehLeituraDa(f);
  }
  return { tools, leituraPadrao: "limitada", linhaDeBase: pendente ? "pendente" : "feita" };
}

/** O que `fixarLista` precisa de uma conexão: o mapa, o modo e a linha de base, que `AgentConnection` tem. */
type ConexaoDoAgent = {
  tools: Record<string, EscolhaDeFerramenta>;
  leituraPadrao?: "todas" | "limitada";
  linhaDeBase?: "pendente" | "feita";
};

/**
 * Passa a conexão para a lista explícita e grava a linha de base: toda
 * ferramenta do catálogo de agora fica no mapa, e a que a pessoa não escolheu
 * ganha o que valia (modo antigo: `true` para leitura, `false` para o resto),
 * a escolha inicial (conexão `pendente`) ou `false` (`limitada` que veio sem
 * marcador). Daí em diante o save só preserva o mapa, e "novas" é o que o
 * servidor ganhou depois. Chave só pelo nome vira `servidor/ferramenta`. Sem
 * lista guardada de algum servidor não dá para saber o que existe, e a
 * conexão volta como estava.
 */
export function fixarLista<C extends ConexaoDoAgent>(
  conexao: C,
  servidores: readonly { nome: string; ferramentas: readonly FerramentaClassificavel[] | null }[],
): C {
  if (servidores.length === 0 || servidores.some((s) => s.ferramentas === null)) return conexao;
  if (conexao.leituraPadrao === "limitada" && conexao.linhaDeBase === "feita") return conexao;
  const antigo = conexao.leituraPadrao !== "limitada";
  const pendente = conexao.linhaDeBase === "pendente";
  const tools: Record<string, EscolhaDeFerramenta> = { ...conexao.tools };
  for (const { nome, ferramentas } of servidores) {
    const ligar = pendente && ligaLeituras(ferramentas ?? []);
    for (const f of ferramentas ?? []) {
      const atual = escolhaDe(conexao.tools, nome, f.name);
      delete tools[f.name];
      tools[`${nome}/${f.name}`] = atual ?? (antigo ? ehLeituraDa(f) : pendente ? ligar && ehLeituraDa(f) : false);
    }
  }
  return { ...conexao, tools, leituraPadrao: "limitada" as const, linhaDeBase: "feita" as const };
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
