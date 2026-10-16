import { homedir } from "node:os";

/**
 * Limpeza de texto livre antes de ele entrar num pacote.
 *
 * O pacote sai da máquina de quem exporta, e prompt, instrução e contexto são
 * texto que a pessoa escreveu: nada garante que não haja um token colado, um
 * e-mail ou um caminho do home. O que o formato não carrega por construção
 * (segredo do cofre, cursor, histórico) nem passa por aqui; isto é a segunda
 * rede, para o que alguém digitou dentro do texto.
 */

export interface Limpeza {
  texto: string;
  removidos: number;
}

const SEGREDO = "[segredo removido]";

const ID = "[id removido]";

/** Só o que é credencial: token, senha, cabeçalho de autorização, webhook e senha em URL. */
const PADROES_DE_SEGREDO: readonly [RegExp, string][] = [
  // Cabeçalho de autorização inteiro, qualquer esquema.
  [/\bAuthorization\s*[:=]\s*(?:Basic|Bearer|token|Digest)\s+\S+/gi, `Authorization: ${SEGREDO}`],
  // Webhook de entrada: o caminho é o segredo.
  [/https?:\/\/(?:hooks\.slack\.com\/(?:services|workflows|triggers)|(?:discord(?:app)?\.com)\/api\/webhooks|[\w.-]+\.webhook\.office\.com\/webhook\w*|outlook\.office\.com\/webhook\w*|hooks\.zapier\.com\/hooks|[\w.-]+\/webhook(?:-test)?\/)[^\s"')<>]*/gi, "[webhook removido]"],
  // Usuário e senha dentro da URL.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:?#]+(?::[^\s/@?#]*)?@/gi, "$1"],
  // Segredo na query.
  [/([?&](?:access_token|refresh_token|id_token|token|api[_-]?key|key|secret|client_secret|password|sig|signature|code)=)[^&\s"')<>]+/gi, `$1${SEGREDO}`],
  // JSON serializado: "access_token":"...", "clientSecret": "...".
  [/("(?:[\w.-]*(?:token|secret|password|passwd|senha|api[_-]?key|private[_-]?key|credential)[\w.-]*)"\s*:\s*")[^"]+"/gi, `$1${SEGREDO}"`],
  // Linha de ambiente: NOME_TOKEN=..., API_KEY=..., CLIENT_SECRET=...
  [/\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)S?\s*=\s*\S+/g, SEGREDO],
  // Cookie e Set-Cookie, a linha inteira.
  [/\b(?:Set-)?Cookie\s*:[^\n]+/gi, `Cookie: ${SEGREDO}`],
  [/\b(?:senha|password|passwd|pwd|secret|segredo|(?:access|refresh|id|api|auth)[_-]?token|token|api[_-]?key)\s*[:=]\s*\S+/gi, SEGREDO],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, SEGREDO],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, SEGREDO],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, SEGREDO],
  [/\bxapp-\d-[A-Za-z0-9-]{10,}/g, SEGREDO],
  [/\bxox[a-z](?:\.xox[a-z])?-[A-Za-z0-9-]{10,}/g, SEGREDO],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, SEGREDO],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, SEGREDO],
  [/\bnpm_[A-Za-z0-9]{30,}/g, SEGREDO],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, SEGREDO],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, SEGREDO],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, `Bearer ${SEGREDO}`],
];

/** Identificadores, e-mail e caminho do home: dado pessoal, que não é credencial. */
const PADROES_PESSOAIS: readonly [RegExp, string][] = [
  // Teams, explícitos: chat e canal (`@thread.v2`, `@thread.tacv2`), reunião e DM (`@unq.gbl.spaces`).
  [/\b19:[A-Za-z0-9_.=-]+@(?:thread\.[A-Za-z0-9]+|unq\.gbl\.spaces)/g, "[chat removido]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ID],
  // Slack: canal, grupo, DM, workspace e usuário (`<@U...>` também), com ao menos um dígito.
  [/\b[CGDWU](?=[A-Z0-9]*\d)[A-Z0-9]{8,}\b/g, ID],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[e-mail removido]"],
  [/[A-Za-z]:\\Users\\[^\\\s"']+/g, "~"],
  [/\/(?:Users|home)\/[^/\s"']+/g, "~"],
];

function escapar(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PADROES: readonly [RegExp, string][] = [...PADROES_DE_SEGREDO, ...PADROES_PESSOAIS];

/** Webhook de entrada e segredo na query: o que numa URL é credencial, sem mexer no resto do texto. */
export function ocultarCredencialDeUrl(url: string, marcador: string): string {
  return url
    .replace(PADROES_DE_SEGREDO[1]![0], marcador)
    .replace(PADROES_DE_SEGREDO[3]![0], `$1${marcador}`);
}

/**
 * Só as credenciais, sem tocar em id, e-mail nem caminho. Para o que sai de uma
 * leitura em que o id é o que a pessoa procura, como a fila de aprovação.
 */
export function limparSegredos(texto: string): string {
  let saida = texto;
  for (const [padrao, por] of PADROES_DE_SEGREDO) {
    saida = saida.replace(padrao, (...args: unknown[]) => por.replace(/\$(\d)/g, (_, n: string) => String(args[Number(n)])));
  }
  return saida;
}

export function limparTexto(texto: string, home: string = homedir()): Limpeza {
  let saida = texto;
  let removidos = 0;
  const trocar = (padrao: RegExp, por: string): void => {
    saida = saida.replace(padrao, (...args: unknown[]) => {
      removidos += 1;
      return por.replace(/\$(\d)/g, (_, n: string) => String(args[Number(n)]));
    });
  };
  // O home da máquina vem primeiro: o caminho inteiro, e não só o usuário.
  if (home.length > 1) trocar(new RegExp(escapar(home), "g"), "~");
  for (const [padrao, por] of PADROES) trocar(padrao, por);
  return { texto: saida, removidos };
}

/**
 * Campos que são texto escrito por gente. O resto (id, chave de passo, `needs`,
 * servidor, ferramenta) é estrutura: mexer nele quebraria o fluxo, e o formato
 * já não carrega nada sensível nele.
 */
const TEXTO_LIVRE = new Set(["prompt", "instructions", "context", "description", "input", "value", "against", "title", "path", "cases", "name", "repoMatch", "labels", "pergunta"]);

/** Limpa as strings dos campos de texto livre, em profundidade, sem mexer no resto. */
export function limparValor<T>(valor: T, home?: string): { valor: T; removidos: number } {
  let removidos = 0;
  const limpar = (v: unknown): unknown => {
    if (typeof v === "string") {
      const l = limparTexto(v, home);
      removidos += l.removidos;
      return l.texto;
    }
    if (Array.isArray(v)) return v.map(limpar);
    return v;
  };
  const limparTudo = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(limparTudo);
    if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, limparTudo(x)]));
    return limpar(v);
  };
  const percorrer = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(percorrer);
    if (typeof v === "object" && v !== null) {
      // `labels` tem a forma `{ include, exclude }`: o que está dentro também é texto.
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, TEXTO_LIVRE.has(k) ? limparTudo(x) : percorrer(x)]));
    }
    return v;
  };
  return { valor: percorrer(valor) as T, removidos };
}
