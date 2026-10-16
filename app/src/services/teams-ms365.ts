/**
 * O servidor MCP do Microsoft 365 (ms365, softeria) que a pessoa já usa no
 * Claude Code, reconhecido antes de importar. Importar não sobe o servidor,
 * então não há lista de ferramentas: vale o nome e o pacote. Depois de testado,
 * quem decide é `teamsNoMcp`, pelas ferramentas. "teams" sozinho não conta: um
 * `teams-alerts` ou `teams-notifier` costuma só avisar, sem ler chat.
 */

const NOME = /ms-?365|m365|microsoft[-_ ]?365|softeria/i;
/** No comando ou endereço só vale o pacote: um caminho qualquer pode ter "ms365" no meio (uma pasta de projeto). */
const PACOTE = /softeria|ms-365-mcp-server|microsoft-365-mcp/i;

interface Reconhecivel {
  name: string;
  destino: string;
}

export function trazOTeams(c: Reconhecivel): boolean {
  return NOME.test(c.name) || PACOTE.test(c.destino);
}

/** Do mais ao menos indicado: o nome ms365, depois o pacote, e quem falta variável por último. */
function pontos(c: Reconhecivel & { faltando: string[] }): number {
  let p = 0;
  if (/^ms-?365$/i.test(c.name)) p += 4;
  else if (NOME.test(c.name)) p += 2;
  if (PACOTE.test(c.destino)) p += 1;
  if (c.faltando.length > 0) p -= 10;
  return p;
}

/** Os que trazem o Teams, o mais indicado primeiro. Empate fica na ordem em que vieram. */
export function candidatosDoTeams<T extends Reconhecivel & { faltando: string[] }>(candidatos: readonly T[]): T[] {
  return candidatos
    .filter(trazOTeams)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => pontos(b.c) - pontos(a.c) || a.i - b.i)
    .map(({ c }) => c);
}

export function escolherRecomendado<T extends Reconhecivel & { faltando: string[] }>(candidatos: readonly T[]): T | null {
  return candidatosDoTeams(candidatos)[0] ?? null;
}
