import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AgentProfile } from "../config/types.js";
import { db as defaultDb, schema } from "../db/index.js";
import { avisoDeDadoExterno, delimitarDado, novaMarca } from "../executor/dado-externo.js";
import type { assertWithinBudget, recordSpend } from "../executor/budget.js";
import type { LibraryService } from "../services/library-service.js";
import type { PassoAvulsoService } from "../services/passo-avulso-service.js";
import type { RunDetail, RunService } from "../services/run-service.js";
import { LIMITE_DA_INSTRUCAO } from "../services/run-service.js";
import {
  NucleoDeConversa,
  type Armazem,
  type CampoGuardado,
  type ContextoDaVolta,
  type DepsDoNucleo,
  type FerramentaLocal,
  type ProvedorDeConversa,
} from "./nucleo.js";
import { chaveDoRun, type DoRunNaConversa } from "./tipos.js";

type Db = typeof defaultDb;

/** Quem conversa: o que a pessoa escolheu, ou (nulo) o padrão do run. */
export type AlvoDaConversa = { agent: string } | { modelo: string };

/**
 * Limite técnico do que entra no contexto inicial (caracteres). Passado dele, o resto
 * é cortado e a tela diz o que ficou de fora. O que o modelo precisar, ele lê com `ler_run`.
 */
export const TETO_DO_CONTEXTO = 32_000;

/** O que `ler_run` devolve de uma vez. */
const TETO_DA_LEITURA = 20_000;

/** Passos do laço de ferramentas de uma volta. */
const PASSOS_DA_VOLTA = 12;

export interface DepsDaConversaDoRun extends DepsDoNucleo {
  db?: Db;
  runs: Pick<RunService, "get" | "rerunStep">;
  avulso: Pick<PassoAvulsoService, "proporAcao" | "acoesAvulsas">;
  library: Pick<LibraryService, "resolveProfile">;
  orcamento: { checar: typeof assertWithinBudget; gastar: typeof recordSpend };
  /** O teto do contexto inicial. Ausente, `TETO_DO_CONTEXTO`. */
  tetoDoContexto?: number;
}

const texto = (valor: unknown): string => (typeof valor === "string" ? valor : (JSON.stringify(valor, null, 2) ?? ""));

function cortar(conteudo: string, teto: number): string {
  return conteudo.length > teto ? `${conteudo.slice(0, teto)}\n[... cortado: passa de ${teto} caracteres]` : conteudo;
}

/** O que a conversa guarda na linha `run_conversations` do run. */
function armazemDoRun(db: Db): Armazem {
  return {
    ler: async (id, campo: CampoGuardado) => {
      const linha = db.select().from(schema.runConversations).where(eq(schema.runConversations.runId, id)).get();
      return linha?.[campo] ?? undefined;
    },
    gravar: async (id, campo, valor) => {
      db.insert(schema.runConversations)
        .values({ runId: id, [campo]: valor })
        .onConflictDoUpdate({ target: schema.runConversations.runId, set: { [campo]: valor } })
        .run();
    },
  };
}

/**
 * A conversa de um run que já rodou (ADR 0009): o núcleo de turno com o contexto do run.
 *
 * Quem conversa é o agent do primeiro passo de modelo do run (ou o modelo dele), salvo
 * escolha da pessoa. O modelo recebe o evento, a saída de cada passo e as pendências, e
 * age só por ferramentas sobre os mecanismos que já existem: ler o run, propor ação avulsa
 * (ADR 0007) e reexecutar um passo com instrução (ADR 0008). Nenhuma escreve fora da
 * máquina: o que sai passa pela Fila.
 */
export class ConversasDoRun extends NucleoDeConversa {
  constructor(private readonly dependencias: DepsDaConversaDoRun) {
    super(dependencias, provedorDoRun(dependencias));
  }

  /** Troca com quem a conversa fala. Nulo volta ao padrão. */
  async definirAlvo(runId: string, alvo: AlvoDaConversa | null): Promise<void> {
    const db = this.dependencias.db ?? defaultDb;
    if ((await this.estado(runId)).respondendo) throw new Error(this.dependencias.texto("agentChat.errors.busy"));
    if (alvo !== null && "agent" in alvo) await this.dependencias.library.resolveProfile(alvo.agent);
    if (db.select({ id: schema.runs.id }).from(schema.runs).where(eq(schema.runs.id, runId)).get() === undefined) throw new Error(`run ${runId} nao encontrado`);
    db.insert(schema.runConversations)
      .values({ runId, alvo })
      .onConflictDoUpdate({ target: schema.runConversations.runId, set: { alvo } })
      .run();
  }
}

