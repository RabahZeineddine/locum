import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch())`;

/* ---------------------------------------------------------------- agents */

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /**
   * Iniciativa dona deste agent, quando ligado a uma. Sem `.references()` de
   * proposito: `drizzle-kit generate` recria a tabela inteira para adicionar
   * uma coluna com chave estrangeira, e um `agents` com dado de verdade nao
   * pode passar por isso. Fica so a coluna nula, e a referencia e garantida
   * pelo servico.
   */
  initiativeId: text("initiative_id"),
  createdAt: integer("created_at").notNull().default(now),
});

/**
 * Versao imutavel. Toda gravacao na UI cria uma linha nova, e todo run aponta
 * para a versao exata que executou. E o que permite abrir um run antigo e ver
 * o pipeline como ele era.
 */
export const agentVersions = sqliteTable(
  "agent_versions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull().references(() => agents.id),
    version: integer("version").notNull(),
    /** AgentSpec serializado. Validado por zod na leitura. */
    spec: text("spec", { mode: "json" }).notNull(),
    note: text("note"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("agent_versions_unq").on(t.agentId, t.version)],
);

export const triggers = sqliteTable("triggers", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull().references(() => agents.id),
  /** schedule | webhook | poll | mcp-poll */
  kind: text("kind").notNull(),
  config: text("config", { mode: "json" }).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});

/* ---------------------------------------------------------------- eventos */

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    /** Chave de deduplicacao vinda da origem. Ex: pr:482:sha:abc123 */
    externalId: text("external_id").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    receivedAt: integer("received_at").notNull().default(now),
  },
  (t) => [uniqueIndex("events_external_unq").on(t.source, t.externalId)],
);

/**
 * Janela de varredura por fonte. Cursor, nunca intervalo: intervalo morre
 * quando o Mac dorme e a janela e perdida.
 */
export const cursors = sqliteTable(
  "cursors",
  {
    source: text("source").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("cursors_unq").on(t.source, t.key)],
);

/* --------------------------------------------------------------- execucao */

/** queued | running | paused | done | failed | cancelled */
export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    agentVersionId: text("agent_version_id").notNull().references(() => agentVersions.id),
    triggerId: text("trigger_id"),
    eventId: text("event_id").references(() => events.id),
    /** Mesmo motivo da coluna igual em `agents`: sem `.references()`. */
    initiativeId: text("initiative_id"),
    status: text("status").notNull().default("queued"),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
    /** Dinheiro de verdade. Passo em assinatura nao entra aqui. */
    costUsd: real("cost_usd").notNull().default(0),
    /** Inclui o equivalente estimado do que rodou na assinatura. */
    estimateUsd: real("estimate_usd").notNull().default(0),
    /**
     * Tokens dos passos cobrados. É o que o teto em tokens mede, e existe
     * porque modelo sem preço cadastrado custaria zero para sempre.
     */
    tokens: integer("tokens").notNull().default(0),
    error: text("error"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("runs_status_idx").on(t.status)],
);

/** pending | running | done | failed | skipped | awaiting_approval */
export const steps = sqliteTable(
  "steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id),
    idx: integer("idx").notNull(),
    stepKey: text("step_key").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    modelRequested: text("model_requested"),
    modelUsed: text("model_used"),
    substitutionReason: text("substitution_reason"),
    /** [{ nome, origem, hash }]. Sem o hash a metrica mente. */
    skillsUsed: text("skills_used", { mode: "json" }),
    toolsUsed: text("tools_used", { mode: "json" }),
    input: text("input", { mode: "json" }),
    output: text("output", { mode: "json" }),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    /** Nulo quando o provedor não informa, que é diferente de cache nenhum. */
    cacheReadTokens: integer("cache_read_tokens"),
    costUsd: real("cost_usd").notNull().default(0),
    /** false quando rodou na assinatura: consome cota, nao dinheiro. */
    billable: integer("billable", { mode: "boolean" }).notNull().default(true),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
    error: text("error"),
  },
  (t) => [uniqueIndex("steps_run_key_unq").on(t.runId, t.stepKey)],
);

/* -------------------------------------------------------------- aprovacao */

/** pending | approved | rejected | expired | auto | conflict */
export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id),
    stepId: text("step_id").notNull().references(() => steps.id),
    /** github.review_comment | slack.post | jira.create ... */
    kind: text("kind").notNull(),
    /** Exatamente o que sairia se aprovado. */
    payload: text("payload", { mode: "json" }).notNull(),
    status: text("status").notNull().default("pending"),
    /**
     * Gravado antes de chamar a API externa. Retry depois de crash nao
     * comenta duas vezes.
     */
    externalId: text("external_id"),
    decidedAt: integer("decided_at"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("approvals_status_idx").on(t.status)],
);

/* ------------------------------------------------ achados e aprendizagem */

export const findings = sqliteTable(
  "findings",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull().references(() => runs.id),
    /** critical | high | medium | low */
    severity: text("severity").notNull(),
    category: text("category"),
    file: text("file"),
    line: integer("line"),
    body: text("body").notNull(),
    /** open | posted | dismissed */
    state: text("state").notNull().default("open"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("findings_run_idx").on(t.runId)],
);

/**
 * Preenchido pelo reconciliador quando o PR fecha. E o gabarito: o que
 * humano confirmou, o que virou commit, o que ninguem olhou.
 */
export const findingOutcomes = sqliteTable("finding_outcomes", {
  id: text("id").primaryKey(),
  findingId: text("finding_id").notNull().references(() => findings.id),
  /** confirmed_by_human | became_commit | ignored | disputed | duplicate */
  state: text("state").notNull(),
  evidence: text("evidence", { mode: "json" }),
  detectedAt: integer("detected_at").notNull().default(now),
});

/** O que revisores humanos disseram. Serve de gabarito e de corpus. */
export const reviewSignals = sqliteTable(
  "review_signals",
  {
    id: text("id").primaryKey(),
    prKey: text("pr_key").notNull(),
    author: text("author").notNull(),
    /** comment | change_request | suggestion */
    kind: text("kind").notNull(),
    file: text("file"),
    line: integer("line"),
    body: text("body").notNull(),
    becameCommit: integer("became_commit", { mode: "boolean" }),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("review_signals_pr_idx").on(t.prKey)],
);

export const agentMetrics = sqliteTable("agent_metrics", {
  id: text("id").primaryKey(),
  agentVersionId: text("agent_version_id").notNull().references(() => agentVersions.id),
  /** Conjunto de skills junto da versao, senao a comparacao mente. */
  skillSet: text("skill_set", { mode: "json" }),
  windowStart: integer("window_start").notNull(),
  windowEnd: integer("window_end").notNull(),
  findingCount: integer("finding_count").notNull().default(0),
  precision: real("precision"),
  agreement: real("agreement"),
  missed: integer("missed").notNull().default(0),
});

/* --------------------------------------------- provedores, mcp, orcamento */

export const providers = sqliteTable("providers", {
  id: text("id").primaryKey(),
  /** anthropic | openai | google | openai-compatible | claude-code */
  kind: text("kind").notNull(),
  /**
   * Como o provedor cadastrado se chama para quem administra.
   *
   * Nulo nas linhas que existem só para apontar credencial de provedor fixo:
   * o nome delas está no código, e repeti-lo aqui criaria duas versões da
   * mesma coisa.
   */
  label: text("label"),
  baseUrl: text("base_url"),
  /** Chave no keychain, nunca o segredo. */
  credentialRef: text("credential_ref"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});

/** Local da maquina. Nao vai para o git. */
export const modelFallbacks = sqliteTable(
  "model_fallbacks",
  {
    id: text("id").primaryKey(),
    machineId: text("machine_id").notNull(),
    fromModel: text("from_model").notNull(),
    toModel: text("to_model").notNull(),
    order: integer("order").notNull().default(0),
  },
  (t) => [index("model_fallbacks_machine_idx").on(t.machineId, t.fromModel)],
);

export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  /** stdio | http | sse */
  transport: text("transport").notNull(),
  command: text("command", { mode: "json" }),
  /** Variaveis de ambiente do processo stdio. Segredo vai por credentialRef. */
  env: text("env", { mode: "json" }),
  url: text("url"),
  headers: text("headers", { mode: "json" }),
  credentialRef: text("credential_ref"),
  /** read | write. Cloud entra como read, configurado tambem na origem. */
  scope: text("scope").notNull().default("read"),
  idleTimeoutMs: integer("idle_timeout_ms").notNull().default(300_000),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /**
   * Última conexão que respondeu e última que falhou, de teste ou de execução.
   * Sessão web e token expiram sem aviso; isto é o que deixa a tela dizer
   * "precisa autenticar" antes de um passo quebrar por isso.
   */
  lastOkAt: integer("last_ok_at", { mode: "timestamp_ms" }),
  lastFailureAt: integer("last_failure_at", { mode: "timestamp_ms" }),
  lastError: text("last_error"),
});

/**
 * Onde a tarefa vai parar: um Jira ou um repositorio de issues do GitHub.
 *
 * Tabela propria, e nao uma linha em `mcp_servers` ou em `providers`: o que se
 * cadastra aqui nao sobe processo nem responde modelo, e a unica coisa que os
 * tres tem em comum e apontar para uma credencial do cofre.
 *
 * O `enabled` nasce ligado porque cadastrar tracker nao dispara nada sozinho:
 * quem abre tarefa e o passo de acao, que nasce em modo de aprovacao e para na
 * fila. O interruptor serve para tirar um destino de circulacao sem apagar o
 * cadastro e a chave junto.
 */
export const trackers = sqliteTable("trackers", {
  id: text("id").primaryKey(),
  /** jira | github-issues */
  kind: text("kind").notNull(),
  label: text("label").notNull(),
  baseUrl: text("base_url").notNull(),
  /** Destino padrao: chave do projeto no Jira, `dono/repo` no GitHub. */
  project: text("project"),
  /** Quem a credencial autentica. O Jira exige o e-mail junto do token. */
  account: text("account"),
  /** Chave no keychain, nunca o segredo. */
  credentialRef: text("credential_ref"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});

export const budgets = sqliteTable("budgets", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").references(() => agents.id),
  perRunUsd: real("per_run_usd"),
  perDayUsd: real("per_day_usd"),
});

export const usageDaily = sqliteTable(
  "usage_daily",
  {
    day: text("day").notNull(),
    agentId: text("agent_id").notNull(),
    costUsd: real("cost_usd").notNull().default(0),
    tokens: integer("tokens").notNull().default(0),
    runs: integer("runs").notNull().default(0),
  },
  (t) => [uniqueIndex("usage_daily_unq").on(t.day, t.agentId)],
);

/**
 * Preço por modelo, em dólar por milhão de tokens.
 *
 * Cadastrado por quem administra, e não tabelado no código: o preço muda sem
 * aviso e gateway compatível com OpenAI cobra o que quiser. Modelo sem linha
 * aqui custa zero no registro, e o orçamento dele só protege em tokens.
 */
export const modelPrices = sqliteTable(
  "model_prices",
  {
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputUsdPerMtok: real("input_usd_per_mtok").notNull(),
    outputUsdPerMtok: real("output_usd_per_mtok").notNull(),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("model_prices_unq").on(t.provider, t.model)],
);

/* --------------------------------------------------------------- ajustes */

/**
 * Preferencia da instalacao, uma linha por chave. Fica no banco em vez de num
 * arquivo proprio porque linha de comando e casca Electron sao dois processos
 * e o banco ja e o unico ponto de encontro dos dois. Ausencia de linha tem
 * significado: quer dizer que ninguem decidiu ainda.
 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull().default(now),
});

/* ------------------------------------------------------------ iniciativas */

/**
 * Iniciativa: objetivo, criterio de pronto e uma pasta de contexto
 * propria em disco. O banco guarda o fato, a pasta guarda a prosa que a
 * pessoa escreve e edita a mao.
 */
export const initiatives = sqliteTable(
  "initiatives",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    objective: text("objective").notNull(),
    doneCriteria: text("done_criteria").notNull(),
    dueAt: integer("due_at"),
    /** active | paused | done | dropped */
    status: text("status").notNull().default("active"),
    goalRef: text("goal_ref"),
    /** Onde a pasta de contexto desta iniciativa mora em disco. */
    contextPath: text("context_path").notNull(),
    /** Hash do `context.md` depois da ultima proposta aprovada. */
    contextHash: text("context_hash"),
    contextUpdatedAt: integer("context_updated_at"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [uniqueIndex("initiatives_slug_unq").on(t.slug)],
);

export const initiativeWorkspaces = sqliteTable("initiative_workspaces", {
  id: text("id").primaryKey(),
  initiativeId: text("initiative_id")
    .notNull()
    .references(() => initiatives.id, { onDelete: "cascade" }),
  repoPath: text("repo_path").notNull(),
  worktreePath: text("worktree_path"),
  branch: text("branch"),
  label: text("label"),
});

export const initiativeMcpServers = sqliteTable(
  "initiative_mcp_servers",
  {
    initiativeId: text("initiative_id")
      .notNull()
      .references(() => initiatives.id, { onDelete: "cascade" }),
    serverName: text("server_name").notNull(),
  },
  (t) => [uniqueIndex("initiative_mcp_servers_unq").on(t.initiativeId, t.serverName)],
);

/** doc | board | repo | other */
export const initiativeLinks = sqliteTable("initiative_links", {
  id: text("id").primaryKey(),
  initiativeId: text("initiative_id")
    .notNull()
    .references(() => initiatives.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  url: text("url").notNull(),
  label: text("label"),
});

/**
 * Nome unico entre todos os prompts, versionado abaixo em `prompt_versions`.
 * Iniciativa nula quando o prompt e de uso geral.
 */
export const prompts = sqliteTable("prompts", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  initiativeId: text("initiative_id").references(() => initiatives.id),
  createdAt: integer("created_at").notNull().default(now),
});

/** Versao imutavel do corpo de um prompt. Nova so quando o texto muda. */
export const promptVersions = sqliteTable(
  "prompt_versions",
  {
    id: text("id").primaryKey(),
    promptId: text("prompt_id")
      .notNull()
      .references(() => prompts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    note: text("note"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("prompt_versions_unq").on(t.promptId, t.version)],
);

/** open | ended */
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  initiativeId: text("initiative_id")
    .notNull()
    .references(() => initiatives.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").references(() => initiativeWorkspaces.id),
  /** terminal | iterm | warp */
  terminal: text("terminal").notNull(),
  nonce: text("nonce").notNull().unique(),
  status: text("status").notNull().default("open"),
  handoffPath: text("handoff_path"),
  startedAt: integer("started_at").notNull().default(now),
  endedAt: integer("ended_at"),
});
