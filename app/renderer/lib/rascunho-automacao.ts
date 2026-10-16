import type { Rascunho } from "./automacao";

/**
 * O rascunho local do editor de automação.
 *
 * O editor edita em memória e só grava no "Salvar". Sem isto, uma navegação, um
 * recarregamento ou uma queda da janela perdia a automação inteira. O rascunho
 * é por automação (a chave leva o id), mora no armazém local da janela e some
 * quando a pessoa salva, descarta ou volta ao que está gravado.
 */

/** O pedaço do `Storage` que o rascunho usa; o teste passa um de memória. */
export interface ArmazemLocal {
  getItem(chave: string): string | null;
  setItem(chave: string, valor: string): void;
  removeItem(chave: string): void;
}

/** O armazém que também sabe listar as chaves, que é o que a reserva precisa. */
export interface ArmazemListavel extends ArmazemLocal {
  readonly length: number;
  key(indice: number): string | null;
}

export interface RascunhoGuardado {
  rascunho: Rascunho;
  /** A versão gravada sobre a qual a edição começou. */
  versao: number;
  /** Quando foi guardado, em milissegundos. */
  salvoEm: number;
  /**
   * Quando o agent nasceu. Um id reaproveitado depois de a automação ser
   * apagada tem outra data, e o rascunho da encarnação anterior não vale.
   */
  criadaEm?: number;
}

/** Há diferença entre o que está na tela e o que está gravado. */
export function temMudanca(rascunho: Rascunho, salvo: Rascunho): boolean {
  return JSON.stringify(rascunho) !== JSON.stringify(salvo);
}

export function chaveDoRascunho(agentId: string): string {
  return `locum.rascunho-automacao.${agentId}`;
}

/**
 * Guarda o rascunho, ou apaga o guardado quando ele voltou a ser igual ao
 * gravado. Armazém cheio ou bloqueado não pode quebrar a edição: o rascunho é
 * rede de segurança, e perdê-lo é o estado de antes.
 */
export function guardarRascunho(
  armazem: ArmazemLocal,
  agentId: string,
  rascunho: Rascunho,
  salvo: Rascunho,
  versao: number,
  agora: number = Date.now(),
  criadaEm?: number,
): void {
  try {
    if (!temMudanca(rascunho, salvo)) {
      armazem.removeItem(chaveDoRascunho(agentId));
      return;
    }
    const corpo: RascunhoGuardado = { rascunho, versao, salvoEm: agora, ...(criadaEm === undefined ? {} : { criadaEm }) };
    armazem.setItem(chaveDoRascunho(agentId), JSON.stringify(corpo));
  } catch {
    // sem armazém, sem rascunho
  }
}

function interpretar(cru: string | null): RascunhoGuardado | null {
  try {
    if (cru === null) return null;
    const lido = JSON.parse(cru) as Partial<RascunhoGuardado> | null;
    const r = lido?.rascunho;
    if (r === undefined || r === null || typeof r.spec !== "object" || r.spec === null || !Array.isArray(r.gatilhos)) return null;
    return {
      rascunho: r,
      versao: typeof lido?.versao === "number" ? lido.versao : 0,
      salvoEm: typeof lido?.salvoEm === "number" ? lido.salvoEm : 0,
      ...(typeof lido?.criadaEm === "number" ? { criadaEm: lido.criadaEm } : {}),
    };
  } catch {
    return null;
  }
}

/** O rascunho guardado, ou nulo se não há ou se o conteúdo não é um rascunho. */
export function lerRascunho(armazem: ArmazemLocal, agentId: string): RascunhoGuardado | null {
  try {
    return interpretar(armazem.getItem(chaveDoRascunho(agentId)));
  } catch {
    return null;
  }
}

export function descartarRascunho(armazem: ArmazemLocal, agentId: string): void {
  try {
    armazem.removeItem(chaveDoRascunho(agentId));
  } catch {
    // idem
  }
}

/* ---------------------------------------------------------------- reserva */

/**
 * A reserva é o rascunho que a pessoa deixou de lado sem dizer que o largava:
 * começou a editar do gravado com a oferta de continuar ainda na tela. Ela vive
 * numa chave própria, com a data, e só some quando a pessoa decide. Descartar
 * o rascunho ativo, na saída do editor, não mexe nela.
 */
