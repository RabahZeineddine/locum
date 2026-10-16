import type { AgentSpec, Step } from "../config/types.js";

// O renderer importa este arquivo para traduzir a recusa: nada de Node aqui.

/** Ações que respondem a uma conversa e não têm o que fazer sem o evento dela. */
export const ACOES_DE_CONVERSA = new Set(["teams.post", "slack.post", "teams.react", "slack.react"]);

/**
 * Por que a automação depende de evento, em código e parâmetros. Quem mostra
 * o motivo (o diálogo, o aviso do editor, o toast) traduz; o texto não mora aqui.
 */
export type MotivoDeEvento = { codigo: "marcador"; marcador: string } | { codigo: "acao"; acao: string };

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
 * Só o que o executor renderiza com o evento: o prompt do passo de modelo, os
 * `params` da ação e os campos de texto do passo lógico. Nome, chave e o resto
 * do passo podem citar `{{event.x}}` sem que isso faça do fluxo um dependente.
 */
function camposRenderizados(passo: Step): unknown[] {
  if (passo.type === "model") return [passo.prompt];
  if (passo.type === "action") return [passo.params];
  return [passo.value, passo.against, passo.title];
}

/**
 * Por que a automação não roda sem evento, ou nulo se roda.
 *
 * Um prompt com `{{event.repo}}` sem evento sai com `null` no lugar, e o modelo
 * responde sobre dado nenhum: paga a chamada para descobrir o que já se sabia.
 */
export function dependenciaDeEvento(spec: AgentSpec): MotivoDeEvento | null {
  for (const passo of spec.steps) {
    const marcador = MARCADOR.exec(JSON.stringify(camposRenderizados(passo)));
    if (marcador !== null) return { codigo: "marcador", marcador: `{{${marcador[1]}}}` };
  }
  for (const passo of spec.steps) {
    const acao = acaoExigeEvento(passo);
    if (acao !== null) return { codigo: "acao", acao };
  }
  return null;
}

const INICIO_DO_CODIGO = "[[evento-obrigatorio ";
const FIM_DO_CODIGO = "]]";

/**
 * A recusa de rodar sem evento. O texto em português é o que lê quem chega
 * pelo MCP; o código e os parâmetros vão no fim, e o renderer troca o texto
 * todo pela tradução (`motivoDaMensagem`).
 */
export const recusaSemEvento = (motivo: MotivoDeEvento): string => {
  const quando = motivo.codigo === "marcador" ? `usa ${motivo.marcador}` : `tem a ação ${motivo.acao}`;
  return `esta automação precisa de um evento (${quando}); escolha um evento recente ou cole um link ${INICIO_DO_CODIGO}${JSON.stringify(motivo)}${FIM_DO_CODIGO}`;
};

/** O motivo que a mensagem de recusa carrega, ou nulo se a mensagem é de outra coisa. */
export function motivoDaMensagem(mensagem: string): MotivoDeEvento | null {
  const inicio = mensagem.indexOf(INICIO_DO_CODIGO);
  if (inicio < 0) return null;
  const fim = mensagem.indexOf(FIM_DO_CODIGO, inicio);
  if (fim < 0) return null;
  try {
    const motivo = JSON.parse(mensagem.slice(inicio + INICIO_DO_CODIGO.length, fim)) as Partial<MotivoDeEvento> | null;
    if (motivo?.codigo === "marcador" && typeof motivo.marcador === "string") return { codigo: "marcador", marcador: motivo.marcador };
    if (motivo?.codigo === "acao" && typeof motivo.acao === "string") return { codigo: "acao", acao: motivo.acao };
  } catch {
    // marcador estragado: cai no texto como veio
  }
  return null;
}
