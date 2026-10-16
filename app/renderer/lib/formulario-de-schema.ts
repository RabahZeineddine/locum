/**
 * O formulário de uma ferramenta de conexão, a partir do `inputSchema` (JSON
 * Schema) que o servidor publica. Sem nada de React: gerar os campos, converter
 * o que a pessoa digita e validar o que ficou gravado são funções puras.
 *
 * Cada campo guarda valor fixo ou referência. Referência é o texto
 * `{{event.x}}` ou `{{steps.y.z}}` sozinho: o executor devolve o valor cru
 * dele (número continua número), então vale para qualquer tipo de campo.
 */

export type TipoPrimitivo = "string" | "number" | "integer" | "boolean";
export type TipoDeCampo = TipoPrimitivo | "enum" | "array" | "object" | "json";

export interface Campo {
  nome: string;
  tipo: TipoDeCampo;
  obrigatorio: boolean;
  /** Primeira linha da descrição do servidor, para ajuda curta. */
  descricao?: string;
  /** Valores permitidos de um `enum`. */
  opcoes?: (string | number | boolean)[];
  /** Tipo dos itens de um array de primitivos. */
  itens?: TipoPrimitivo;
  /** Campos de um objeto com propriedades declaradas. */
  campos?: Campo[];
}

type Esquema = {
  type?: unknown;
  properties?: Record<string, unknown>;
  required?: unknown;
  description?: unknown;
  enum?: unknown;
  items?: unknown;
  anyOf?: unknown;
  oneOf?: unknown;
};

const PRIMITIVOS: readonly string[] = ["string", "number", "integer", "boolean"];
/** Objeto dentro de objeto além disto vira um campo JSON: o formulário não vira labirinto. */
const PROFUNDIDADE_MAXIMA = 2;

function esquema(valor: unknown): Esquema | null {
  return valor !== null && typeof valor === "object" && !Array.isArray(valor) ? (valor as Esquema) : null;
}

/** O tipo de um schema, tirando o `null` de `["string","null"]` e de `anyOf: [X, {type: null}]`. */
function tipoDe(s: Esquema): { tipo: string | undefined; base: Esquema } {
  if (Array.isArray(s.type)) {
    const reais = s.type.filter((t) => t !== "null");
    return { tipo: reais.length === 1 ? String(reais[0]) : undefined, base: s };
  }
  if (typeof s.type === "string") return { tipo: s.type, base: s };
  const alternativas = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null;
  if (alternativas !== null) {
    const reais = alternativas.map(esquema).filter((a) => a !== null && a.type !== "null");
    if (reais.length === 1 && alternativas.length === 2) return tipoDe({ ...reais[0]!, description: reais[0]!.description ?? s.description });
  }
  return { tipo: undefined, base: s };
}

function primeiraLinha(texto: unknown): string | undefined {
  if (typeof texto !== "string") return undefined;
  const linha = texto.trim().split("\n")[0]?.trim();
  return linha === undefined || linha === "" ? undefined : linha;
}

function campoDe(nome: string, valor: unknown, obrigatorio: boolean, profundidade: number): Campo {
  const s = esquema(valor);
  const comum = { nome, obrigatorio, ...(primeiraLinha(s?.description) === undefined ? {} : { descricao: primeiraLinha(s?.description)! }) };
  if (s === null) return { ...comum, tipo: "json" };
  const { tipo, base } = tipoDe(s);
  if (Array.isArray(base.enum) && base.enum.length > 0 && base.enum.every((o) => ["string", "number", "boolean"].includes(typeof o))) {
    return { ...comum, tipo: "enum", opcoes: base.enum as (string | number | boolean)[] };
  }
  if (tipo !== undefined && PRIMITIVOS.includes(tipo)) return { ...comum, tipo: tipo as TipoPrimitivo };
  if (tipo === "array") {
    const item = esquema(base.items);
    const tipoItem = item === null ? undefined : tipoDe(item).tipo;
    if (tipoItem !== undefined && PRIMITIVOS.includes(tipoItem) && item!.enum === undefined) return { ...comum, tipo: "array", itens: tipoItem as TipoPrimitivo };
    return { ...comum, tipo: "json" };
  }
  if (tipo === "object" && profundidade < PROFUNDIDADE_MAXIMA) {
    const filhos = camposDoSchema(base, profundidade + 1);
    if (filhos.length > 0) return { ...comum, tipo: "object", campos: filhos };
  }
  return { ...comum, tipo: "json" };
}

/** Os campos do formulário, na ordem das propriedades. Schema ausente ou sem propriedades: nenhum. */
export function camposDoSchema(schema: unknown, profundidade = 0): Campo[] {
  const s = esquema(schema);
  const props = s?.properties;
  if (props === undefined || props === null || typeof props !== "object") return [];
  const obrigatorios = new Set(Array.isArray(s!.required) ? (s!.required as unknown[]).filter((r): r is string => typeof r === "string") : []);
  return Object.entries(props).map(([nome, valor]) => campoDe(nome, valor, obrigatorios.has(nome), profundidade));
}

