import { TriggerConfig } from "../config/types.js";
import { MARCAS_DOS_GATILHOS } from "./marcacao.js";
import type { GatilhoDoPacote, Pacote } from "./formato.js";
import { CodigoOmitido, indicesDoOndeDeGatilho } from "./formato.js";
import { paramsDoPacoteParaPasso, type ParamsDoPacote } from "./params.js";

/** Onde no pacote fica o que a pessoa vai preencher: um passo (pela chave) ou um gatilho (pela posição na lista). */
export type NoDoPacote = { tipo: "passo"; chave: string; nome: string } | { tipo: "gatilho"; posicao: number; kind: string };

/**
 * Um campo que a importação deixa a preencher. A prévia lista estes, e a importação
 * grava os mesmos na automação (`pendentes`); os dois leem daqui.
 */
export interface PendenciaDoPacote {
  no: NoDoPacote;
  campo: string;
  motivo: CodigoOmitido;
  /** O gatilho que o cadastro recusa sem o campo não chega a ser criado; o passo e os outros gatilhos são sempre criados. */
  criado: boolean;
}

/** O que o pacote avisa mas não deixa nada a preencher, ou que a importação já cobre por outro caminho. */
const INFORMATIVOS = new Set<CodigoOmitido>(["texto-limpo", "escrita-removida", "url-a-preencher", "chats-a-escolher", "gatilho-sem-canal", "skill-ausente"]);
/** Omitido que vale o passo inteiro, sem nome de param: o campo é o do próprio passo. */
const CAMPO_SEM_PARAMS: Partial<Record<CodigoOmitido, string>> = { tracker: "target" };

/**
 * Os campos que um omitido sem nome de param aponta: o do próprio passo (`target`), ou, no gatilho,
 * os que a marcação diz serem argumentos de ferramenta.
 */
function camposSemNome(codigo: CodigoOmitido, no: NoDoPacote): string[] {
  if (no.tipo === "passo") return CAMPO_SEM_PARAMS[codigo] === undefined ? [] : [CAMPO_SEM_PARAMS[codigo]!];
  if (codigo !== "argumentos") return [];
  return Object.entries(MARCAS_DOS_GATILHOS[no.kind as keyof typeof MARCAS_DOS_GATILHOS] ?? {}).flatMap(([campo, marca]) => (marca === "argumentos" ? [campo] : []));
}

/** O que a importação recalcula do próprio pacote: a pendência com estes motivos não precisa ser levada adiante. */
const RECALCULADOS = new Set<CodigoOmitido>(["url-a-preencher", "skill-ausente", "chats-a-escolher", "gatilho-sem-canal"]);

/**
 * A pendência gravada na automação como omitido do pacote, para quem recebe o pacote
 * reexportado ficar com a mesma pendência: o inverso do que `pendenciasDoPacote` lê.
 * Devolve `null` para a que a importação refaz sozinha.
 */
export function omitidoDaPendencia(motivo: string, campo: string, tipo: "passo" | "gatilho"): { codigo: CodigoOmitido; params?: string[] } | null {
  const codigo = CodigoOmitido.safeParse(motivo);
  if (!codigo.success || RECALCULADOS.has(codigo.data)) return null;
  const nome = tipo === "passo" ? (campo.startsWith("params.") ? campo.slice("params.".length) : undefined) : campo;
  if (tipo === "passo" && nome === undefined) {
    // Campo do próprio passo: o que a importação já lê sem nome de param (`target`), ou o passo inteiro.
    return CAMPO_SEM_PARAMS[codigo.data] === campo ? { codigo: codigo.data } : campo === "params" ? { codigo: "passo-a-revisar" } : null;
  }
  return { codigo: codigo.data, params: [nome!] };
}

/** A configuração do gatilho como o cadastro a lê, ou `null` quando falta o que o pacote não traz (o canal). */
export function configuracaoDoGatilho(g: GatilhoDoPacote): Record<string, unknown> | null {
  const { chatsRestritos, ...resto } = g as GatilhoDoPacote & { chatsRestritos?: number };
  const config: Record<string, unknown> = { ...resto, ...(chatsRestritos === undefined ? {} : { chatsPendentes: chatsRestritos }) };
  return TriggerConfig.safeParse(config).success ? config : null;
}

