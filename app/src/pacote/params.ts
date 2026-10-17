import { limparSegredos, limparTexto } from "./limpeza.js";
import type { CodigoOmitido } from "./formato.js";
import type { MapaDeMarcas } from "./marcacao.js";

/**
 * Como cada param de uma ação viaja no pacote. A ação declara (`ActionHandler.paramsDoPacote`)
 * e este módulo aplica a declaração, sem saber de qual ação se trata.
 *
 * - `portavel`: vai como está (emoji, operação, mapa por valor, método).
 * - `texto`: texto escrito por gente; vai pela limpeza de texto, e sai omitido se parece credencial.
 * - `argumentos`: como `texto`, e ainda omite o argumento que o esquema da ferramenta marca como sensível.
 * - `destino`: o destino de uma ação de conversa; `fixo` é local, `evento` e `novo` viajam.
 * - `url`: só esquema e host viajam (`origem`); o resto é a preencher.
 * - `local`: é desta máquina (id de conta, conversa, dono); não viaja e vira pendência. É também o que a ação não declarou.
 *
 * Valor que é só marcador (`{{event.x}}`, `{{steps.x.y}}`) é estrutura do fluxo e viaja em qualquer categoria.
 */
export type ViagemDoParam = "portavel" | "texto" | "argumentos" | "destino" | "url" | "local";
export type ParamsDoPacote = Readonly<Record<string, ViagemDoParam>>;

const MARCADOR = /^\{\{\s*(?:event|steps)\.[\w.-]+\s*\}\}$/;
export const ehMarcador = (v: unknown): boolean => typeof v === "string" && MARCADOR.test(v);

const ehObjeto = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Esquema e host de uma URL, sem caminho, usuário, senha nem consulta: o caminho de um webhook é o segredo dele. */
export function origemDaUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}

export interface OpcoesDosParams {
  home?: string;
  /** Se o argumento de nome `caminho` (a partir de `args`) é sensível pelo esquema da ferramenta. */
  sensivel?: (caminho: string[]) => boolean;
}

export interface ParamsNoPacote {
  /** O que vai no arquivo. */
  params: Record<string, unknown>;
  /** Os nomes do que ficou de fora, com o caminho dentro do param (`args.token`). */
  omitidos: string[];
  /** Quantos trechos a limpeza de texto trocou. */
  limpos: number;
  /** Param `destino` fixo que ficou de fora. */
  destinosFixos: string[];
  /** Param de URL que só viajou como origem (ou nem isso). */
  urls: { param: string; origem?: string }[];
}

/** Dentro de texto, objeto ou lista: limpa o literal e devolve `undefined` quando ele é credencial. */
function limparEmProfundidade(
  valor: unknown,
  caminho: string[],
  ctx: { home: string | undefined; sensivel: OpcoesDosParams["sensivel"]; omitidos: string[]; limpos: { n: number } },
  checarSensivel: boolean,
): unknown {
  if (ehMarcador(valor)) return valor;
  if (typeof valor === "string") {
    if (limparSegredos(valor) !== valor) return undefined;
    const l = limparTexto(valor, ctx.home);
    // Argumento é dado estruturado: com um id ou e-mail trocado por marca ele chegaria errado, então sai.
    if (checarSensivel && l.removidos > 0) return undefined;
    ctx.limpos.n += l.removidos;
    return l.texto;
  }
  if (Array.isArray(valor)) {
    const itens = valor.map((v) => limparEmProfundidade(v, caminho, ctx, checarSensivel));
    return itens.some((v) => v === undefined) ? undefined : itens;
  }
  if (ehObjeto(valor)) {
    const saida: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor)) {
      const aqui = [...caminho, k];
      const nome = aqui.join(".");
      if (checarSensivel && !ehMarcador(v) && ctx.sensivel?.(aqui.slice(1)) === true) {
        ctx.omitidos.push(nome);
        continue;
      }
      const limpo = limparEmProfundidade(v, aqui, ctx, checarSensivel);
      if (limpo === undefined) ctx.omitidos.push(nome);
      else saida[k] = limpo;
    }
    return saida;
  }
  return valor;
}

