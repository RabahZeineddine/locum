export interface OrigemLegivel {
  tipo: "plugin" | "usuario" | "ferramenta";
  nome: string;
}

/** "akad@akad" é o plugin akad do marketplace akad; "usuário" são os servidores do próprio Claude Code. */
export function origemLegivel(origem: string): OrigemLegivel {
  if (origem === "usuário") return { tipo: "usuario", nome: origem };
  if (origem.includes("@")) return { tipo: "plugin", nome: origem.split("@")[0] ?? origem };
  return { tipo: "ferramenta", nome: origem };
}

const PRODUCAO = /(^|[^a-z0-9])(prod|production|producao|produção)([^a-z0-9]|$)/i;

/** O nome ou o endereço indica produção: nunca vem marcado para importar. */
export function pareceProducao(c: { name: string; destino: string }): boolean {
  return PRODUCAO.test(c.name) || PRODUCAO.test(c.destino);
}

export function agruparPorOrigem<T extends { origem: string }>(itens: readonly T[]): { origem: string; itens: T[] }[] {
  const grupos = new Map<string, T[]>();
  for (const item of itens) grupos.set(item.origem, [...(grupos.get(item.origem) ?? []), item]);
  return [...grupos].map(([origem, doGrupo]) => ({ origem, itens: doGrupo }));
}
