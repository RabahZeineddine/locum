import { z } from "zod";
import {
  ActionStep,
  AgentBudget,
  AgentProfile,
  AgentSpec,
  AgentConnection,
  CronTrigger,
  LogicStep,
  ManualTrigger,
  McpPollTrigger,
  ModelStep,
  PollFilters,
  PollTrigger,
  ScheduleTrigger,
  SkillRule,
  SlackChannelTrigger,
  SlackInboxTrigger,
  TeamsInboxTrigger,
  ToolRef,
  WebhookTrigger,
  topoSort,
  type Step,
} from "../config/types.js";
import { MARCAS_DO_AGENT, MARCAS_DO_SPEC, MARCAS_DOS_GATILHOS, ehLocal, temFilhos, type MapaDeMarcas } from "./marcacao.js";

/**
 * O pacote: o arquivo `.locum.json` que uma automação vira para ir a outra
 * máquina. Só dado: nada aqui é executado nem vira comando, e o que o arquivo
 * diz de servidor MCP (nome, pacote, host) é rótulo para a pessoa achar o
 * equivalente dela, nunca um cadastro.
 *
 * Todo objeto é estrito. Campo que o formato não conhece é erro, e não
 * descarte silencioso: um pacote com campo a mais é de outra versão do Locum
 * ou foi mexido à mão, e a pessoa precisa saber antes de importar.
 */

export const NOME_DO_FORMATO = "locum-pacote";

/**
 * Onde, no pacote, um omitido do gatilho aponta: a posição dele na lista de gatilhos.
 * Pacote antigo dizia o tipo (`poll`); `indicesDoOndeDeGatilho` lê os dois.
 */
export const ondeDoGatilhoNoPacote = (indice: number): string => `gatilho:${indice}`;
export function indicesDoOndeDeGatilho(onde: string, tipos: readonly string[]): number[] {
  const posicao = /^gatilho:(\d+)$/.exec(onde);
  if (posicao !== null) return Number(posicao[1]) < tipos.length ? [Number(posicao[1])] : [];
  return tipos.flatMap((tipo, i) => (tipo === onde ? [i] : []));
}
/**
 * A versão que este Locum grava. A 2 trouxe o conteúdo das skills (`skills`); a 1
 * continua lida, e o pacote dela chega sem conteúdo de skill.
 */
export const VERSAO_DO_FORMATO = 2;
export const VERSOES_LIDAS: readonly number[] = [1, 2];
export const EXTENSAO_DO_PACOTE = ".locum.json";
/** Um pacote de verdade tem poucos KB; acima disto não é um. */
export const TAMANHO_MAXIMO_DO_PACOTE = 2 * 1024 * 1024;

const IdDoPacote = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "use letras minúsculas, números e hífen");

/* ---------------------------------------------------------------- passos */

const PassoDeIA = ModelStep.strict();
const PassoDeLogica = LogicStep.strict();

/**
 * Passo de ação sem o `target` (o tracker é desta máquina). Em `params` viaja o
 * que a ação declara como portátil ou texto limpo (`ActionHandler.paramsDoPacote`),
 * e a importação aplica a mesma declaração de novo: o arquivo pode ter sido
 * mexido à mão. `origem` é a URL reduzida a esquema e host.
 */