function provedorDoRun(deps: DepsDaConversaDoRun): ProvedorDeConversa {
  const db = deps.db ?? defaultDb;
  const teto = deps.tetoDoContexto ?? TETO_DO_CONTEXTO;

  const detalhe = async (runId: string): Promise<RunDetail> => {
    const d = await deps.runs.get(runId);
    if (d === undefined) throw new Error(`run ${runId} nao encontrado`);
    return d;
  };

  /** O alvo escolhido, ou o do primeiro passo de modelo do run. */
  const resolverAlvo = (d: RunDetail): { alvo: AlvoDaConversa; padrao: boolean } => {
    const guardado = db.select({ alvo: schema.runConversations.alvo }).from(schema.runConversations).where(eq(schema.runConversations.runId, d.id)).get()?.alvo as AlvoDaConversa | null | undefined;
    if (guardado !== null && guardado !== undefined) return { alvo: guardado, padrao: false };
    const passo = d.spec.steps.find((p) => p.type === "model");
    if (passo === undefined || passo.type !== "model") throw new Error("o run nao tem passo de modelo: escolha um agent ou um modelo para a conversa");
    return { alvo: passo.profile === undefined ? { modelo: passo.model } : { agent: passo.profile }, padrao: true };
  };

  const alvoNaTela = (alvo: AlvoDaConversa): DoRunNaConversa["alvo"] => ("agent" in alvo ? { tipo: "agent", id: alvo.agent } : { tipo: "modelo", id: alvo.modelo });

  /** O que o modelo vê do run, na ordem de importância e dentro do teto. */
  const montarContexto = (d: RunDetail): { corpo: string; cortado: string[]; marca: string } => {
    const marca = novaMarca();
    const evento = d.eventId === null ? undefined : db.select({ payload: schema.events.payload }).from(schema.events).where(eq(schema.events.id, d.eventId)).get()?.payload;
    const pendencias = db.select().from(schema.approvals).where(eq(schema.approvals.runId, d.id)).all();
    const blocos: { rotulo: string; origem: string; conteudo: string }[] = [
      { rotulo: "evento", origem: "evento", conteudo: texto(evento ?? null) },
      {
        rotulo: "passos",
        origem: "passos",
        conteudo: d.steps.map((s) => `${s.stepKey} (${s.name}): ${s.status}${s.origem === "avulso" ? ", avulso" : ""}`).join("\n"),
      },
      ...pendencias.map((a) => ({ rotulo: `pendencia:${a.id}`, origem: `pendencia ${a.id} (${a.kind}, ${a.status})`, conteudo: texto(a.payload) })),
      // Os passos sem saída não têm o que cortar: o estado deles já vem no resumo.
      ...d.steps.filter((s) => s.output != null || s.error != null).map((s) => ({
        rotulo: `passo:${s.stepKey}`,
        origem: `passo ${s.stepKey} (${s.status}${s.origem === "avulso" ? ", avulso" : ""})`,
        conteudo: texto(s.output ?? s.error ?? null),
      })),
    ];
    let sobra = teto;
    const cortado: string[] = [];
    const partes: string[] = [];
    for (const b of blocos) {
      if (sobra <= 0) {
        cortado.push(b.rotulo);
        continue;
      }
      if (b.conteudo.length > sobra) cortado.push(b.rotulo);
      const dentro = cortar(b.conteudo, sobra);
      sobra -= Math.min(b.conteudo.length, sobra);
      partes.push(delimitarDado(dentro, b.origem, marca));
    }
    return { corpo: partes.join("\n\n"), cortado, marca };
  };

  const ferramentas = (d: RunDetail, marca: string): FerramentaLocal[] => [
    {
      nome: "ler_run",
      descricao:
        "Lê o run. Sem `passo`, devolve a lista de passos com o estado de cada um, as pendências e as ações que se podem propor, com o esquema do conteúdo de cada uma. Com `passo`, devolve a saída inteira daquele passo.",
      entrada: { passo: z.string().optional().describe("a chave do passo, como na lista") },
      executar: async ({ passo }) => {
        const atual = await detalhe(d.id);
        if (typeof passo === "string") {
          const achado = atual.steps.find((s) => s.stepKey === passo);
          if (achado === undefined) throw new Error(`o run nao tem o passo "${passo}"`);
          return delimitarDado(cortar(texto(achado.output ?? achado.error ?? null), TETO_DA_LEITURA), `passo ${passo}`, marca);
        }
        const pendencias = db.select().from(schema.approvals).where(eq(schema.approvals.runId, d.id)).all();
        return JSON.stringify(
          {
            status: atual.status,
            passos: atual.steps.map((s) => ({ chave: s.stepKey, nome: s.name, estado: s.status, avulso: s.origem === "avulso", instrucao: s.instrucao ?? null })),
            pendencias: pendencias.map((a) => ({ id: a.id, acao: a.kind, estado: a.status })),
            acoesQueSePodemPropor: deps.avulso.acoesAvulsas(),
          },
          null,
          2,
        );
      },
    },
    {
      nome: "propor_acao",
      descricao:
        "Propõe uma ação nova sobre o run, por exemplo aprovar sem comentários. Ela só cria uma pendência na Fila, e a pessoa decide lá: nada é publicado agora. O alvo (repositório, pull request, conversa) vem do evento do run. `conteudo` segue o esquema que `ler_run` mostra para a ação.",
      entrada: {
        acao: z.string().describe("a ação, como `ler_run` lista"),
        conteudo: z.record(z.string(), z.unknown()).describe("o conteúdo da ação, no esquema dela"),
        derivaDe: z.string().optional().describe("a chave do passo do fluxo de que esta ação deriva"),
      },
      executar: async ({ acao, conteudo, derivaDe }) => {
        const { approvalId, stepKey } = await deps.avulso.proporAcao(d.id, {
          kind: acao as string,
          conteudo,
          ...(typeof derivaDe === "string" ? { derivaDe } : {}),
        });
        return `Pendência ${approvalId} criada na Fila (passo ${stepKey}). Nada foi publicado: a pessoa decide lá.`;
      },
    },
    {
      nome: "reexecutar_passo",
      descricao:
        "Roda de novo um passo de modelo do run, com uma instrução a mais da pessoa, e os passos que dependem dele. O resultado novo substitui o anterior e as ações do run passam a esperar decisão na Fila. Leva minutos: a volta termina antes do run. Use quando a pessoa pede para olhar de novo ou acrescentar algo.",
      entrada: {
        passo: z.string().describe("a chave do passo de modelo"),
        instrucao: z.string().min(1).max(LIMITE_DA_INSTRUCAO).describe("o que a pessoa quer a mais, com as palavras dela"),
      },
      executar: async ({ passo, instrucao }) => {
        const status = await deps.runs.rerunStep(d.id, passo as string, { wait: false, instrucao: instrucao as string });
        return `O passo ${passo as string} voltou a rodar (${status}) com a instrução. As ações do run esperam decisão na Fila.`;
      },
    },
  ];

  const system = (d: RunDetail, persona: string, corpo: string, marca: string): string =>
    [
      persona,
      "Você conversa com a pessoa sobre um run de automação que já rodou. Ela pede mudanças no resultado e você as faz pelas ferramentas.",
      "Você só age por `ler_run`, `propor_acao` e `reexecutar_passo`. Nada é publicado por você: `propor_acao` cria uma pendência na Fila e `reexecutar_passo` roda o passo de novo com a instrução da pessoa. Diga o que fez e o que falta ela decidir.",
      avisoDeDadoExterno(marca),
      `Run ${d.id} da automação "${d.agentName}", estado ${d.status}${d.agentArchived ? ". A automação está arquivada: só se lê, e as ferramentas de escrita recusam." : "."}`,
      `Contexto do run:\n${corpo}`,
    ]
      .filter((p) => p !== "")
      .join("\n\n");

  return {
    chave: chaveDoRun,
    armazem: armazemDoRun(db),
    estado: async (id) => {
      const d = await detalhe(id);
      const { alvo, padrao } = resolverAlvo(d);
      return {
        semServidor: [],
        semSkill: [],
        contaIgnorada: 0,
        run: {
          alvo: alvoNaTela(alvo),
          padrao,
          arquivada: d.agentArchived,
          contexto: { teto, cortado: montarContexto(d).cortado },
          gasto: { usd: d.conversaUsd, tokens: d.conversaTokens },
        },
      };
    },
    contexto: async (id): Promise<ContextoDaVolta> => {
      const d = await detalhe(id);
      const { alvo } = resolverAlvo(d);
      const perfil = "agent" in alvo ? await deps.library.resolveProfile(alvo.agent) : undefined;
      const spec: AgentProfile | undefined = perfil?.version.spec;
      const { corpo, marca } = montarContexto(d);
      const chaveDoAgent = spec === undefined ? undefined : `biblioteca:${spec.id}`;
      return {
        modelo: spec?.model ?? ("modelo" in alvo ? alvo.modelo : ""),
        system: () => system(d, perfil?.system ?? "", corpo, marca),
        maxSteps: PASSOS_DA_VOLTA,
        ...(spec?.temperature === undefined ? {} : { temperature: spec.temperature }),
        // Nenhuma ferramenta de conexão: a conversa não escreve fora (ADR 0009).
        leitura: [],
        confirmar: [],
        locais: ferramentas(d, marca),
        checar: async (gasto) => {
          await deps.orcamento.checar(d.agentId, gasto, d.spec.budget);
          if (spec !== undefined && chaveDoAgent !== undefined) await deps.orcamento.checar(chaveDoAgent, gasto, spec.budget, spec.name);
        },
        gastar: async (gasto, novaMensagem) => {
          // Num campo do run separado dos passos: o `reset` de uma reexecução não o desconta.
          db.update(schema.runs)
            .set({ conversaUsd: sql`${schema.runs.conversaUsd} + ${gasto.usd}`, conversaTokens: sql`${schema.runs.conversaTokens} + ${gasto.tokens}` })
            .where(eq(schema.runs.id, d.id))
            .run();
          await deps.orcamento.gastar(d.agentId, gasto, false);
          if (chaveDoAgent !== undefined) await deps.orcamento.gastar(chaveDoAgent, gasto, novaMensagem);
        },
      };
    },
  };
}
