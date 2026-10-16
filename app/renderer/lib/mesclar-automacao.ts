import type { AgentSpec } from "../../src/config/types";
import type { GatilhoNoCanvas, Rascunho } from "./automacao";

/**
 * O que o Salvar manda, e como o rascunho se junta ao que está gravado agora.
 *
 * Três pontas: a `base` é o gravado sobre o qual a edição começou, o `meu` é o
 * rascunho, e o `gravado` é o que está no banco agora. Passo e gatilho mexidos
 * só de um lado ficam como o lado que mexeu; mexidos dos dois, com resultado
 * diferente, são conflito e a pessoa escolhe qual fica.
 */

export type Escolha = "meu" | "de-fora";

/** As escolhas por conflito, pela chave `passo:<key>` ou `gatilho:<id>`. */
export type Escolhas = Readonly<Record<string, Escolha>>;

export interface Conflito {
  chave: string;
  tipo: "passo" | "gatilho";
  /** O nome do passo, ou o tipo do gatilho. */
  rotulo: string;
}

export interface GatilhoParaGravar {
  id?: string;
  config: GatilhoNoCanvas["config"];
  /** Só o gatilho novo manda: o que já existe mantém o ligado ou desligado gravado. */
  enabled?: boolean;
  valerParaTodosOsChats?: boolean;
}

const igual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Ligar e desligar pelo MCP ou pela lista não cria versão, então o `enabled` do
 * estado local pode estar velho. Gatilho com id não o manda e o serviço mantém
 * o gravado; o novo nasce com o dele (desligado).
 *
 * O botão "valer para todos os chats" vale para o gatilho gravado que esperava
 * a escolha de chats e a pessoa zerou a pendência sem escolher nenhum.
 */
export function gatilhosParaGravar(gatilhos: readonly GatilhoNoCanvas[], gravados: readonly GatilhoNoCanvas[]): GatilhoParaGravar[] {
  return gatilhos.map((g) => {
    const antes = g.id === undefined ? undefined : gravados.find((x) => x.id === g.id)?.config;
    const valeParaTodos =
      antes?.kind === "teams-inbox" &&
      antes.chatsPendentes > 0 &&
      antes.chats.length === 0 &&
      g.config.kind === "teams-inbox" &&
      g.config.chatsPendentes === 0 &&
      g.config.chats.length === 0;
    return {
      ...(g.id === undefined ? { enabled: g.enabled } : { id: g.id }),
      config: g.config,
      ...(valeParaTodos ? { valerParaTodosOsChats: true } : {}),
    };
  });
}

/** Resolve um item pelas três pontas. `undefined` é ausente. */
function resolver<T>(
  base: T | undefined,
  meu: T | undefined,
  gravado: T | undefined,
  escolha: Escolha,
): { valor: T | undefined; conflito: boolean } {
  if (igual(meu, base)) return { valor: gravado, conflito: false };
  if (igual(gravado, base) || igual(gravado, meu)) return { valor: meu, conflito: false };
  return { valor: escolha === "meu" ? meu : gravado, conflito: true };
}

type Passo = AgentSpec["steps"][number];

export function mesclar(base: Rascunho, meu: Rascunho, gravado: Rascunho, escolhas: Escolhas = {}): { rascunho: Rascunho; conflitos: Conflito[] } {
  const conflitos: Conflito[] = [];

  // Passos: a ordem do gravado, e depois os que só eu acrescentei.
  const porChave = (r: Rascunho): Map<string, Passo> => new Map(r.spec.steps.map((p) => [p.key, p]));
  const [pb, pm, pg] = [porChave(base), porChave(meu), porChave(gravado)];
  const chaves = [...new Set([...gravado.spec.steps.map((p) => p.key), ...meu.spec.steps.map((p) => p.key)])];
  const steps: Passo[] = [];
  for (const key of chaves) {
    const id = `passo:${key}`;
    const r = resolver(pb.get(key), pm.get(key), pg.get(key), escolhas[id] ?? "meu");
    if (r.conflito) conflitos.push({ chave: id, tipo: "passo", rotulo: (pm.get(key) ?? pg.get(key))!.name ?? key });
    if (r.valor !== undefined) steps.push(r.valor);
  }

  // Desenho: o que movi, por chave; o resto fica como está no gravado.
  const layout: NonNullable<AgentSpec["layout"]> = {};
  const lb = base.spec.layout ?? {};
  const lm = meu.spec.layout ?? {};
  const lg = gravado.spec.layout ?? {};
  for (const k of new Set([...Object.keys(lm), ...Object.keys(lg)])) {
    const posicao = igual(lm[k], lb[k]) ? lg[k] : lm[k];
    if (posicao !== undefined) layout[k] = posicao;
  }

  // Gatilhos: pelo id. Os sem id são novos meus e entram sempre.
  const gb = new Map(base.gatilhos.flatMap((g) => (g.id === undefined ? [] : [[g.id, g] as const])));
  const gm = new Map(meu.gatilhos.flatMap((g) => (g.id === undefined ? [] : [[g.id, g] as const])));
  const gg = new Map(gravado.gatilhos.flatMap((g) => (g.id === undefined ? [] : [[g.id, g] as const])));
  const usadas = new Set<string>();
  const chaveLivre = (preferida: string): string => {
    let chave = preferida;
    for (let n = 2; usadas.has(chave); n++) chave = `${preferida}-${n}`;
    usadas.add(chave);
    return chave;
  };
  const gatilhos: GatilhoNoCanvas[] = [];
  for (const g of gravado.gatilhos) {
    if (g.id === undefined) continue;
    const id = `gatilho:${g.id}`;
    const meuG = gm.get(g.id);
    const r = resolver(gb.get(g.id)?.config, meuG?.config, g.config, escolhas[id] ?? "meu");
    if (r.conflito) conflitos.push({ chave: id, tipo: "gatilho", rotulo: g.config.kind });
    if (r.valor === undefined) continue;
    gatilhos.push({ chave: chaveLivre(meuG?.chave ?? g.chave), id: g.id, config: r.valor, enabled: g.enabled });
  }
  for (const g of meu.gatilhos) {
    // Novo meu, ou gravado que sumiu por fora depois de eu mexer nele: entra como novo e desligado.
    const sumiu = g.id !== undefined && !gg.has(g.id);
    if (g.id !== undefined && !sumiu) continue;
    if (sumiu && igual(g.config, gb.get(g.id!)?.config)) continue;
    const { id: _id, ...novo } = g;
    gatilhos.push({ ...novo, chave: chaveLivre(g.chave), enabled: false });
  }

  const spec: AgentSpec = {
    ...gravado.spec,
    name: meu.spec.name === base.spec.name ? gravado.spec.name : meu.spec.name,
    steps,
    ...(Object.keys(layout).length === 0 ? {} : { layout }),
  };
  if (Object.keys(layout).length === 0) delete spec.layout;
  return { rascunho: { spec, gatilhos }, conflitos };
}
