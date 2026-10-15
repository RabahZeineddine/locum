export interface CanalListado {
  teamId: string;
  teamName: string;
  channelId: string;
  channelName: string;
}

export interface GrupoDeEquipe {
  teamId: string;
  teamName: string;
  canais: CanalListado[];
  marcados: number;
}

/**
 * Os canais por equipe: busca por equipe ou canal, equipes com canal marcado
 * primeiro, o marcado no topo de cada grupo, e o resto em ordem alfabética.
 * `marcados` guarda `teamId/channelId`.
 */
export function organizarCanais(lista: readonly CanalListado[], marcados: ReadonlySet<string>, termo: string): GrupoDeEquipe[] {
  const t = termo.trim().toLowerCase();
  const achados = t === "" ? lista : lista.filter((c) => c.teamName.toLowerCase().includes(t) || c.channelName.toLowerCase().includes(t));
  const porEquipe = new Map<string, GrupoDeEquipe>();
  for (const c of achados) {
    const grupo = porEquipe.get(c.teamId) ?? { teamId: c.teamId, teamName: c.teamName, canais: [], marcados: 0 };
    grupo.canais.push(c);
    if (marcados.has(`${c.teamId}/${c.channelId}`)) grupo.marcados += 1;
    porEquipe.set(c.teamId, grupo);
  }
  const marcado = (c: CanalListado): number => (marcados.has(`${c.teamId}/${c.channelId}`) ? 0 : 1);
  return [...porEquipe.values()]
    .map((g) => ({ ...g, canais: [...g.canais].sort((a, b) => marcado(a) - marcado(b) || a.channelName.localeCompare(b.channelName)) }))
    .sort((a, b) => Number(b.marcados > 0) - Number(a.marcados > 0) || a.teamName.localeCompare(b.teamName));
}