const REFERENCIA = /^\{\{\s*([\w.-]+)\s*\}\}$/;

/** Marcador sozinho: o mesmo critério do executor para devolver o valor cru. */
export function ehReferencia(valor: unknown): valor is string {
  return typeof valor === "string" && REFERENCIA.test(valor);
}

function primitivoDoTexto(texto: string, tipo: TipoPrimitivo): unknown {
  const t = texto.trim();
  if (tipo === "string") return texto;
  if (tipo === "boolean") return t === "true" ? true : t === "false" ? false : texto;
  const n = Number(t);
  return t !== "" && Number.isFinite(n) ? n : texto;
}

/**
 * O que a pessoa digitou, no tipo do campo. Vazio tira o campo (`undefined`).
 * Referência fica como texto. Texto que não é do tipo fica como está: a
 * validação acusa, em vez de o formulário engolir o que foi digitado.
 */
export function valorDoTexto(texto: string, campo: Pick<Campo, "tipo" | "itens">): unknown {
  if (texto.trim() === "") return undefined;
  if (ehReferencia(texto.trim())) return texto.trim();
  switch (campo.tipo) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
      return primitivoDoTexto(texto, campo.tipo);
    case "array": {
      const partes = texto.split(/[\n,]/).map((p) => p.trim()).filter((p) => p !== "");
      return partes.map((p) => primitivoDoTexto(p, campo.itens ?? "string"));
    }
    default:
      return texto;
  }
}

/** Grava (ou, com `undefined`, tira) um valor no caminho, sem mutar, podando o objeto que esvaziou. */
export function definirNoCaminho(args: Record<string, unknown>, caminho: readonly string[], valor: unknown): Record<string, unknown> {
  const [primeiro, ...resto] = caminho;
  if (primeiro === undefined) return args;
  const { [primeiro]: atual, ...outros } = args;
  if (resto.length === 0) return valor === undefined ? outros : { ...outros, [primeiro]: valor };
  const filho = definirNoCaminho(esquemaPlano(atual), resto, valor);
  return Object.keys(filho).length === 0 ? outros : { ...outros, [primeiro]: filho };
}

function esquemaPlano(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export interface ErroDeArgs {
  /** `body.reactionType`. */
  caminho: string;
  motivo: "obrigatorio" | "tipo";
}

function vazio(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
}

function primitivoCombina(v: unknown, tipo: TipoPrimitivo): boolean {
  if (tipo === "string") return typeof v === "string";
  if (tipo === "boolean") return typeof v === "boolean";
  if (tipo === "integer") return typeof v === "number" && Number.isInteger(v);
  return typeof v === "number" && Number.isFinite(v);
}

function tipoCombina(v: unknown, c: Campo): boolean {
  switch (c.tipo) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
      return primitivoCombina(v, c.tipo);
    case "enum":
      return (c.opcoes ?? []).includes(v as never);
    case "array":
      return Array.isArray(v) && v.every((x) => ehReferencia(x) || primitivoCombina(x, c.itens ?? "string"));
    case "object":
      return v !== null && typeof v === "object" && !Array.isArray(v);
    default:
      return true;
  }
}

/**
 * O que está errado nos argumentos gravados: obrigatório vazio e valor fixo de
 * tipo errado. Referência passa em qualquer tipo (só se sabe o valor na hora de
 * rodar); texto com marcador no meio, num campo que não é texto, não passa.
 */
export function validarArgs(campos: readonly Campo[], args: Record<string, unknown>, prefixo = ""): ErroDeArgs[] {
  const erros: ErroDeArgs[] = [];
  for (const c of campos) {
    const caminho = `${prefixo}${c.nome}`;
    const v = args[c.nome];
    if (vazio(v)) {
      if (c.obrigatorio) erros.push({ caminho, motivo: "obrigatorio" });
      continue;
    }
    if (ehReferencia(v)) continue;
    if (!tipoCombina(v, c)) {
      erros.push({ caminho, motivo: "tipo" });
      continue;
    }
    if (c.tipo === "object" && c.campos !== undefined) erros.push(...validarArgs(c.campos, v as Record<string, unknown>, `${caminho}.`));
  }
  return erros;
}

/** Os caminhos `event.x` e `steps.y.z` citados em qualquer valor dos argumentos. */
export function referenciasDoArgs(valor: unknown): string[] {
  if (typeof valor === "string") return [...valor.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1]!);
  if (Array.isArray(valor)) return valor.flatMap(referenciasDoArgs);
  if (valor !== null && typeof valor === "object") return Object.values(valor).flatMap(referenciasDoArgs);
  return [];
}
