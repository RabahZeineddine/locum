import { BRIDGE_GLOBAL, type DecisionResult } from "../../electron/bridge-contract.js";
import { invalidateReads } from "./bridge.js";

/**
 * Acesso estreito a decisao de aprovacao.
 *
 * Isto fica fora de `lib/bridge.ts` de proposito. Aquele arquivo e o catalogo
 * que qualquer coisa rodando na janela enxerga, inclusive o assistente do chat,
 * e a emenda 5 do ADR 0003 existe porque `approvals.decide` dentro de um
 * catalogo e uma instrucao plantada num diff virando publicacao.
 *
 * Aprovar nao e uma acao da janela: e o clique de uma pessoa. Quem chama daqui
 * e o botao, e mais ninguem.
 */
type Decisao = "approved" | "rejected";

interface PonteDeDecisao {
  approvals: {
    decide: (id: string, decisao: Decisao, hashVisto?: string) => Promise<DecisionResult>;
    update: (id: string, findings: unknown[], verdict: string, summary?: string) => Promise<{ hash: string }>;
    updateText: (id: string, text: string) => Promise<{ hash: string }>;
    settleStuck: (id: string, outcome: "published" | "retry") => Promise<{ status: "approved" | "pending" }>;
  };
}

function ponte(): PonteDeDecisao {
  const achada = (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL] as
    | PonteDeDecisao
    | undefined;
  if (!achada?.approvals?.decide) throw new Error("ponte indisponivel");
  return achada;
}

/** O hash da pendência depois da última edição desta janela: a decisão carrega o que a pessoa viu, edição dela inclusa. */
const hashDaEdicao = new Map<string, string>();

/**
 * `hashVisto` é o `hash` da pendência como a tela a mostrou. Se a conversa do run ou o MCP
 * a mudaram desde então, a decisão é recusada em vez de publicar o que a pessoa não viu.
 */
export async function decidir(approvalId: string, decisao: Decisao, hashVisto?: string): Promise<DecisionResult> {
  const res = await ponte().approvals.decide(approvalId, decisao, hashDaEdicao.get(approvalId) ?? hashVisto);
  invalidateReads("approvals.listPending");
  invalidateReads("runs.list");
  return res;
}

/** Recarregar a pendência: o hash que esta janela guardou da edição dela deixa de valer, e a decisão volta a levar o que a tela mostrar. */
export function esquecerEdicao(approvalId: string): void {
  hashDaEdicao.delete(approvalId);
}

/**
 * Grava os achados revisados. Continua sendo edição de uma pessoa, e não
 * publicação: a pendência segue esperando o clique.
 *
 * Só os achados e o veredito vão: o alvo da publicação fica com o que o
 * executor gravou.
 */
export async function gravarRevisao(
  approvalId: string,
  findings: unknown[],
  verdict: string,
  summary?: string,
): Promise<void> {
  hashDaEdicao.set(approvalId, (await ponte().approvals.update(approvalId, findings, verdict, summary)).hash);
}

/** Grava o texto revisado de uma resposta de Slack ou Teams, sem publicar. */
export async function gravarTexto(approvalId: string, texto: string): Promise<void> {
  hashDaEdicao.set(approvalId, (await ponte().approvals.updateText(approvalId, texto)).hash);
}

/**
 * A pessoa conferiu o destino de uma pendência parada na publicação: `published`
 * fecha como aprovada e o run segue, `retry` devolve para a fila.
 */
export async function resolverParada(
  approvalId: string,
  desfecho: "published" | "retry",
): Promise<{ status: "approved" | "pending" }> {
  return ponte().approvals.settleStuck(approvalId, desfecho);
}
