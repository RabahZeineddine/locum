/**
 * O que a paleta usa de cada ferramenta de servidor MCP, sem React: o nome
 * humanizado, a busca e o passo `mcp.call` pronto. Nada aqui é fixo por app: conexão nova ou ferramenta nova entra pela
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

/** Minúsculas com hífen no lugar de tudo que não é letra ou dígito: serve de chave de passo, que `{{steps.<chave>}}` precisa casar. */
export function slug(texto: string): string {
  return texto.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Se o termo aparece em algum dos textos, sem acento nem caixa. Termo vazio casa tudo. */
export function casaBusca(busca: string, ...textos: (string | undefined)[]): boolean {
  const termo = normalizar(busca.trim());
  return termo === "" || textos.some((t) => t !== undefined && normalizar(t).includes(termo));
}

/**
 * O passo `mcp.call` de uma ferramenta, com servidor e ferramenta preenchidos.
 * Escrita nasce em aprovação, como todo efeito fora da máquina; leitura nasce
 * automática, porque não escreve em lugar nenhum.
 */
export function passoDeFerramenta(spec: AgentSpec, servidor: string, ferramenta: FerramentaClassificavel): Step {
  const base = slug(humanizar(ferramenta.name)) || "acao-em-app";
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

/**
 * O modo do passo depois de trocar a ferramenta. Escrita só fica em automático
 * quando o nó traz `autoEscrita`, escolhido à mão; senão volta para aprovação.
 * Sem saber o que a ferramenta é, também não fica em automático.
 */
export function modoParaFerramenta(
  modoAtual: "approve" | "draft" | "auto",
  autoEscrita: boolean,
  ferramenta: FerramentaClassificavel | undefined,
): "approve" | "draft" | "auto" {
  if (modoAtual !== "auto" || autoEscrita) return modoAtual;
  return ferramenta !== undefined && ehLeituraNaAcao(ferramenta) ? "auto" : "approve";
}
