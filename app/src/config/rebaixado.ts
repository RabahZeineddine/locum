import { z } from "zod";

/**
 * Um passo de ação que entrou em `approve` mesmo tendo vindo em `auto` (o pacote importado
 * nunca publica sozinho sem a pessoa dizer). Fica marcado no spec para o editor e o MCP
 * mostrarem, e para a pessoa voltar para `auto` de propósito.
 */
export const Rebaixado = z.object({
  passo: z.string().min(1),
  /** O código de por que foi rebaixado; o texto vem do dicionário da tela. */
  motivo: z.string().min(1),
});
export type Rebaixado = z.infer<typeof Rebaixado>;

export const REBAIXADO_NA_IMPORTACAO = "rebaixado-na-importacao";
/** Reexecução com instrução: a ação a jusante que estava em `auto` espera na Fila (`steps.rebaixado`, só naquele run). */
export const REBAIXADO_NA_REEXECUCAO = "rebaixado-na-reexecucao";

/**
 * Os passos dos quais `chave` depende, direta ou indiretamente (`needs`).
 * Chave que não está no fluxo não tem ancestrais.
 */
export function ancestraisDe(passos: readonly { key: string; needs: readonly string[] }[], chave: string): Set<string> {
  const porChave = new Map(passos.map((p) => [p.key, p]));
  const out = new Set<string>();
  const pilha = [...(porChave.get(chave)?.needs ?? [])];
  while (pilha.length > 0) {
    const atual = pilha.pop()!;
    if (out.has(atual)) continue;
    out.add(atual);
    pilha.push(...(porChave.get(atual)?.needs ?? []));
  }
  return out;
}

/**
 * A ação sai do `auto` ou do `draft` para `approve` quando algum ancestral dela foi
 * reexecutado com instrução: o resultado que ela publicaria já não é o que o fluxo
 * desenhou. Só pede mais confirmação, nunca tira.
 */
export function rebaixadaPorInstrucao(
  passos: readonly { key: string; needs: readonly string[] }[],
  chave: string,
  comInstrucao: ReadonlySet<string>,
): boolean {
  if (comInstrucao.size === 0) return false;
  for (const a of ancestraisDe(passos, chave)) if (comInstrucao.has(a)) return true;
  return false;
}

type ComPassos = { steps: readonly object[]; rebaixados?: Rebaixado[] | undefined };

/**
 * Tira a marca do passo que saiu do spec ou que já não está em `approve`: a pessoa o
 * pôs em `auto` (ou em `draft`), e o aviso deixou de valer.
 */
export function limparRebaixados<S extends ComPassos>(spec: S): S {
  if (spec.rebaixados === undefined) return spec;
  const restantes = spec.rebaixados.filter((r) => {
    const passo = spec.steps.find((s) => (s as { key?: unknown }).key === r.passo) as { type?: unknown; mode?: unknown } | undefined;
    return passo !== undefined && passo.type === "action" && passo.mode === "approve";
  });
  if (restantes.length === spec.rebaixados.length) return spec;
  const { rebaixados: _antes, ...resto } = spec;
  return (restantes.length === 0 ? resto : { ...resto, rebaixados: restantes }) as S;
}

/** As marcas da versão anterior que o spec novo deixou de trazer voltam: omitir não é voltar para `auto`. */
export function manterRebaixados<S extends ComPassos>(novo: S, anteriores: readonly Rebaixado[]): S {
  const tem = new Set((novo.rebaixados ?? []).map((r) => r.passo));
  const voltam = anteriores.filter((r) => !tem.has(r.passo));
  return voltam.length === 0 ? novo : { ...novo, rebaixados: [...(novo.rebaixados ?? []), ...voltam] };
}
