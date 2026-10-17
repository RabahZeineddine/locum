import { topoSort, type Step } from "./types.js";

/**
 * O que um campo de texto do fluxo pode citar com `{{...}}`, sem React e sem
 * Node: a tela e o MCP leem o mesmo catálogo.
 *
 * Toda fonte de dado (evento de gatilho, saída de passo) entra como JSON Schema.
 * Um só caminho de código transforma esquema em caminhos, e só oferece os que o
 * executor resolve (`renderPrompt` aceita `[\w.-]+`, e lista desce por índice:
 * `findings.0.severity`).
 */

export type EsquemaJson = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, EsquemaJson>;
  items?: EsquemaJson;
  anyOf?: EsquemaJson[];
  oneOf?: EsquemaJson[];
  enum?: unknown[];
  [k: string]: unknown;
};

export interface Referencia {
  /** O caminho sem as chaves: `event.title`, `steps.revisar.findings.0.severity`. */
  caminho: string;
  tipo: string;
  descricao?: string;
  /**
   * De quais gatilhos vem o campo, quando o fluxo tem mais de um com evento
   * (só no grupo do evento). Ausente: um gatilho só, ou campo de passo.
   */
  fontes?: string[];
  /** Quando o campo existe, se não é sempre: o catálogo o põe no fim do grupo (`publicado-a-mao`). */
  condicao?: string;
  /** `esquema` vem do que a fonte declara; `ultimo-run` do que o último run gravou e o esquema não conhece. */
  origem: "esquema" | "ultimo-run";
}

/** Níveis de propriedade que o catálogo desce: `dono` e `dono.nome`, não `dono.dados.fundo`. */
const NIVEIS = 2;
/** Um trecho de caminho que `renderPrompt` resolve: o regex dele é `[\w.-]+`, e o ponto separa. */
const NOME_QUE_O_EXECUTOR_ACEITA = /^[\w-]+$/;
export const nomeCitavel = (nome: string): boolean => NOME_QUE_O_EXECUTOR_ACEITA.test(nome);

const SEM_NULO = (v: EsquemaJson) => v.type !== "null";

/** `anyOf`/`oneOf` viram um esquema só: as propriedades de todas as variantes, sem a variante nula. */
function achatar(esquema: EsquemaJson): EsquemaJson {
  const variantes = [...(esquema.anyOf ?? []), ...(esquema.oneOf ?? [])].filter(SEM_NULO);
  if (variantes.length === 0) return esquema;
  const achatadas = variantes.map(achatar);
  const properties = Object.assign({}, ...achatadas.map((v) => v.properties ?? {}), esquema.properties ?? {}) as Record<string, EsquemaJson>;
  const items = esquema.items ?? achatadas.find((v) => v.items !== undefined)?.items;
  const tipos = [...new Set(achatadas.flatMap((v) => (Array.isArray(v.type) ? v.type : v.type === undefined ? [] : [v.type])))];
  return {
    ...esquema,
    ...(tipos.length === 0 ? {} : { type: tipos.length === 1 ? tipos[0]! : tipos }),
    ...(Object.keys(properties).length === 0 ? {} : { properties }),
    ...(items === undefined ? {} : { items }),
  };
}

/** Campo que só pode ser nulo não tem o que citar. */
function soNulo(esquema: EsquemaJson): boolean {
  const e = achatar(esquema);
  return e.type === "null" || (Array.isArray(e.type) && e.type.length > 0 && e.type.every((t) => t === "null"));
}

function rotuloDoTipo(esquema: EsquemaJson): string {
  const e = achatar(esquema);
  const tipos = (Array.isArray(e.type) ? e.type : e.type === undefined ? [] : [e.type]).filter((t) => t !== "null");
  if (tipos.length > 0) return tipos.join(" | ");
  if (e.properties !== undefined) return "object";
  if (e.items !== undefined) return "array";
  return "any";
}

/**
 * Os caminhos que o esquema declara, relativos à raiz dele. Objeto desce até
 * `NIVEIS` níveis, e lista entra pelo primeiro item (`0`), que não conta como nível.
 */