/** Quem usa a skill no pacote: `automacao` ou `agent:<id>`, como em `usadoPor` da prévia. */
export type UsosDasSkills = ReadonlyMap<string, readonly string[]>;

export function pendenciasDoPacote(
  pacote: Pacote,
  declaracoes: Readonly<Record<string, ParamsDoPacote>>,
  skillsAusentes: UsosDasSkills = new Map(),
): PendenciaDoPacote[] {
  const lista: PendenciaDoPacote[] = [];
  const acrescentar = (p: PendenciaDoPacote): void => {
    const mesmoNo = (a: NoDoPacote, b: NoDoPacote): boolean => (a.tipo === "passo" ? b.tipo === "passo" && a.chave === b.chave : b.tipo === "gatilho" && a.posicao === b.posicao);
    if (!lista.some((q) => mesmoNo(q.no, p.no) && q.campo === p.campo)) lista.push(p);
  };
  const passos = new Map(pacote.automacao.spec.steps.map((p) => [p.key, p]));
  const gatilhos = pacote.automacao.gatilhos;
  const criados = gatilhos.map((g) => configuracaoDoGatilho(g) !== null);

  for (const o of pacote.omitidos) {
    if (INFORMATIVOS.has(o.codigo)) continue;
    const passo = passos.get(o.onde);
    const nos: NoDoPacote[] =
      passo !== undefined
        ? [{ tipo: "passo", chave: passo.key, nome: passo.name }]
        : indicesDoOndeDeGatilho(o.onde, gatilhos.map((g) => g.kind)).map((posicao) => ({ tipo: "gatilho", posicao, kind: gatilhos[posicao]!.kind }));
    for (const no of nos) {
      // Omitido sem nome de param (pacote antigo): o passo inteiro fica a revisar, porque não se sabe o que faltou.
      if (no.tipo === "passo" && o.params === undefined && CAMPO_SEM_PARAMS[o.codigo] === undefined) {
        acrescentar({ no, campo: "params", motivo: "passo-a-revisar", criado: true });
        continue;
      }
      for (const nome of o.params ?? camposSemNome(o.codigo, no)) {
        // Os chats do Teams já esperam pela escolha no próprio gatilho (`chatsPendentes`).
        if (no.tipo === "gatilho" && no.kind === "teams-inbox" && nome === "chats") continue;
        acrescentar({ no, campo: no.tipo === "passo" && o.params !== undefined ? `params.${nome}` : nome, motivo: o.codigo, criado: no.tipo === "passo" || criados[no.posicao]! });
      }
    }
  }

  for (const p of pacote.automacao.spec.steps) {
    if (p.type !== "action") continue;
    const no: NoDoPacote = { tipo: "passo", chave: p.key, nome: p.name };
    const declaracao = declaracoes[p.action] ?? {};
    for (const [nome, como] of Object.entries(declaracao)) if (como === "url") acrescentar({ no, campo: `params.${nome}`, motivo: "url-a-preencher", criado: true });
    // O que o arquivo traz e a ação não deixa viajar (pacote mexido à mão) não entra, e fica dito.
    for (const nome of paramsDoPacoteParaPasso(declaracao, p.params ?? {}).descartados) acrescentar({ no, campo: `params.${nome}`, motivo: "argumentos", criado: true });
  }

  for (const [posicao, g] of gatilhos.entries()) {
    if (criados[posicao]) continue;
    // O gatilho não chega a existir: a pendência fica na automação, no campo que o cadastro recusou.
    const faltando = TriggerConfig.safeParse({ ...g }).error?.issues[0]?.path.join(".");
    acrescentar({ no: { tipo: "gatilho", posicao, kind: g.kind }, campo: faltando ?? g.kind, motivo: "gatilho-sem-canal", criado: false });
  }

  // Skill que o pacote não trouxe e esta máquina não tem: fica no passo que a usa, direto ou pelo agent.
  for (const [nome, usadoPor] of skillsAusentes) {
    for (const p of pacote.automacao.spec.steps) {
      if (p.type !== "model") continue;
      const usa = usadoPor.includes("automacao") || (p.profile !== undefined && usadoPor.includes(`agent:${p.profile}`));
      if (usa) acrescentar({ no: { tipo: "passo", chave: p.key, nome: p.name }, campo: `skills.${nome}`, motivo: "skill-ausente", criado: true });
    }
  }
  return lista;
}
