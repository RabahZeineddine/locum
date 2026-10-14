import type { ParsedGithubPr } from "./slack.js";

/** Quantos PRs de uma mensagem viram evento. Passou disso é lista de colar, não pedido de revisão. */
export const MAX_PR_POR_MENSAGEM = 5;

/**
 * Link de pull request do GitHub: `/pull/<n>` seguido de fim, `/files`, query,
 * âncora ou pontuação. O `(?!\w)` recusa `/pull/7abc`, e o `/` logo depois de
 * `github.com` recusa `github.com.outro.io`. Aceita `www.`.
 */
const LINK = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?!\w)/gi;

/**
 * Os PRs citados num texto, na ordem em que aparecem, sem repetir.
 *
 * Serve a HTML cru: o link vive no `href` e some quando as tags saem.
 */
export function extractGithubPrLinks(texto: string): ParsedGithubPr[] {
  // Link dentro de código ou bloco de código é exemplo, não pedido de revisão.
  texto = texto.replace(/<(code|pre)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const vistos = new Set<string>();
  const achados: ParsedGithubPr[] = [];
  for (const m of texto.matchAll(LINK)) {
    const pr = { owner: m[1]!, repo: m[2]!, pull: Number(m[3]!) };
    const chave = `${pr.owner}/${pr.repo}#${pr.pull}`.toLowerCase();
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    achados.push(pr);
    if (achados.length === MAX_PR_POR_MENSAGEM) break;
  }
  return achados;
}
