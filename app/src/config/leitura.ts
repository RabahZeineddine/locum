// Sem dependência de Node: a janela usa o mesmo critério para marcar cada
// ferramenta como leitura ou escrita na tela de servidores.

const VERBOS_DE_ESCRITA =
  /(^|_)(send|create|delete|update|modify|move|rename|upload|copy|trash|untrash|forward|respond|reply|set|add|remove|ack|resolve|close|cancel|declare|assign|transition|link|unlink|publish|merge|push|fork|write|edit|execute|run|login|rotate|revoke|complete|reopen|post|schedule|share|restore|sync|request|emit|change|batch|import|invite|approve|submit|start|stop|trigger|draft|mark|archive|pin|unpin|enable|disable|graphql|call)(_|$)/i;
const VERBOS_DE_LEITURA =
  /(^|_)(get|list|search|read|find|query|fetch|describe|analyze|show|preview|lookup|catalog|status|metrics|trend|insights|stats|statistics|history|logs|whoami|who|me|info|resource|resources|availability|codetable|codetables|trace|details|events|tree|schema|versions|branches|products|product|policy|proposal|documents|underwriting|endorsement|report|convert|natural)(_|$)/i;

/**
 * Leitura ou escrita pelo nome, porque o Claude Code não entrega as anotações
 * da ferramenta. Na dúvida é escrita: só passa o nome com verbo de leitura e
 * sem verbo de escrita. Escrita fica de fora do passo de modelo como em
 * qualquer servidor; sair para fora é nó de ação.
 */
export function ehLeitura(ferramenta: string): boolean {
  const curto = ferramenta.replace(/^mcp__.+?__/, "").replace(/([a-z])([A-Z])/g, "$1_$2");
  return VERBOS_DE_LEITURA.test(curto) && !VERBOS_DE_ESCRITA.test(curto);
}