function prefixoDaReserva(agentId: string): string {
  return `locum.rascunho-automacao-reserva.${agentId}.`;
}

/** Passa o rascunho ativo para a reserva e devolve a chave dela, ou nulo quando não havia o que reservar. */
export function reservarRascunho(armazem: ArmazemLocal, agentId: string, agora: number = Date.now()): string | null {
  try {
    const cru = armazem.getItem(chaveDoRascunho(agentId));
    if (cru === null) return null;
    let momento = agora;
    while (armazem.getItem(`${prefixoDaReserva(agentId)}${momento}`) !== null) momento++;
    const chave = `${prefixoDaReserva(agentId)}${momento}`;
    armazem.setItem(chave, cru);
    armazem.removeItem(chaveDoRascunho(agentId));
    return chave;
  } catch {
    return null;
  }
}

export interface Reserva {
  chave: string;
  guardado: RascunhoGuardado;
}

/** As reservas da automação, da mais recente para a mais antiga. */
export function lerReservas(armazem: ArmazemListavel, agentId: string): Reserva[] {
  try {
    const prefixo = prefixoDaReserva(agentId);
    const chaves: string[] = [];
    for (let i = 0; i < armazem.length; i++) {
      const chave = armazem.key(i);
      if (chave !== null && chave.startsWith(prefixo)) chaves.push(chave);
    }
    return chaves
      .flatMap((chave) => {
        const guardado = interpretar(armazem.getItem(chave));
        return guardado === null ? [] : [{ chave, guardado }];
      })
      .sort((a, b) => b.guardado.salvoEm - a.guardado.salvoEm || (a.chave < b.chave ? 1 : -1));
  } catch {
    return [];
  }
}

export function descartarReserva(armazem: ArmazemLocal, chave: string): void {
  try {
    armazem.removeItem(chave);
  } catch {
    // idem
  }
}

/* ----------------------------------------------------------------- oferta */

/** O que está gravado agora, contra o que a oferta de rascunho se confere. */
export interface Gravado {
  versao: number;
  criadaEm: number;
  rascunho: Rascunho;
}

export interface OfertaDeRascunho {
  guardado: RascunhoGuardado;
  /** A chave da reserva, quando a oferta é de um rascunho reservado. */
  reserva?: string;
  /** A automação foi gravada de novo depois de o rascunho começar. */
  baseMudou: boolean;
}

/**
 * Restaura um rascunho sobre o que está gravado agora.
 *
 * O rascunho devolve só o que a pessoa edita no canvas: nome, passos, desenho
 * e a configuração dos gatilhos. Ligado ou desligado, teto de gasto, skills e
 * ferramentas padrão vêm sempre do gravado: ligar a automação depois do
 * rascunho, ou gravar outro teto, não pode ser desfeito por uma restauração.
 */
export function restaurarRascunho(rascunho: Rascunho, atual: Rascunho): Rascunho {
  const ligados = new Map(atual.gatilhos.flatMap((g) => (g.id === undefined ? [] : [[g.id, g.enabled] as const])));
  return {
    spec: { ...rascunho.spec, budget: atual.spec.budget, skills: atual.spec.skills, defaultTools: atual.spec.defaultTools },
    gatilhos: rascunho.gatilhos.map((g) => {
      if (g.id !== undefined && ligados.has(g.id)) return { ...g, enabled: ligados.get(g.id)! };
      // Sem o gatilho gravado (novo, ou apagado no meio), vira novo e desligado.
      const { id: _id, ...novo } = g;
      return { ...novo, enabled: false };
    }),
  };
}

/** O rascunho (ou a reserva mais recente) que vale oferecer sobre o gravado, ou nulo. */
export function ofertaDeRascunho(armazem: ArmazemListavel, agentId: string, atual: Gravado): OfertaDeRascunho | null {
  const ativo = lerRascunho(armazem, agentId);
  const candidatos: { guardado: RascunhoGuardado; reserva?: string }[] = [
    ...(ativo === null ? [] : [{ guardado: ativo }]),
    ...lerReservas(armazem, agentId).map((r) => ({ guardado: r.guardado, reserva: r.chave })),
  ];
  for (const c of candidatos) {
    if (c.guardado.criadaEm !== undefined && c.guardado.criadaEm !== atual.criadaEm) continue;
    if (!temMudanca(restaurarRascunho(c.guardado.rascunho, atual.rascunho), atual.rascunho)) continue;
    return { ...c, baseMudou: c.guardado.versao !== atual.versao };
  }
  return null;
}

