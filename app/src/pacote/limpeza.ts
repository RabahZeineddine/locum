import { homedir } from "node:os";

/**
 * Limpeza de texto livre antes de ele entrar num pacote.
 *
 * O pacote sai da máquina de quem exporta, e prompt, instrução e contexto são
 * texto que a pessoa escreveu: nada garante que não haja um token colado, um
 * e-mail ou um caminho do home. O que o formato não carrega por construção
 * (segredo do cofre, cursor, histórico) nem passa por aqui; isto é a segunda
 * rede, para o que alguém digitou dentro do texto.
 */

export interface Limpeza {
  texto: string;
  removidos: number;
}

const SEGREDO = "[segredo removido]";

const PADROES: readonly [RegExp, string][] = [
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, SEGREDO],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, SEGREDO],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, SEGREDO],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, SEGREDO],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, SEGREDO],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, SEGREDO],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, `Bearer ${SEGREDO}`],
  // Chat e canal do Teams (`19:...@thread.v2`), e os GUIDs de equipe, canal e tenant.
  [/\b19:[A-Za-z0-9_-]+@thread\.[A-Za-z0-9]+\b/g, "[chat removido]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id removido]"],
  // Canal, grupo e DM do Slack: a letra do tipo e maiúsculas e dígitos, com ao menos um dígito.
  [/\b[CGDW](?=[A-Z0-9]*\d)[A-Z0-9]{8,}\b/g, "[id removido]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[e-mail removido]"],
  [/\/(?:Users|home)\/[^/\s"']+/g, "~"],
];

function escapar(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function limparTexto(texto: string, home: string = homedir()): Limpeza {
  let saida = texto;
  let removidos = 0;
  const trocar = (padrao: RegExp, por: string): void => {
    saida = saida.replace(padrao, () => {
      removidos += 1;
      return por;
    });
  };
  // O home da máquina vem primeiro: o caminho inteiro, e não só o usuário.
  if (home.length > 1) trocar(new RegExp(escapar(home), "g"), "~");
  for (const [padrao, por] of PADROES) trocar(padrao, por);
  return { texto: saida, removidos };
}

/** Limpa toda string de um valor JSON, em profundidade, sem mexer nas chaves. */
export function limparValor<T>(valor: T, home?: string): { valor: T; removidos: number } {
  let removidos = 0;
  const percorrer = (v: unknown): unknown => {
    if (typeof v === "string") {
      const l = limparTexto(v, home);
      removidos += l.removidos;
      return l.texto;
    }
    if (Array.isArray(v)) return v.map(percorrer);
    if (typeof v === "object" && v !== null) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, percorrer(x)]));
    }
    return v;
  };
  return { valor: percorrer(valor) as T, removidos };
}