export function referenciasDoEsquema(esquema: EsquemaJson, prefixo = "", nivel = 0): Referencia[] {
  const e = achatar(esquema);
  const out: Referencia[] = [];
  const juntar = (nome: string) => (prefixo === "" ? nome : `${prefixo}.${nome}`);
  if (e.properties !== undefined && nivel < NIVEIS) {
    for (const [nome, filho] of Object.entries(e.properties)) {
      if (!nomeCitavel(nome) || soNulo(filho)) continue;
      const caminho = juntar(nome);
      out.push({ caminho, tipo: rotuloDoTipo(filho), ...(typeof filho["x-condicao"] === "string" ? { condicao: filho["x-condicao"] } : {}), ...(filho.description === undefined ? {} : { descricao: filho.description }), origem: "esquema" });
      out.push(...referenciasDoEsquema(filho, caminho, nivel + 1));
    }
  }
  if (e.items !== undefined) {
    const caminho = juntar("0");
    out.push({ caminho, tipo: rotuloDoTipo(e.items), ...(e.items.description === undefined ? {} : { descricao: e.items.description }), origem: "esquema" });
    out.push(...referenciasDoEsquema(e.items, caminho, nivel));
  }
  return out;
}

/**
 * Os caminhos que dá para citar numa saída já gravada: cada campo, o primeiro
 * item de cada lista e os objetos aninhados até a terceira camada.
 */
export function caminhosDaSaida(valor: unknown, prefixo = "", profundidade = 0): string[] {
  if (valor === null || typeof valor !== "object" || profundidade >= 3) return [];
  const entradas = Array.isArray(valor) ? valor.slice(0, 1).map((v, i) => [String(i), v] as const) : Object.entries(valor);
  return entradas.flatMap(([nome, v]) => {
    if (!nomeCitavel(nome)) return [];
    const caminho = prefixo === "" ? nome : `${prefixo}.${nome}`;
    return [caminho, ...caminhosDaSaida(v, caminho, profundidade + 1)];
  });
}

/** A saída mais recente de cada passo, dos runs do mais novo para o mais velho. Ensaio e saída vazia não contam. */
export function saidasDosRuns(runs: readonly { steps: readonly { stepKey: string; output: unknown }[] }[]): Record<string, unknown> {
  const saidas: Record<string, unknown> = {};
  for (const run of runs) {
    for (const p of run.steps) {
      const o = p.output;
      if (o === null || o === undefined || p.stepKey in saidas) continue;
      if (typeof o === "object" && (o as { state?: unknown }).state === "ensaio") continue;
      saidas[p.stepKey] = o;
    }
  }
  return saidas;
}

/**
 * O número de cada passo no fluxo, de 1 em diante. Ordem topológica pelo
 * `needs`, com desempate pela ordem no spec; gatilho não conta. O número muda
 * quando o fluxo muda: serve para a pessoa se situar, nunca para citar (o
 * marcador usa a chave).
 */
export function numerarPassos(steps: readonly Step[]): Map<string, number> {
  let ordem: readonly { key: string }[];
  try {
    ordem = topoSort([...steps]);
  } catch {
    ordem = steps; // fluxo com ciclo ou dependência solta: a ordem do spec ainda serve de rótulo
  }
  return new Map(ordem.map((p, i) => [p.key, i + 1]));
}

/** Todo passo de que `chave` depende, direta ou indiretamente. */
export function passosAnteriores(steps: readonly Step[], chave: string): Step[] {
  const porChave = new Map(steps.map((p) => [p.key, p]));
  const vistos = new Set<string>();
  const visitar = (k: string): void => {
    for (const n of porChave.get(k)?.needs ?? []) {
      if (vistos.has(n)) continue;
      vistos.add(n);
      visitar(n);
    }
  };
  visitar(chave);
  const numeros = numerarPassos(steps);
  return steps.filter((p) => vistos.has(p.key)).sort((a, b) => (numeros.get(a.key) ?? 0) - (numeros.get(b.key) ?? 0));
}

/** De onde vem o esquema da saída de um passo, fora o que o próprio passo declara. */
export interface FontesDeEsquema {
  /** Esquema da saída de cada ação, pelo registro de ações (`actions.describe`). */
  acao?: (kind: string) => EsquemaJson | undefined;
  /** `outputSchema` da ferramenta de conexão, por servidor e ferramenta. */
  ferramenta?: (server: string, tool: string) => EsquemaJson | undefined;
  /** Esquema da saída de uma operação de lógica. */
  logica?: (op: string) => EsquemaJson | undefined;
}

/** O esquema da saída de um passo, ou `undefined` quando nada declara o formato. */
export function esquemaDaSaida(passo: Step, fontes: FontesDeEsquema): EsquemaJson | undefined {
  if (passo.type === "model") return (passo.outputSchema as EsquemaJson | undefined) ?? { type: "string" };
  if (passo.type === "logic") return fontes.logica?.(passo.op);
  const params = (passo.params ?? {}) as { server?: unknown; tool?: unknown };
  const daAcao = fontes.acao?.(passo.action);
  if (typeof params.server === "string" && typeof params.tool === "string") {
    // Dado por publicado à mão, o passo guarda só o estado: os campos da ferramenta podem faltar.
    const base = fontes.ferramenta?.(params.server, params.tool) ?? daAcao ?? {};
    return { ...base, properties: { ...SAIDA_DE_PASSO_PUBLICADO_A_MAO, ...(base.properties ?? {}) } };
  }
  return daAcao;
}

