import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { demoPr } from "../examples/demo-event.js";
import { alvoDoEvento } from "../executor/executor.js";
import { prReviewSpec } from "../examples/agents.js";
import { agentService } from "../services/agent-service.js";

/**
 * Uma execucao pronta, escrita direto no banco, sem chamar modelo nenhum.
 *
 * Ela existe porque a tela de execucoes precisa de execucao para provar
 * qualquer coisa, e a unica outra forma de ter uma e rodar o `demo`, que gasta
 * minutos de assinatura. O smoke roda a cada iteracao do loop: pagar um
 * pipeline inteiro para conferir se a lista desenhou seria caro e lento.
 *
 * Os numeros sao copiados da execucao verificada em `docs/estado-atual.md`, e
 * o formato de cada coluna e o mesmo que o executor grava. A diferenca entre
 * este run e um de verdade esta na origem do evento, marcada como `fixture`:
 * nada mais precisa saber que ele foi plantado.
 */

const RUN_ID = "fixture-run-pr-review";
const EVENT_ID = "fixture-event-pr-482";
const APPROVAL_ID = "fixture-approval-post";

/** Segundos desde a epoca. O fixture nasce no passado para nao parecer novo. */
const CRIADO_EM = 1_789_870_000;

const TRIAGEM = {
  category: "fix",
  scope: "Autenticacao: validacao de expiracao de token e cache de sessao.",
  risk_areas: [
    "fuso horario na comparacao de expiracao",
    "bloqueio de thread em caminho assincrono",
    "dicionario sem seguranca de concorrencia",
  ],
  sensitive_files: [
    { file: "src/Auth/TokenValidator.cs", area: "auth" },
    { file: "src/Auth/SessionCache.cs", area: "concurrency" },
  ],
  files_to_read: ["src/Auth/TokenValidator.cs", "src/Auth/SessionCache.cs"],
};

const ACHADOS = {
  verdict: "REQUEST_CHANGES",
  findings: [
    {
      file: "src/Auth/TokenValidator.cs",
      line: 41,
      severity: "critical",
      confidence: "high",
      category: "correcao",
      problem:
        "`DateTime.Now` devolve hora local e `ExpiresAt` vem em UTC. Em BRT o token so expira tres horas depois do que deveria.",
      fix: "Voltar para `DateTime.UtcNow`.",
    },
    {
      file: "src/Auth/TokenValidator.cs",
      line: 46,
      severity: "critical",
      confidence: "high",
      category: "correcao",
      problem:
        "`.Result` numa chamada assincrona trava a thread e trava de vez sob contexto de sincronizacao.",
      fix: "Manter `ValidateAsync` e aguardar `IsRevokedAsync`.",
    },
    {
      file: "src/Auth/SessionCache.cs",
      line: 23,
      severity: "high",
      confidence: "high",
      category: "concorrencia",
      problem:
        "Trocar `ConcurrentDictionary` por `Dictionary` deixa escrita simultanea corromper o balde interno.",
      fix: "Reverter para `ConcurrentDictionary`.",
    },
    {
      file: "src/Auth/SessionCache.cs",
      line: 27,
      severity: "medium",
      confidence: "high",
      category: "correcao",
      problem: "`Put` sobrescreve sessao existente sem invalidar o token anterior.",
      fix: "Invalidar a sessao antiga antes de gravar a nova.",
    },
  ],
};

const PASSOS = [
  {
    idx: 0,
    stepKey: "triage",
    name: "Triagem",
    status: "done",
    modelRequested: "claude-code/claude-sonnet-5",
    modelUsed: "claude-code/claude-sonnet-5",
    substitutionReason: null as string | null,
    skillsUsed: [
      { name: "escrita-do-time", origin: "user", hash: "a1b2c3d4" },
      { name: "dotnet", origin: "user", hash: "e5f6a7b8" },
    ],
    toolsUsed: ["Read", "Grep"],
    input: { needs: [] },
    output: TRIAGEM,
    promptTokens: 18_412,
    completionTokens: 1_106,
    costUsd: 0.21,
    duracao: 62,
    error: null as string | null,
  },
  {
    idx: 1,
    stepKey: "audit",
    name: "Auditoria",
    status: "done",
    modelRequested: "claude-code/claude-opus-5",
    modelUsed: "claude-code/claude-opus-5",
    substitutionReason: null,
    skillsUsed: [
      { name: "escrita-do-time", origin: "user", hash: "a1b2c3d4" },
      { name: "dotnet", origin: "user", hash: "e5f6a7b8" },
    ],
    toolsUsed: ["Read", "Grep", "Glob"],
    input: { needs: [TRIAGEM] },
    output: ACHADOS,
    promptTokens: 31_884,
    completionTokens: 2_940,
    costUsd: 0.72,
    duracao: 74,
    error: null,
  },
  {
    idx: 2,
    stepKey: "deploy_context",
    name: "Contexto de deploy",
    status: "skipped",
    modelRequested: null,
    modelUsed: null,
    substitutionReason: null,
    skillsUsed: null,
    toolsUsed: null,
    input: null,
    output: null,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    duracao: 0,
    error: "servidores indisponíveis: argocd",
  },
  {
    idx: 3,
    stepKey: "post",
    name: "Comentar no PR",
    status: "awaiting_approval",
    modelRequested: null,
    modelUsed: null,
    substitutionReason: null,
    skillsUsed: null,
    toolsUsed: null,
    input: { needs: [ACHADOS] },
    output: null,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    duracao: null,
    error: null,
  },
];