const PassoDeAcao = ActionStep.omit({ target: true, params: true })
  .extend({
    params: z
      .record(z.string(), z.unknown())
      .refine((p) => p.origem === undefined || (typeof p.origem === "string" && /^https?:\/\/[^\s/?#@]+$/.test(p.origem)), {
        message: "origem: só esquema e host, sem caminho",
      })
      .optional(),
  })
  .strict();

const Passo = z.discriminatedUnion("type", [PassoDeIA, PassoDeAcao, PassoDeLogica]);

/**
 * Os campos de um esquema que viajam, pela marcação (`marcacao.ts`): o que ela não diz
 * dobrado, seguro ou local entra com o esquema do próprio campo, e `apertados` troca o
 * que o pacote exige mais estrito. Campo portável novo no esquema entra sem mexer aqui.
 */
function camposQueViajam(schema: z.ZodObject<any>, marcas: MapaDeMarcas, apertados: Record<string, z.ZodType>, fora: readonly string[] = []): Record<string, z.ZodType> {
  const campos: Record<string, z.ZodType> = {};
  for (const [campo, marca] of Object.entries(marcas)) {
    if (fora.includes(campo) || marca === "dobrado" || marca === "seguro" || ehLocal(marca)) continue;
    campos[campo] = apertados[campo] ?? (schema.shape[campo] as z.ZodType);
  }
  return campos;
}

/** O spec no pacote: o id é o da automação, as pendências e o toolset ficam de fora, e os passos têm o esquema acima. */
export type SpecDoPacote = Omit<z.infer<typeof AgentSpec>, "id" | "steps" | "pendentes" | "rebaixados"> & { steps: z.infer<typeof Passo>[] };
const SpecDoPacote = z
  .object(
    camposQueViajam(
      AgentSpec,
      MARCAS_DO_SPEC,
      {
        name: z.string().trim().min(1),
        defaultTools: z.array(ToolRef.strict()).default([]),
        skills: z.array(SkillRule.strict()).default([]),
        steps: z.array(Passo).min(1),
        budget: AgentBudget.strict().default({}),
        layout: z.record(z.string(), z.object({ x: z.number(), y: z.number() }).strict()).optional(),
      },
      ["id"],
    ),
  )
  .strict() as unknown as z.ZodType<SpecDoPacote>;

/* --------------------------------------------------------------- gatilhos */

/**
 * O esquema sem o que é desta máquina, derivado da marcação (`marcacao.ts`):
 * campo local ou dobrado sai, e um objeto com `filhos` é derivado do mesmo jeito.
 */
type Fora<M> = { [K in keyof M]: M[K] extends "dobrado" | "seguro" | { readonly local: unknown } ? K : never }[keyof M];
function semLocais<S extends z.ZodObject<any>, M extends MapaDeMarcas>(schema: S, marcas: M): z.ZodType<Omit<z.infer<S>, Fora<M>>> {
  const fora: Record<string, true> = {};
  const trocas: Record<string, z.ZodType> = {};
  for (const [campo, marca] of Object.entries(marcas)) {
    if (marca === "dobrado" || marca === "seguro" || ehLocal(marca)) fora[campo] = true;
    else if (temFilhos(marca)) {
      const nested = (schema.shape[campo] as unknown as z.ZodOptional<z.ZodObject<any>>).unwrap();
      trocas[campo] = (semLocais(nested, marca.filhos) as unknown as z.ZodOptional<z.ZodObject<any>>).optional();
    }
  }
  return schema.omit(fora as never).extend(trocas as never).strict() as never;
}

/**
 * O gatilho sem o que é da pessoa (canais, chats, dono e autores do GitHub):
 * a pessoa escolhe isso ao importar. A derivação lê `MARCAS_DOS_GATILHOS`.
 */
const M = MARCAS_DOS_GATILHOS;
const GatilhoDoPacote = z.union([
  semLocais(ScheduleTrigger, M.schedule),
  semLocais(WebhookTrigger, M.webhook),
  semLocais(CronTrigger, M.cron),
  semLocais(ManualTrigger, M.manual),
  semLocais(SlackInboxTrigger, M["slack-inbox"]),
  semLocais(SlackChannelTrigger, M["slack-channel"]),
  // Quantos chats restringiam o gatilho, sem os ids. Ausente é gatilho em todos os chats.
  (semLocais(TeamsInboxTrigger, M["teams-inbox"]) as unknown as z.ZodObject<any>)
    .extend({ chatsRestritos: z.number().int().positive().optional() })
    .strict() as unknown as z.ZodType<Omit<z.infer<typeof TeamsInboxTrigger>, "channels" | "chats" | "chatsPendentes"> & { chatsRestritos?: number }>,
  semLocais(PollTrigger, M.poll) as unknown as z.ZodType<
    Omit<z.infer<typeof PollTrigger>, "owner" | "filters"> & { filters?: Omit<PollFilters, "authors" | "reviewRequested" | "teamMembers"> }
  >,
  semLocais(McpPollTrigger, M["mcp-poll"]),
]);
export type GatilhoDoPacote = z.infer<typeof GatilhoDoPacote>;

/* ----------------------------------------------------------------- agents */

/** O agent no pacote: o toolset virou ferramentas avulsas dele, e as skills são sempre regras. */
export type AgentDoPacote = Omit<z.infer<typeof AgentProfile>, "toolsets" | "skills"> & { skills: z.infer<typeof SkillRule>[] };
const AgentDoPacote = z
  .object(
    camposQueViajam(AgentProfile, MARCAS_DO_AGENT, {
      id: IdDoPacote,
      name: z.string().trim().min(1),
      description: z.string().default(""),
      context: z.string().default(""),
      instructions: z.string().default(""),
      /** Sugestão: quem importa liga ao provedor e ao modelo que tem. */
      model: z.string().min(1),
      temperature: z.number().min(0).max(2).optional(),
      tools: z.array(ToolRef.strict()).default([]),
      connections: z.array(AgentConnection.strict()).default([]),
      skills: z.array(SkillRule.strict()).default([]),
      budget: AgentBudget.strict().default({}),
      maxSteps: z.number().int().positive().default(12),
    }),
  )
  .strict() as unknown as z.ZodType<AgentDoPacote>;


/* ------------------------------------------------------------- requisitos */

const ConexaoRequerida = z.object({ id: z.string().min(1), nome: z.string().min(1) }).strict();

/**
 * Servidor MCP que o fluxo cita, por nome. `pacote` e `host` só ajudam a achar
 * o equivalente: nunca são lidos como comando, e o pacote não traz caminho,
 * argumento, variável de ambiente nem cabeçalho.
 */
const ServidorRequerido = z
  .object({
    nome: z.string().min(1),
    pacote: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    /** O serviço do catálogo a que ele pertence, quando é de um. */
    conexao: z.string().min(1).optional(),
  })
  .strict();

const SkillRequerida = z.object({ nome: z.string().min(1) }).strict();

/** A skill que o pacote leva: o texto passa pela mesma limpeza do resto, e o nome é o de uma skill do Locum. */
export const NOME_DE_SKILL = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const TETO_DO_CORPO_DA_SKILL = 64 * 1024;
export const TETO_DA_DESCRICAO_DA_SKILL = 2000;
const SkillDoPacote = z.object({ nome: z.string().regex(NOME_DE_SKILL), descricao: z.string().max(TETO_DA_DESCRICAO_DA_SKILL).refine((d) => d.trim().length > 0, "a skill precisa de uma descrição"), corpo: z.string().max(TETO_DO_CORPO_DA_SKILL) }).strict();
export type SkillDoPacote = z.infer<typeof SkillDoPacote>;

const ProvedorRequerido = z.object({ provedor: z.string().min(1), modelos: z.array(z.string().min(1)) }).strict();

/** O que a exportação deixou de fora de propósito, para a prévia pedir à pessoa. */
export const CodigoOmitido = z.enum(["canais", "gatilho-sem-canal", "filtros-de-pessoa", "dono-do-github", "tracker", "argumentos", "texto-limpo", "url-a-preencher", "escrita-removida", "chats-a-escolher", "destino-a-escolher", "skill-ausente", "passo-a-revisar", "skill-nao-levada"]);
export type CodigoOmitido = z.infer<typeof CodigoOmitido>;
const Omitido = z
  .object({
    codigo: CodigoOmitido,
    onde: z.string().min(1),
    quantos: z.number().int().positive().optional(),
    /** Os params que ficaram de fora, por nome (`args.token` dentro de um param composto). */
    params: z.array(z.string().min(1)).optional(),
    /** Por que, quando o código não basta: a skill que não foi no pacote diz se era grande demais, de nome inválido, sem descrição ou ilegível. */
    motivo: z.string().min(1).optional(),
  })
  .strict();

export const Pacote = z
  .object({
    formato: z.literal(NOME_DO_FORMATO),
    versao: z.number().int().refine((v) => VERSOES_LIDAS.includes(v), "versão do formato desconhecida"),
    automacao: z
      .object({
        id: IdDoPacote,
        spec: SpecDoPacote,
        gatilhos: z.array(GatilhoDoPacote).max(20),
      })
      .strict(),
    agents: z.array(AgentDoPacote).max(50),
    requisitos: z
      .object({
        conexoes: z.array(ConexaoRequerida),
        servidores: z.array(ServidorRequerido),
        provedores: z.array(ProvedorRequerido),
        skills: z.array(SkillRequerida).default([]),
      })
      .strict(),
    /** O conteúdo das skills citadas, quando a máquina de origem tinha. Pacote da versão 1 não traz. */
    skills: z.array(SkillDoPacote).max(50).default([]),
    omitidos: z.array(Omitido).default([]),
  })
  .strict();
export type Pacote = z.infer<typeof Pacote>;
export type PassoDoPacote = z.infer<typeof Passo>;

/* --------------------------------------------------------------- leitura */

/** O arquivo não serve, e a mensagem diz por quê em palavras de quem importa. */
export class PacoteInvalidoError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "PacoteInvalidoError";
  }
}

