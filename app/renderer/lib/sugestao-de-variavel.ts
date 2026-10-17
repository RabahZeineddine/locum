/**
 * A lógica do autocomplete de `{{...}}`, sem React: onde há um marcador aberto,
 * o que sugerir para o que foi digitado e como inserir no texto. O componente
 * só liga isto ao teclado e ao mouse.
 */
import type { GrupoDeReferencias, Referencia } from "../../src/config/referencias";

export interface MarcadorAberto {
  /** Onde o `{{` começa. */
  inicio: number;
  /** O que veio depois dele até o cursor, sem espaço nas pontas. */
  consulta: string;
}

/** O que o executor aceita num caminho, mais espaço: `{{ steps.x }}` também vale. */
const DIGITADO = /^[\w.\- ]*$/;

/** Há um `{{` aberto logo antes do cursor? Fechado, com quebra de linha ou com caractere que não é de caminho, não. */
export function marcadorAberto(texto: string, cursor: number): MarcadorAberto | null {
  const antes = texto.slice(0, cursor);
  const inicio = antes.lastIndexOf("{{");
  if (inicio < 0) return null;
  const digitado = antes.slice(inicio + 2);
  if (!DIGITADO.test(digitado)) return null;
  return { inicio, consulta: digitado.trim() };
}

/** Quanto mais perto do começo, melhor: 0 é caminho inteiro, 1 começo de trecho, 2 contido, 3 só no nome ou na descrição. */
function pontuar(item: Referencia, grupo: GrupoDeReferencias, consulta: string): number | null {
  const q = consulta.toLowerCase();
  const caminho = item.caminho.toLowerCase();
  if (caminho.startsWith(q)) return 0;
  if (caminho.split(".").some((trecho) => trecho.startsWith(q))) return 1;
  if (caminho.includes(q)) return 2;
  const nome = `${grupo.numero ?? ""} ${grupo.nome ?? ""}`.toLowerCase();
  if (nome.includes(q) || (item.descricao ?? "").toLowerCase().includes(q)) return 3;
  return null;
}

/**
 * Os grupos reduzidos ao que a consulta acha, na ordem em que vieram (evento,
 * depois os passos na ordem do fluxo). Dentro do grupo, o melhor acerto sobe e
 * o empate fica na ordem do catálogo. Grupo sem acerto some.
 */
export function filtrarSugestoes(grupos: readonly GrupoDeReferencias[], consulta: string): GrupoDeReferencias[] {
  if (consulta === "") return [...grupos];
  const saida: GrupoDeReferencias[] = [];
  for (const grupo of grupos) {
    const itens = grupo.itens
      .map((item, ordem) => ({ item, ordem, nota: pontuar(item, grupo, consulta) }))
      .filter((x): x is { item: Referencia; ordem: number; nota: number } => x.nota !== null)
      .sort((a, b) => a.nota - b.nota || a.ordem - b.ordem)
      .map((x) => x.item);
    if (itens.length > 0) saida.push({ ...grupo, itens });
  }
  return saida;
}

/** O que sobra do marcador depois do cursor: o resto da palavra e as chaves de fechar, para não duplicar. */
const RESTO_DO_MARCADOR = /^[\w.-]*(?:\s*\}\})?/;

/**
 * Troca o marcador aberto por `{{caminho}}` e põe o cursor depois dele. O
 * caminho leva a chave do passo, nunca o número, que muda com o fluxo.
 */
export function inserirSugestao(texto: string, cursor: number, caminho: string): { texto: string; cursor: number } | null {
  const aberto = marcadorAberto(texto, cursor);
  if (aberto === null) return null;
  const resto = RESTO_DO_MARCADOR.exec(texto.slice(cursor))![0];
  const marcador = `{{${caminho}}}`;
  return { texto: texto.slice(0, aberto.inicio) + marcador + texto.slice(cursor + resto.length), cursor: aberto.inicio + marcador.length };
}