/** Aplica a declaração aos `params` de um passo, na ida. */
export function paramsParaPacote(declaracao: ParamsDoPacote, params: Record<string, unknown>, opcoes: OpcoesDosParams = {}): ParamsNoPacote {
  const saida: ParamsNoPacote = { params: {}, omitidos: [], limpos: 0, destinosFixos: [], urls: [] };
  const limpos = { n: 0 };
  const ctx = { home: opcoes.home, sensivel: opcoes.sensivel, omitidos: saida.omitidos, limpos };
  for (const [nome, valor] of Object.entries(params)) {
    if (valor === undefined) continue;
    if (ehMarcador(valor)) {
      saida.params[nome] = valor;
      continue;
    }
    const como = declaracao[nome] ?? "local";
    switch (como) {
      case "portavel": {
        // Rede de segurança: o que é declarado portátil não deveria ter credencial, mas quem escreveu pode ter colado uma.
        const texto = JSON.stringify(valor);
        if (limparSegredos(texto) !== texto) saida.omitidos.push(nome);
        else saida.params[nome] = valor;
        break;
      }
      case "texto":
      case "argumentos": {
        const limpo = limparEmProfundidade(valor, [nome], ctx, como === "argumentos");
        if (limpo === undefined) saida.omitidos.push(nome);
        else saida.params[nome] = limpo;
        break;
      }
      case "destino": {
        if (ehObjeto(valor) && valor.tipo === "fixo") {
          saida.omitidos.push(nome);
          saida.destinosFixos.push(nome);
        } else saida.params[nome] = valor;
        break;
      }
      case "url": {
        const origem = typeof valor === "string" ? origemDaUrl(valor.replace(/\{\{[^}]*\}\}/g, "x")) : undefined;
        if (origem !== undefined) saida.params.origem = origem;
        saida.omitidos.push(nome);
        saida.urls.push({ param: nome, ...(origem === undefined ? {} : { origem }) });
        break;
      }
      case "local":
        saida.omitidos.push(nome);
        break;
    }
  }
  saida.limpos = limpos.n;
  return saida;
}

/**
 * Aplica a declaração na volta, a um arquivo que pode ter sido mexido à mão: o que a ação
 * não declara como viajante, ou é destino fixo, nunca entra na automação.
 */
export function paramsDoPacoteParaPasso(declaracao: ParamsDoPacote, params: Record<string, unknown>): { params: Record<string, unknown>; origem?: string; descartados: string[] } {
  const saida: Record<string, unknown> = {};
  const descartados: string[] = [];
  let origem: string | undefined;
  for (const [nome, valor] of Object.entries(params)) {
    if (nome === "origem" && Object.values(declaracao).includes("url")) {
      if (typeof valor === "string") origem = valor;
      continue;
    }
    const como = declaracao[nome] ?? "local";
    if (ehMarcador(valor)) saida[nome] = valor;
    else if (como === "local" || como === "url") descartados.push(nome);
    else if (como === "destino" && ehObjeto(valor) && valor.tipo === "fixo") descartados.push(nome);
    else saida[nome] = valor;
  }
  return { params: saida, ...(origem === undefined ? {} : { origem }), descartados };
}

export interface MarcasAplicadas {
  valor: Record<string, unknown>;
  /** O que ficou de fora, agrupado pelo código que a prévia mostra. */
  omitidos: Map<CodigoOmitido, { quantos: number; nomes: string[] }>;
  limpos: number;
}

/**
 * Aplica um mapa de marcação (`marcacao.ts`) a um objeto de configuração: gatilho,
 * ou qualquer outro esquema marcado. Campo sem marca não viaja e fica dito.
 */
export function aplicarMarcas(marcas: MapaDeMarcas, valor: Record<string, unknown>, opcoes: OpcoesDosParams = {}, prefixo = ""): MarcasAplicadas {
  const saida: MarcasAplicadas = { valor: {}, omitidos: new Map(), limpos: 0 };
  const omitir = (codigo: CodigoOmitido, nome: string, quantos: number): void => {
    const atual = saida.omitidos.get(codigo) ?? { quantos: 0, nomes: [] };
    saida.omitidos.set(codigo, { quantos: atual.quantos + quantos, nomes: [...atual.nomes, nome] });
  };
  const juntar = (filho: MarcasAplicadas): void => {
    for (const [codigo, d] of filho.omitidos) for (const nome of d.nomes) omitir(codigo, nome, d.quantos / d.nomes.length);
    saida.limpos += filho.limpos;
  };
  for (const [campo, v] of Object.entries(valor)) {
    if (v === undefined) continue;
    const nome = `${prefixo}${campo}`;
    const marca = marcas[campo];
    if (marca === undefined) omitir("argumentos", nome, 1);
    else if (marca === "dobrado") continue;
    else if (marca === "portavel") saida.valor[campo] = v;
    else if (marca === "texto") {
      const limpo = limparEmProfundidade(v, [campo], { home: opcoes.home, sensivel: undefined, omitidos: [], limpos: { n: 0 } }, false);
      saida.valor[campo] = limpo ?? v;
    } else if (marca === "argumentos") {
      const r = paramsParaPacote({ [campo]: "argumentos" }, { [campo]: v }, opcoes);
      Object.assign(saida.valor, r.params);
      for (const n of r.omitidos) omitir("argumentos", `${prefixo}${n}`, 1);
      saida.limpos += r.limpos;
    } else if ("local" in marca) {
      const quantos = Array.isArray(v) ? v.length : typeof v === "number" ? v : 1;
      if (quantos > 0) omitir(marca.local, nome, quantos);
    } else if (ehObjeto(v)) {
      const filho = aplicarMarcas(marca.filhos, v, opcoes, `${nome}.`);
      if (Object.keys(filho.valor).length > 0) saida.valor[campo] = filho.valor;
      juntar(filho);
    }
  }
  return saida;
}
