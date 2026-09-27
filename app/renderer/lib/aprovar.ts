import { BRIDGE_GLOBAL, type DecisionResult } from "../../electron/bridge-contract.js";

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
    decide: (id: string, decisao: Decisao) => Promise<DecisionResult>;
    update: (id: string, findings: unknown[], verdict: string) => Promise<unknown>;
  };
}

function ponte(): PonteDeDecisao {
  const achada = (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL] as
    | PonteDeDecisao
    | undefined;
  if (!achada?.approvals?.decide) throw new Error("ponte indisponivel");
  return achada;
}

export async function decidir(approvalId: string, decisao: Decisao): Promise<DecisionResult> {
  return ponte().approvals.decide(approvalId, decisao);
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
): Promise<void> {
  await ponte().approvals.update(approvalId, findings, verdict);
}
