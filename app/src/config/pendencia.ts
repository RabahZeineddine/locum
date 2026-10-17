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
 * - `onde`: a chave do passo, ou `gatilho:<id>` para um gatilho (o id do cadastro: dois gatilhos do mesmo tipo têm pendências separadas).
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
export const ondeDoGatilho = (id: string): string => `${PREFIXO_DO_GATILHO}${id}`;
export const idDoGatilhoNoOnde = (onde: string): string | undefined => (onde.startsWith(PREFIXO_DO_GATILHO) ? onde.slice(PREFIXO_DO_GATILHO.length) : undefined);

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
  "skill-ausente": "instale a skill ou dispense o aviso",
  "passo-a-revisar": "revise o nó e dispense o aviso",
};
/**
 * Como cada motivo se resolve. O padrão é `valor`: o campo ganha valor. `existe`: o
 * recurso que o campo nomeia passa a existir nesta máquina (a skill). `dispensa`: não há
 * campo a conferir (o passo inteiro está por revisar) e só a pessoa dispensando resolve.
 */
export type Resolucao = "valor" | "existe" | "dispensa";
const RESOLUCAO_DO_MOTIVO: Readonly<Record<string, Resolucao>> = { "skill-ausente": "existe", "passo-a-revisar": "dispensa" };
export const resolucaoDoMotivo = (motivo: string): Resolucao => RESOLUCAO_DO_MOTIVO[motivo] ?? "valor";

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
 * (`gatilho:<id>`) não liga. A pendência de um passo não impede o gatilho, que o
 * run dela diz ao falhar. Gatilho que o pacote não chegou a criar não tem id
 * cadastrado: a pendência dele fica à vista, sem travar os outros.
 */
export function recusaDeLigar(pendentes: readonly Pendencia[] | undefined, idsDosGatilhos: readonly string[]): string | null {
  const dos = (pendentes ?? []).filter((p) => {
    const id = idDoGatilhoNoOnde(p.onde);
    return id !== undefined && idsDosGatilhos.includes(id);
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

/** Um gatilho como a gravação o conhece: o id (do cadastro, ou o já escolhido para o que nasce agora) e a configuração. */
export interface GatilhoIdentificado {
  id?: string | undefined;
  config: object;
}

export interface OpcoesDaLimpeza {
  /** Os gatilhos como a gravação os conhece. Sem a lista, a pendência de gatilho fica como está. */
  gatilhos?: readonly GatilhoIdentificado[];
  /** Os gatilhos que saíram da lista: a pendência deles some junto. */
  removidos?: ReadonlySet<string>;
  /** Se o recurso que a pendência nomeia existe aqui (motivo de resolução `existe`). Sem isto a pendência fica. */
  existe?: (p: Pendencia) => boolean;
}

/** A pendência já foi resolvida pelo critério do motivo dela. */
function resolvida(p: Pendencia, valorDe: () => unknown, existe: OpcoesDaLimpeza["existe"]): boolean {
  switch (resolucaoDoMotivo(p.motivo)) {
    case "dispensa":
      return false;
    case "existe":
      return existe?.(p) === true;
    case "valor":
      return temValor(valorDe());
  }
}

/**
 * Tira as pendências que o spec (ou os gatilhos, quando conhecidos) já resolve, cada uma
 * pelo critério do motivo dela. Pendência de gatilho sem a lista de gatilhos fica como
 * está: só quem grava os dois juntos sabe se foi preenchida. Com a lista, a do gatilho que
 * saiu dela (`removidos`) some junto; a do que nunca foi cadastrado fica até a pessoa dispensar.
 */
export function limparPendenciasPreenchidas<S extends { steps: readonly object[]; pendentes?: Pendencia[] | undefined }>(spec: S, opcoes: OpcoesDaLimpeza = {}): S {
  if (spec.pendentes === undefined) return spec;
  const { gatilhos, removidos = new Set<string>(), existe } = opcoes;
  const restantes = spec.pendentes.filter((p) => {
    const id = idDoGatilhoNoOnde(p.onde);
    if (id !== undefined) {
      if (gatilhos === undefined) return true;
      const gatilho = gatilhos.find((g) => g.id === id);
      return gatilho === undefined ? !removidos.has(id) : !resolvida(p, () => valorNoCaminho(gatilho.config, p.campo), existe);
    }
    const passo = spec.steps.find((s) => (s as { key?: unknown }).key === p.onde);
    return passo === undefined ? false : !resolvida(p, () => valorNoCaminho(passo, p.campo), existe);
  });
  if (restantes.length === spec.pendentes.length) return spec;
  const { pendentes: _antes, ...resto } = spec;
  return (restantes.length === 0 ? resto : { ...resto, pendentes: restantes }) as S;
}