/**
 * Garante o run plantado e devolve o identificador dele.
 *
 * Idempotente pelos identificadores fixos: chamar de novo nao acumula linha, e
 * o smoke chama toda subida. O agent semente e gravado antes, porque o run
 * precisa apontar para uma versao existente e o banco de uma maquina nova nao
 * tem nenhuma.
 */
export async function ensureDemoRun(): Promise<string> {
  const version = await agentService.upsert(prReviewSpec, "agent semente", "human");

  const [existente] = await db.select().from(schema.runs).where(eq(schema.runs.id, RUN_ID));
  if (existente) return RUN_ID;

  await db
    .insert(schema.events)
    .values({
      id: EVENT_ID,
      source: "fixture",
      externalId: `pr:${demoPr.pull}:sha:${demoPr.headSha}`,
      payload: demoPr,
      receivedAt: CRIADO_EM,
    })
    .onConflictDoNothing();

  // Tudo rodou na assinatura, entao o cobrado e zero e o que sobra e o
  // equivalente. A soma sai dos passos para que mexer num valor la em cima nao
  // deixe o total do run mentindo.
  const equivalente = PASSOS.reduce((acc, p) => acc + p.costUsd, 0);

  await db.insert(schema.runs).values({
    id: RUN_ID,
    agentVersionId: version.id,
    eventId: EVENT_ID,
    triggerId: null,
    // Parado na fila, que e onde a execucao verificada parou: o passo de acao
    // nasce em modo de aprovacao e nada sai sem clique.
    status: "paused",
    startedAt: CRIADO_EM,
    endedAt: null,
    costUsd: 0,
    estimateUsd: equivalente,
    createdAt: CRIADO_EM,
  });

  let relogio = CRIADO_EM;
  for (const passo of PASSOS) {
    const inicio = relogio;
    const fim = passo.duracao === null ? null : inicio + passo.duracao;
    relogio = fim ?? inicio;

    await db.insert(schema.steps).values({
      id: `${RUN_ID}-${passo.stepKey}`,
      runId: RUN_ID,
      idx: passo.idx,
      stepKey: passo.stepKey,
      name: passo.name,
      status: passo.status,
      attempt: passo.status === "skipped" ? 0 : 1,
      modelRequested: passo.modelRequested,
      modelUsed: passo.modelUsed,
      substitutionReason: passo.substitutionReason,
      skillsUsed: passo.skillsUsed,
      toolsUsed: passo.toolsUsed,
      input: passo.input,
      output: passo.output,
      promptTokens: passo.promptTokens,
      completionTokens: passo.completionTokens,
      costUsd: passo.costUsd,
      // Os dois passos de modelo rodaram na assinatura, entao o dinheiro
      // cobrado e zero e o valor guardado e so o equivalente.
      billable: false,
      startedAt: inicio,
      endedAt: passo.status === "awaiting_approval" ? null : fim,
      error: passo.error,
    });
  }

  await db.insert(schema.approvals).values({
    id: APPROVAL_ID,
    runId: RUN_ID,
    stepId: `${RUN_ID}-post`,
    kind: "github.review_comment",
    // Exatamente o que sairia se alguem aprovasse, com o alvo que o executor
    // junta do evento. Sem ele a fila nao sabe de qual pull request se trata.
    // O passo parou antes de publicar, e continua assim: o fixture nao decide nada.
    payload: { ...alvoDoEvento(demoPr), ...ACHADOS },
    status: "pending",
    externalId: null,
    decidedAt: null,
    createdAt: CRIADO_EM,
  });

  return RUN_ID;
}

/** Quantos passos o fixture tem, para quem confere sem abrir o banco. */
export const DEMO_RUN_STEPS = PASSOS.length;
export const DEMO_RUN_ID = RUN_ID;
export const DEMO_APPROVAL_ID = APPROVAL_ID;