function caminho(path: readonly PropertyKey[]): string {
  return path.map(String).join(".");
}

function problemas(erro: z.ZodError): string {
  const frases = erro.issues.slice(0, 4).map((i) => {
    const onde = caminho(i.path);
    if (i.code === "unrecognized_keys") {
      return `campo desconhecido ${i.keys.map((k) => `"${k}"`).join(", ")}${onde === "" ? "" : ` em ${onde}`}`;
    }
    return `${onde === "" ? "arquivo" : onde}: ${i.message}`;
  });
  const resto = erro.issues.length - frases.length;
  return resto > 0 ? `${frases.join("; ")}; e mais ${resto}` : frases.join("; ");
}

/**
 * Lê o texto de um pacote. Só `JSON.parse` e validação: o arquivo é dado, e
 * nada dele passa por `eval`, `import` ou shell. A versão é conferida antes do
 * resto, porque um formato novo falharia em vários campos e a causa é uma só.
 */
export function lerPacote(texto: string): Pacote {
  if (Buffer.byteLength(texto) > TAMANHO_MAXIMO_DO_PACOTE) {
    throw new PacoteInvalidoError("o arquivo é grande demais para ser um pacote do Locum");
  }
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch {
    throw new PacoteInvalidoError("o arquivo não é um JSON válido");
  }
  if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) {
    throw new PacoteInvalidoError("o arquivo não é um pacote do Locum");
  }
  const cabecalho = bruto as { formato?: unknown; versao?: unknown };
  if (cabecalho.formato !== NOME_DO_FORMATO) throw new PacoteInvalidoError("o arquivo não é um pacote do Locum");
  if (typeof cabecalho.versao !== "number" || !VERSOES_LIDAS.includes(cabecalho.versao)) {
    throw new PacoteInvalidoError(
      `o pacote usa a versão ${String(cabecalho.versao)} do formato e este Locum lê a ${VERSAO_DO_FORMATO}. ` +
        "Atualize o Locum, ou peça um pacote exportado por esta versão.",
    );
  }
  const lido = Pacote.safeParse(bruto);
  if (!lido.success) throw new PacoteInvalidoError(`pacote inválido: ${problemas(lido.error)}`);
  conferirReferencias(lido.data);
  return lido.data;
}

/** O que o esquema não vê: ids repetidos, agent citado que não veio e ciclo entre passos. */
function conferirReferencias(pacote: Pacote): void {
  const ids = new Set<string>();
  for (const agent of pacote.agents) {
    if (ids.has(agent.id)) throw new PacoteInvalidoError(`pacote inválido: o agent "${agent.id}" aparece duas vezes`);
    ids.add(agent.id);
  }
  for (const passo of pacote.automacao.spec.steps) {
    if (passo.type === "model" && passo.profile !== undefined && !ids.has(passo.profile)) {
      throw new PacoteInvalidoError(`pacote inválido: o passo "${passo.key}" usa o agent "${passo.profile}", que não está no pacote`);
    }
  }
  try {
    topoSort(pacote.automacao.spec.steps as Step[]);
  } catch (erro) {
    throw new PacoteInvalidoError(`pacote inválido: ${erro instanceof Error ? erro.message : String(erro)}`);
  }
}
