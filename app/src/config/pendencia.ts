import { z } from "zod";

/**
 * Um campo que a pessoa ainda precisa preencher numa automação gravada.
 *
 * Nasce quando o pacote importado traz o nó sem o que é desta máquina (destino
 * fixo, url, argumento, canal), e fica no spec para a automação saber que está
 * incompleta: o executor não roda o passo, e o gatilho não liga. Quem diz qual
 * é o campo e o motivo é a origem (os omitidos do pacote); nada aqui conhece uma
 * ação ou um app.
 *
 * - `onde`: a chave do passo, ou `gatilho:<kind>` para um gatilho.
 * - `campo`: o caminho dentro do passo (`params.destino`) ou da configuração do gatilho (`channels`).
 * - `motivo`: o código do que falta, o mesmo dos omitidos do pacote (`destino-a-escolher`, `url-a-preencher`...).
 */
export const Pendencia = z.object({
  onde: z.string().min(1),
  campo: z.string().min(1),
  motivo: z.string().min(1),
});
export type Pendencia = z.infer<typeof Pendencia>;

const PREFIXO_DO_GATILHO = "gatilho:";
export const ondeDoGatilho = (kind: string): string => `${PREFIXO_DO_GATILHO}${kind}`;
export const kindDoOnde = (onde: string): string | undefined => (onde.startsWith(PREFIXO_DO_GATILHO) ? onde.slice(PREFIXO_DO_GATILHO.length) : undefined);

/** O que cada motivo diz à pessoa, em texto de erro. A tela usa as chaves `pendencia.motivo.<código>` do i18n. */
const TEXTO_DO_MOTIVO: Readonly<Record<string, string>> = {
  "destino-a-escolher": "escolha o destino",
  "url-a-preencher": "preencha o endereço",
  argumentos: "preencha os argumentos",
  tracker: "escolha o tracker",
  canais: "escolha os canais",
  "filtros-de-pessoa": "escolha os filtros de pessoa",
  "dono-do-github": "escolha o dono no GitHub",
  "gatilho-sem-canal": "escolha o canal",
};
export const textoDoMotivo = (motivo: string): string => TEXTO_DO_MOTIVO[motivo] ?? "preencha o campo";

export function descreverPendencia(p: Pendencia): string {
  return `${textoDoMotivo(p.motivo)} (${p.campo})`;
}

/** O passo que não pode rodar por ter campo a preencher: o executor para o run com este erro. */
export class PassoIncompletoError extends Error {
  readonly codigo = "step_incomplete";
  constructor(
    readonly passo: string,
    readonly pendencias: readonly Pendencia[],
  ) {
    super(`nó "${passo}" incompleto: ${pendencias.map(descreverPendencia).join("; ")}`);
    this.name = "PassoIncompletoError";
  }
}

export const pendenciasDoPasso = (spec: { pendentes?: readonly Pendencia[] | undefined }, chave: string): Pendencia[] =>
  (spec.pendentes ?? []).filter((p) => p.onde === chave);

/**
 * Por que estes gatilhos não ligam, ou `null`: o gatilho com campo a preencher
 * (`gatilho:<kind>`) não liga. A pendência de um passo não impede o gatilho, que o
 * run dela diz ao falhar.
 */
export function recusaDeLigar(pendentes: readonly Pendencia[] | undefined, tipos: readonly string[]): string | null {
  const dos = (pendentes ?? []).filter((p) => {
    const kind = kindDoOnde(p.onde);
    return kind !== undefined && tipos.includes(kind);
  });
  if (dos.length === 0) return null;
  return `gatilho incompleto: ${dos.map((p) => `${p.onde}: ${descreverPendencia(p)}`).join("; ")}`;
}

export function valorNoCaminho(objeto: unknown, caminho: string): unknown {
  let no: unknown = objeto;
  for (const parte of caminho.split(".")) {
    if (no === null || typeof no !== "object") return undefined;
    no = (no as Record<string, unknown>)[parte];
  }
  return no;
}

/** Preenchido é ter valor: texto, lista ou objeto vazio ainda é o campo por preencher. */
export function temValor(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/**
 * Tira as pendências que o spec (ou os gatilhos, quando conhecidos) já preenche.
 * Pendência de gatilho sem a lista de gatilhos fica como está: só quem grava os
 * dois juntos sabe se foi preenchida.
 */
export function limparPendenciasPreenchidas<S extends { steps: readonly object[]; pendentes?: Pendencia[] | undefined }>(
  spec: S,
  gatilhos?: readonly object[],
): S {
  if (spec.pendentes === undefined) return spec;
  const restantes = spec.pendentes.filter((p) => {
    const kind = kindDoOnde(p.onde);
    if (kind !== undefined) {
      if (gatilhos === undefined) return true;
      return !gatilhos.some((g) => (g as { kind?: unknown }).kind === kind && temValor(valorNoCaminho(g, p.campo)));
    }
    const passo = spec.steps.find((s) => (s as { key?: unknown }).key === p.onde);
    return passo === undefined ? false : !temValor(valorNoCaminho(passo, p.campo));
  });
  if (restantes.length === spec.pendentes.length) return spec;
  const { pendentes: _antes, ...resto } = spec;
  return (restantes.length === 0 ? resto : { ...resto, pendentes: restantes }) as S;
}