const SAIDA_DE_PASSO_PUBLICADO_A_MAO: Record<string, EsquemaJson> = {
  state: { type: "string", "x-condicao": "publicado-a-mao", description: "Only when the step was marked as published by hand: the tool's fields are then missing." },
  semResposta: { type: "boolean", "x-condicao": "publicado-a-mao", description: "True when the step was marked as published by hand, with no tool response." },
};

export interface GrupoDeReferencias {
  /** `event` ou a chave do passo. */
  id: string;
  tipo: "event" | "step";
  /** Só no passo. */
  numero?: number;
  nome?: string;
  /** O primeiro item é o grupo inteiro (`event` ou `steps.chave`), e os outros descem dele. */
  itens: Referencia[];
}

export interface EntradaDoCatalogo {
  passos: readonly Step[];
  /** O passo em edição: só os anteriores a ele entram. */
  chave: string;
  /** O esquema do evento de cada gatilho do fluxo, na ordem deles, com o tipo do gatilho. */
  eventos: readonly { fonte: string; esquema: EsquemaJson | null | undefined }[];
  fontes?: FontesDeEsquema;
  /** A saída de cada passo no último run, pela chave do passo. */
  saidas?: Readonly<Record<string, unknown>>;
}

function grupo(raiz: string, esquemas: readonly EsquemaJson[], observada: unknown): Referencia[] {
  const itens = new Map<string, Referencia>();
  for (const esquema of esquemas) {
    for (const r of referenciasDoEsquema(esquema)) {
      const caminho = `${raiz}.${r.caminho}`;
      if (!itens.has(caminho)) itens.set(caminho, { ...r, caminho });
    }
  }
  for (const sub of caminhosDaSaida(observada)) {
    const caminho = `${raiz}.${sub}`;
    if (!itens.has(caminho)) itens.set(caminho, { caminho, tipo: "any", origem: "ultimo-run" });
  }
  // O que só existe em certos casos vai para o fim do grupo, depois dos campos de sempre.
  return [...itens.values()].sort((a, b) => Number(a.condicao !== undefined) - Number(b.condicao !== undefined));
}

/** O catálogo do que o passo `chave` pode citar: o evento e, na ordem do fluxo, cada passo anterior. */
export function catalogoDeReferencias(entrada: EntradaDoCatalogo): GrupoDeReferencias[] {
  const grupos: GrupoDeReferencias[] = [];
  const comEvento = entrada.eventos.filter((e): e is { fonte: string; esquema: EsquemaJson } => e.esquema !== null && e.esquema !== undefined);
  if (comEvento.length > 0) {
    const fontes = [...new Set(comEvento.map((e) => e.fonte))];
    const varias = fontes.length > 1;
    const porCaminho = new Map<string, Referencia>();
    for (const e of comEvento) {
      for (const r of grupo("event", [e.esquema], undefined)) {
        const ja = porCaminho.get(r.caminho);
        if (ja === undefined) porCaminho.set(r.caminho, varias ? { ...r, fontes: [e.fonte] } : r);
        else if (varias && !ja.fontes!.includes(e.fonte)) ja.fontes!.push(e.fonte);
      }
    }
    const raiz: Referencia = { caminho: "event", tipo: "object", origem: "esquema", ...(varias ? { fontes } : {}) };
    grupos.push({ id: "event", tipo: "event", itens: [raiz, ...porCaminho.values()] });
  }
  const numeros = numerarPassos(entrada.passos);
  for (const passo of passosAnteriores(entrada.passos, entrada.chave)) {
    if (!nomeCitavel(passo.key)) continue; // `{{steps.revisar pr}}` o executor não resolve: o passo fica fora da lista
    const esquema = esquemaDaSaida(passo, entrada.fontes ?? {});
    const raiz = `steps.${passo.key}`;
    grupos.push({
      id: passo.key,
      tipo: "step",
      numero: numeros.get(passo.key) ?? 0,
      nome: passo.name,
      itens: [
        { caminho: raiz, tipo: esquema === undefined ? "any" : rotuloDoTipo(esquema), origem: "esquema" },
        ...grupo(raiz, esquema === undefined ? [] : [esquema], entrada.saidas?.[passo.key]),
      ],
    });
  }
  return grupos;
}
