import type { AgentSpec, Step } from "../config/types.js";

/** Ações que respondem a uma conversa e não têm o que fazer sem o evento dela. */
export const ACOES_DE_CONVERSA = new Set(["teams.post", "slack.post"]);

/** O review aponta o PR pelo evento, a menos que o fluxo diga owner, repo e pull nos `params`. */
const CAMPOS_DO_ALVO = ["owner", "repo", "pull"] as const;

const MARCADOR = /\{\{\s*(event(?:\.[\w.]+)?)\s*\}\}/;

function acaoExigeEvento(passo: Step): string | null {
  if (passo.type !== "action") return null;
  if (ACOES_DE_CONVERSA.has(passo.action)) return passo.action;
  if (passo.action === "github.review_comment") {
    const params = passo.params ?? {};
    return CAMPOS_DO_ALVO.every((c) => params[c] !== undefined) ? null : passo.action;
  }
  return null;
}

/**
 * Por que a automação não roda sem evento, ou nulo se roda.
 *
 * Um prompt com `{{event.repo}}` sem evento sai com `null` no lugar, e o modelo
 * responde sobre dado nenhum: paga a chamada para descobrir o que já se sabia.
 */
export function dependenciaDeEvento(spec: AgentSpec): string | null {
  for (const passo of spec.steps) {
    const marcador = MARCADOR.exec(JSON.stringify(passo));
    if (marcador !== null) return `usa {{${marcador[1]}}}`;
  }
  for (const passo of spec.steps) {
    const acao = acaoExigeEvento(passo);
    if (acao !== null) return `tem a ação ${acao}`;
  }
  return null;
}

export const recusaSemEvento = (motivo: string): string =>
  `esta automação precisa de um evento (${motivo}); escolha um evento recente ou cole um link`;
