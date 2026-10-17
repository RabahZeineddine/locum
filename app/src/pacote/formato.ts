import { z } from "zod";
import {
  ActionStep,
  AgentBudget,
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
export const VERSAO_DO_FORMATO = 1;
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

const SpecDoPacote = z
  .object({
    name: z.string().trim().min(1),
    defaultTools: z.array(ToolRef.strict()).default([]),
    skills: z.array(SkillRule.strict()).default([]),
    steps: z.array(Passo).min(1),
    budget: AgentBudget.strict().default({}),
    layout: z.record(z.string(), z.object({ x: z.number(), y: z.number() }).strict()).optional(),
  })
  .strict();

/* --------------------------------------------------------------- gatilhos */

/**
 * O gatilho sem o que é desta máquina: canais e chats, dono e autores do
 * GitHub, argumentos de consulta. A pessoa escolhe isso ao importar.
 */
const GatilhoDoPacote = z.discriminatedUnion("kind", [
  ScheduleTrigger.strict(),
  WebhookTrigger.strict(),
  CronTrigger.strict(),
  ManualTrigger.strict(),
  SlackInboxTrigger.strict(),
  SlackChannelTrigger.omit({ channels: true }).strict(),
  TeamsInboxTrigger.omit({ channels: true, chats: true, chatsPendentes: true })
    // Quantos chats restringiam o gatilho, sem os ids. Ausente é gatilho em todos os chats.
    .extend({ chatsRestritos: z.number().int().positive().optional() })
    .strict(),
  PollTrigger.omit({ owner: true, filters: true })
    .extend({ filters: PollFilters.omit({ authors: true, reviewRequested: true, teamMembers: true }).strict().optional() })
    .strict(),
  McpPollTrigger.omit({ args: true }).strict(),
]);
export type GatilhoDoPacote = z.infer<typeof GatilhoDoPacote>;

/* ----------------------------------------------------------------- agents */

const AgentDoPacote = z
  .object({
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
  })
  .strict();
export type AgentDoPacote = z.infer<typeof AgentDoPacote>;

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

const ProvedorRequerido = z.object({ provedor: z.string().min(1), modelos: z.array(z.string().min(1)) }).strict();

/** O que a exportação deixou de fora de propósito, para a prévia pedir à pessoa. */
export const CodigoOmitido = z.enum(["canais", "gatilho-sem-canal", "filtros-de-pessoa", "dono-do-github", "tracker", "argumentos", "texto-limpo", "url-a-preencher", "escrita-removida", "chats-a-escolher", "destino-a-escolher"]);
export type CodigoOmitido = z.infer<typeof CodigoOmitido>;
const Omitido = z
  .object({
    codigo: CodigoOmitido,
    onde: z.string().min(1),
    quantos: z.number().int().positive().optional(),
    /** Os params que ficaram de fora, por nome (`args.token` dentro de um param composto). */
    params: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const Pacote = z
  .object({
    formato: z.literal(NOME_DO_FORMATO),
    versao: z.literal(VERSAO_DO_FORMATO),
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
  if (cabecalho.versao !== VERSAO_DO_FORMATO) {
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
