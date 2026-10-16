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

/**
 * Run que não foi cobrado (assinatura) e cuja estimativa passou do teto por
 * run da automação. O orçamento não olha estimativa de run não cobrado; o
 * aviso existe só para a pessoa não achar que o teto foi respeitado.
 */
export function estimativaAcimaDoTeto(run: { costUsd: number; estimateUsd: number; spec: { budget: { perRunUsd?: number | undefined } } }): boolean {
  const teto = run.spec.budget.perRunUsd;
  return teto !== undefined && run.costUsd === 0 && run.estimateUsd > teto;
}