/* ------------------------------------------------------------- diferenças */

export interface Diferenca {
  chave: string;
  tipo: "novo" | "removido" | "alterado";
  /** O nome do passo, ou o tipo do gatilho. */
  rotulo: string;
}

/** Passos e gatilhos em que o rascunho difere do gravado. Só a lista, sem o miolo. */
export function diferencas(gravado: Rascunho, rascunho: Rascunho): { passos: Diferenca[]; gatilhos: Diferenca[] } {
  const igual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

  const passos: Diferenca[] = [];
  for (const p of gravado.spec.steps) {
    const novo = rascunho.spec.steps.find((x) => x.key === p.key);
    if (novo === undefined) passos.push({ chave: p.key, tipo: "removido", rotulo: p.name ?? p.key });
    else if (!igual(p, novo)) passos.push({ chave: p.key, tipo: "alterado", rotulo: novo.name ?? novo.key });
  }
  for (const p of rascunho.spec.steps) {
    if (!gravado.spec.steps.some((x) => x.key === p.key)) passos.push({ chave: p.key, tipo: "novo", rotulo: p.name ?? p.key });
  }

  const gatilhos: Diferenca[] = [];
  for (const g of gravado.gatilhos) {
    const novo = rascunho.gatilhos.find((x) => x.id !== undefined && x.id === g.id);
    if (novo === undefined) gatilhos.push({ chave: g.chave, tipo: "removido", rotulo: g.config.kind });
    else if (!igual(g.config, novo.config)) gatilhos.push({ chave: g.chave, tipo: "alterado", rotulo: novo.config.kind });
  }
  for (const g of rascunho.gatilhos) {
    if (g.id === undefined || !gravado.gatilhos.some((x) => x.id === g.id)) gatilhos.push({ chave: g.chave, tipo: "novo", rotulo: g.config.kind });
  }
  return { passos, gatilhos };
}

/* ------------------------------------------------- automação não gravada */

/**
 * "Nova automação" não grava nada: o modelo escolhido fica aqui até o primeiro
 * Salvar. Abandonar o editor sem editar apaga a provisória, e sobra nenhuma
 * automação fantasma na lista.
 */
export interface Provisoria {
  rascunho: Rascunho;
  /** A nota da primeira versão. */
  nota: string;
  /** A iniciativa a que a automação se liga ao ser criada. */
  iniciativa?: string;
}

export function chaveDaProvisoria(agentId: string): string {
  return `locum.automacao-provisoria.${agentId}`;
}

export function guardarProvisoria(armazem: ArmazemLocal, agentId: string, provisoria: Provisoria): void {
  try {
    armazem.setItem(chaveDaProvisoria(agentId), JSON.stringify(provisoria));
  } catch {
    // sem armazém, a automação nova não abre: quem chama confere com `lerProvisoria`
  }
}

export function lerProvisoria(armazem: ArmazemLocal, agentId: string): Provisoria | null {
  try {
    const cru = armazem.getItem(chaveDaProvisoria(agentId));
    if (cru === null) return null;
    const lido = JSON.parse(cru) as Partial<Provisoria> | null;
    const r = lido?.rascunho;
    if (r === undefined || r === null || typeof r.spec !== "object" || r.spec === null || !Array.isArray(r.gatilhos)) return null;
    return { rascunho: r, nota: typeof lido?.nota === "string" ? lido.nota : "", ...(typeof lido?.iniciativa === "string" ? { iniciativa: lido.iniciativa } : {}) };
  } catch {
    return null;
  }
}

export function apagarProvisoria(armazem: ArmazemLocal, agentId: string): void {
  try {
    armazem.removeItem(chaveDaProvisoria(agentId));
  } catch {
    // idem
  }
}
