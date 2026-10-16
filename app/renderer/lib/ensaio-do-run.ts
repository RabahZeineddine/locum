/**
 * Ensaio: o passo de ação que, num run sem conversa de verdade (link de PR
 * colado), terminou mostrando o texto que sairia em vez de publicar. A decisão
 * de virar ensaio é do executor; aqui só se lê o que ele gravou.
 */

export interface EnsaioDoPasso {
  motivo: string;
  text: string | null;
}

/** A saída de um passo que virou ensaio, ou nulo para qualquer outra saída. */
export function ensaioDoPasso(output: unknown): EnsaioDoPasso | null {
  if (output === null || typeof output !== "object") return null;
  const o = output as { state?: unknown; motivo?: unknown; text?: unknown };
  if (o.state !== "ensaio") return null;
  return { motivo: typeof o.motivo === "string" ? o.motivo : "", text: typeof o.text === "string" ? o.text : null };
}

/** Os passos do run que terminaram em ensaio, na ordem em que aparecem. */
export function passosEmEnsaio(steps: readonly { stepKey: string; output: unknown }[]): (EnsaioDoPasso & { stepKey: string })[] {
  const achados: (EnsaioDoPasso & { stepKey: string })[] = [];
  for (const passo of steps) {
    const ensaio = ensaioDoPasso(passo.output);
    if (ensaio !== null) achados.push({ stepKey: passo.stepKey, ...ensaio });
  }
  return achados;
}

const RUN_E_PASSO = /^([0-9a-f-]{36})(?:@(.+))?$/i;

/**
 * O `detalhe` da rota de Execuções: o id do run, com o passo depois de `@`
 * quando a pessoa vem de "Ver o que sairia". Nulo quando não é um run (o
 * detalhe também carrega o filtro por agent).
 */
export function passoDoDetalhe(detalhe: string | null | undefined): { runId: string; stepKey: string | null } | null {
  if (detalhe === null || detalhe === undefined) return null;
  const achou = RUN_E_PASSO.exec(detalhe);
  return achou === null ? null : { runId: achou[1]!, stepKey: achou[2] ?? null };
}

/** O detalhe da rota que abre o run já no passo. */
export function detalheDoRunNoPasso(runId: string, stepKey: string): string {
  return `${runId}@${stepKey}`;
}

/** Para onde o texto sairia, pela ação do passo: a tela traduz cada destino. */
export function ondeSairia(acao: string | undefined): "teams" | "slack" | "github" | "outro" {
  if (acao === "teams.post") return "teams";
  if (acao === "slack.post") return "slack";
  if (acao !== undefined && acao.startsWith("github.")) return "github";
  return "outro";
}

interface PassoDeCusto {
  stepKey: string;
  costUsd: number;
  billable: boolean;
}

/** Soma dos passos, separando o que foi cobrado do que só foi estimado (assinatura). */
function somar(passos: readonly PassoDeCusto[]): { cobrado: number; naoCobrado: number } {
  let cobrado = 0;
  let naoCobrado = 0;
  for (const p of passos) {
    if (p.billable) cobrado += p.costUsd;
    else naoCobrado += p.costUsd;
  }
  return { cobrado, naoCobrado };
}

/**
 * O teto por run (da automação, e o de cada agent da biblioteca nos passos que
 * o usam) que a estimativa passou sem que o orçamento barrasse, porque parte do
 * gasto saiu da assinatura e não conta em dólar. Só existe aviso quando há
 * passo não cobrado com custo: modelo sem preço cadastrado é cobrado com custo
 * zero e não é assinatura. Devolve o primeiro teto estourado, ou nulo.
 */
export function estimativaAcimaDoTeto(run: {
  spec: { budget: { perRunUsd?: number | undefined }; steps: readonly { key: string; profile?: string | undefined }[] };
  steps: readonly PassoDeCusto[];
  tetosDosAgents: Readonly<Record<string, number>>;
}): { estimateUsd: number; capUsd: number } | null {
  const passou = (passos: readonly PassoDeCusto[], teto: number | undefined): { estimateUsd: number; capUsd: number } | null => {
    if (teto === undefined) return null;
    const { cobrado, naoCobrado } = somar(passos);
    return naoCobrado > 0 && cobrado + naoCobrado > teto ? { estimateUsd: cobrado + naoCobrado, capUsd: teto } : null;
  };

  const daAutomacao = passou(run.steps, run.spec.budget.perRunUsd);
  if (daAutomacao !== null) return daAutomacao;
  for (const [agentId, teto] of Object.entries(run.tetosDosAgents)) {
    const chaves = new Set(run.spec.steps.filter((s) => s.profile === agentId).map((s) => s.key));
    const doAgent = passou(run.steps.filter((p) => chaves.has(p.stepKey)), teto);
    if (doAgent !== null) return doAgent;
  }
  return null;
}
