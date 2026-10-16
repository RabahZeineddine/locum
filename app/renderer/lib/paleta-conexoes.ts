/**
 * A paleta por conexão, sem React: cada servidor MCP ligado vira uma seção com
 * as ferramentas que ele publica, e cada ferramenta vira um passo `mcp.call`
 * pronto. Nada aqui é fixo por app: conexão nova ou ferramenta nova entra pela
 * lista do servidor.
 */
import { ehLeituraNaAcao, type FerramentaClassificavel } from "../../src/config/leitura";
import type { AgentSpec, Step } from "../../src/config/types";
import { novaChave } from "./automacao";
import { normalizar } from "./paleta";

export interface FerramentaDaConexao extends FerramentaClassificavel {
  description?: string;
  /** JSON Schema dos argumentos, quando o servidor publicou. */
  inputSchema?: Record<string, unknown>;
  /** JSON Schema da resposta estruturada, quando o servidor declarou. */
  outputSchema?: Record<string, unknown>;
}

export interface ConexaoParaPaleta {
  servidor: string;
  /** Nula quando a lista nunca foi lida: a seção pede para carregar. */
  ferramentas: readonly FerramentaDaConexao[] | null;
}

export interface ItemDaPaleta {
  servidor: string;
  nome: string;
  titulo: string;
  descricao: string;
  /** Só lê, pelo mesmo critério do executor. Sem anotação do servidor conta como escrita. */
  leitura: boolean;
  /** O motivo de a ferramenta não poder virar passo, ou nulo. */
  desligada: string | null;
}

export interface SecaoDaPaleta {
  servidor: string;
  itens: ItemDaPaleta[];
  /** A lista de ferramentas ainda não foi lida deste servidor. */
  semLista: boolean;
}

/** `add_reaction` vira "Add reaction"; o prefixo `mcp__servidor__` cai. */
export function humanizar(nome: string): string {
  const limpo = nome
    .replace(/^mcp__.+?__/, "")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return limpo === "" ? nome : limpo.charAt(0).toUpperCase() + limpo.slice(1);
}

/** Se o termo aparece em algum dos textos, sem acento nem caixa. Termo vazio casa tudo. */
export function casaBusca(busca: string, ...textos: (string | undefined)[]): boolean {
  const termo = normalizar(busca.trim());
  return termo === "" || textos.some((t) => t !== undefined && normalizar(t).includes(termo));
}

export function secoesDaPaleta(
  conexoes: readonly ConexaoParaPaleta[],
  opcoes: { busca?: string; desligada?: (servidor: string, ferramenta: string) => string | null },
): SecaoDaPaleta[] {
  const busca = opcoes.busca ?? "";
  const buscando = busca.trim() !== "";
  const secoes: SecaoDaPaleta[] = [];
  for (const c of conexoes) {
    const doServidor = casaBusca(busca, c.servidor);
    const itens = (c.ferramentas ?? [])
      .map<ItemDaPaleta>((f) => ({
        servidor: c.servidor,
        nome: f.name,
        titulo: humanizar(f.name),
        descricao: f.description ?? "",
        leitura: ehLeituraNaAcao(f),
        desligada: opcoes.desligada?.(c.servidor, f.name) ?? null,
      }))
      .filter((i) => doServidor || casaBusca(busca, i.nome, i.titulo, i.descricao));
    const semLista = c.ferramentas === null;
    // Na busca, a seção só fica se casou o servidor ou alguma ferramenta.
    if (buscando && itens.length === 0 && !(semLista && doServidor)) continue;
    secoes.push({ servidor: c.servidor, itens, semLista });
  }
  return secoes;
}

/**
 * O passo `mcp.call` de uma ferramenta, com servidor e ferramenta preenchidos.
 * Escrita nasce em aprovação, como todo efeito fora da máquina; leitura nasce
 * automática, porque não escreve em lugar nenhum.
 */
export function passoDeFerramenta(spec: AgentSpec, servidor: string, ferramenta: FerramentaClassificavel): Step {
  const base = humanizar(ferramenta.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "acao-em-app";
  return {
    type: "action",
    key: novaChave(spec, base),
    name: humanizar(ferramenta.name),
    needs: [],
    optional: false,
    action: "mcp.call",
    mode: ehLeituraNaAcao(ferramenta) ? "auto" : "approve",
    params: { server: servidor, tool: ferramenta.name, args: {} },
  };
}
