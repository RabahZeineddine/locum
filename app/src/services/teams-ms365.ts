/**
 * O servidor MCP do Microsoft 365 (ms365, softeria) que a pessoa já usa no
 * Claude Code, reconhecido antes de importar. Importar não sobe o servidor,
 * então não há lista de ferramentas: vale o nome e o pacote. Depois de testado,
 * quem decide é `teamsNoMcp`, pelas ferramentas.
 */

const TEAMS = /ms-?365|m365|microsoft[-_ ]?365|softeria/i;
/** No comando ou endereço só vale o pacote: um caminho qualquer pode ter "ms365" no meio (uma pasta de projeto). */
const PACOTE_TEAMS = /softeria|ms-365-mcp-server|microsoft-365-mcp/i;
/** "teams" sozinho só vale no nome do servidor: num comando ou caminho qualquer é ruído. */
const NOME_TEAMS = /(^|[^a-z0-9])teams([^a-z0-9]|$)/i;

interface Reconhecivel {
  name: string;
  destino: string;
}

export function trazOTeams(c: Reconhecivel): boolean {
  return TEAMS.test(c.name) || NOME_TEAMS.test(c.name) || PACOTE_TEAMS.test(c.destino);
}

/** Do mais ao menos indicado: o nome ms365, depois o pacote, e quem falta variável por último. */
function pontos(c: Reconhecivel & { faltando: string[] }): number {
  let p = 0;
  if (/^ms-?365$/i.test(c.name)) p += 4;
  else if (TEAMS.test(c.name) || NOME_TEAMS.test(c.name)) p += 2;
  if (PACOTE_TEAMS.test(c.destino)) p += 1;
  if (c.faltando.length > 0) p -= 10;
  return p;
}

export function escolherRecomendado<T extends Reconhecivel & { faltando: string[] }>(candidatos: readonly T[]): T | null {
  let melhor: T | null = null;
  for (const c of candidatos) {
    if (!trazOTeams(c)) continue;
    if (melhor === null || pontos(c) > pontos(melhor)) melhor = c;
  }
  return melhor;
}
