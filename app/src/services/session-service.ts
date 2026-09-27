import { execFile } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { resolveClaudeBinary } from "../runtimes/claude-binary.js";
import { LocalFolderContextStore } from "./context-store.js";
import { LOCUM_SCHEME } from "./deep-link-service.js";
import { FALLBACK_LANGUAGE, i18nService, type I18nService, type Language } from "./i18n-service.js";
import { initiativeService, type InitiativeDetail, type InitiativeService, type Translate } from "./initiative-service.js";
import { settingsService, type SettingsService } from "./settings-service.js";
import { translate } from "./text-service.js";

type Db = typeof defaultDb;

export const TERMINALS = ["terminal", "iterm"] as const;
export type SessionTerminal = (typeof TERMINALS)[number];

const TERMINAL_KEY = "session.terminal";
const DEFAULT_TERMINAL: SessionTerminal = "terminal";

/** Nome do aplicativo que o `open -a` do macOS reconhece, por terminal. */
const TERMINAL_APP: Record<SessionTerminal, string> = {
  terminal: "Terminal",
  iterm: "iTerm",
};

/** Pasta dos artefatos derivados, que o Locum regera e ninguem edita. */
const DERIVED_DIR = ".locum";
const SESSION_PROMPT = `${DERIVED_DIR}/session.md`;
const SESSION_SETTINGS = `${DERIVED_DIR}/session-settings.json`;
const SESSION_SCRIPT = `${DERIVED_DIR}/open-session.command`;

export type Exec = (command: string, args: string[]) => Promise<void>;

export interface SessionServiceDeps {
  db: Db;
  initiatives: InitiativeService;
  i18n: I18nService;
  settings: SettingsService;
  t: Translate;
  /** Quem abre o terminal. Teste e smoke passam um espiao, nunca o de verdade. */
  exec: Exec;
  resolveClaude: () => Promise<string | undefined>;
  now: () => number;
}

export interface SessionPlan {
  sessionId: string;
  /** Pasta de contexto da iniciativa, ja resolvida por `realpath`. */
  folder: string;
  /** Onde a sessao comeca: worktree, senao repositorio, senao a pasta de contexto. */
  cwd: string;
  workspaceId: string | null;
  /** Relativo a pasta de contexto. */
  handoffFile: string;
  prompt: string;
  settings: { permissions: { deny: string[] } };
  script: string;
  claude: string | null;
  deepLink: string;
  nonce: string;
}

export interface OpenedSession {
  sessionId: string;
  terminal: SessionTerminal;
  scriptPath: string;
  cwd: string;
  /** false quando o `claude` nao foi achado e o script usa o do PATH do terminal. */
  claudeFound: boolean;
}

/**
 * Aspas simples de shell: nada dentro delas e interpretado, e a propria aspa
 * simples sai da string, entra escapada e volta.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Regras de `deny` do Claude Code para caminho absoluto.
 *
 * Numa regra, `/caminho` e relativo ao arquivo de settings e `~/` ao home; so
 * `//caminho` e a raiz do disco. Por isso o `//` na frente do caminho que ja
 * vem absoluto.
 */
export function denyRules(folder: string): string[] {
  const absoluto = `/${folder}`;
  return [
    `Edit(${absoluto}/context.md)`,
    `Write(${absoluto}/context.md)`,
    `Edit(${absoluto}/${DERIVED_DIR}/**)`,
    `Write(${absoluto}/${DERIVED_DIR}/**)`,
  ];
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * O texto do `session.md`, so com chaves de `session.prompt.*`.
 *
 * Nenhuma frase mora aqui: o `check-i18n` nao olha `src/`, entao a guarda de
 * texto cravado e o teste que confere cada linha contra o dicionario.
 */
export function renderSessionPrompt(
  t: Translate,
  language: Language,
  input: { initiative: InitiativeDetail; folder: string; handoffFile: string },
): string {
  const { initiative, folder, handoffFile } = input;
  const k = (key: string, vars?: Record<string, unknown>) => t(language, `session.prompt.${key}`, vars);

  const partes: string[] = [
    k("intro", { title: initiative.title, slug: initiative.slug }),
    k("objective", { objective: initiative.objective }),
    k("doneCriteria", { doneCriteria: initiative.doneCriteria }),
  ];
  if (initiative.dueAt !== null) partes.push(k("dueAt", { date: isoDate(initiative.dueAt * 1000) }));

  if (initiative.workspaces.length > 0) {
    const itens = initiative.workspaces.map((w) => {
      const caminho = w.worktreePath ?? w.repoPath;
      return w.branch ? k("workspaceWithBranch", { path: caminho, branch: w.branch }) : k("workspace", { path: caminho });
    });
    partes.push([k("workspacesTitle"), ...itens].join("\n"));
  }

  if (initiative.links.length > 0) {
    const itens = initiative.links.map((l) =>
      l.label ? k("linkWithLabel", { label: l.label, url: l.url }) : k("link", { url: l.url }),
    );
    partes.push([k("linksTitle"), ...itens].join("\n"));
  }

  partes.push(k("context", { file: join(folder, "context.md") }));
  partes.push(k("handoff", { file: join(folder, handoffFile) }));
  return `${partes.join("\n\n")}\n`;
}

function renderScript(input: {
  cwd: string;
  claude: string | null;
  folder: string;
  deepLink: string;
}): string {
  const promptPath = join(input.folder, SESSION_PROMPT);
  const settingsPath = join(input.folder, SESSION_SETTINGS);
  // O prompt nunca e interpolado: entra por `$(cat ...)`, entre aspas duplas,
  // e o que ele tiver de `$`, crase ou aspa chega ao `claude` como texto.
  return [
    "#!/bin/sh",
    `cd ${shellQuote(input.cwd)} || exit 1`,
    [
      shellQuote(input.claude ?? "claude"),
      "--add-dir",
      shellQuote(input.folder),
      "--settings",
      shellQuote(settingsPath),
      "--append-system-prompt",
      `"$(cat ${shellQuote(promptPath)})"`,
    ].join(" "),
    `open ${shellQuote(input.deepLink)}`,
    "",
  ].join("\n");
}

function defaultExec(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (erro) => (erro ? reject(erro) : resolve()));
  });
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Sessao do Claude no terminal com o contexto de uma iniciativa, e a volta
 * dela para a fila de aprovacao.
 *
 * Abrir regera os artefatos em `.locum/` e manda o terminal rodar o script. A
 * sessao nao escreve no `context.md` (as regras de `deny` barram): ela deixa
 * uma passagem em `handoffs/`, e ler a passagem vira uma proposta `append`,
 * que so muda o contexto depois do clique na revisao.
 */
export class SessionService {
  private readonly deps: SessionServiceDeps;

  constructor(deps: Partial<SessionServiceDeps> = {}) {
    this.deps = {
      db: defaultDb,
      initiatives: initiativeService,
      i18n: i18nService,
      settings: settingsService,
      t: translate,
      exec: defaultExec,
      resolveClaude: () => resolveClaudeBinary(),
      now: Date.now,
      ...deps,
    };
  }

  async terminal(): Promise<SessionTerminal> {
    const gravado = await this.deps.settings.get(TERMINAL_KEY);
    return (TERMINALS as readonly string[]).includes(gravado ?? "") ? (gravado as SessionTerminal) : DEFAULT_TERMINAL;
  }

  async setTerminal(value: SessionTerminal): Promise<SessionTerminal> {
    if (!(TERMINALS as readonly string[]).includes(value)) {
      throw new Error(`terminal desconhecido: "${value}"`);
    }
    await this.deps.settings.set(TERMINAL_KEY, value);
    return value;
  }

  /** Monta tudo que a sessao precisa, sem gravar nada nem abrir terminal. */
  async plan(slug: string, options: { workspaceId?: string } = {}): Promise<SessionPlan> {
    const initiative = await this.deps.initiatives.detail(slug);
    if (!initiative) throw new Error(`iniciativa "${slug}" nao cadastrada`);

    mkdirSync(initiative.contextPath, { recursive: true });
    const folder = realpathSync(initiative.contextPath);

    const workspace =
      options.workspaceId === undefined
        ? initiative.workspaces[0]
        : initiative.workspaces.find((w) => w.id === options.workspaceId);
    if (options.workspaceId !== undefined && workspace === undefined) {
      throw new Error(`workspace "${options.workspaceId}" nao pertence a iniciativa "${slug}"`);
    }
    const cwd = workspace ? (workspace.worktreePath ?? workspace.repoPath) : folder;

    const sessionId = randomUUID();
    const nonce = randomBytes(24).toString("base64url");
    const handoffFile = `handoffs/${isoDate(this.deps.now())}-${sessionId.slice(0, 8)}.md`;
    const deepLink = `${LOCUM_SCHEME}://session/ended?session=${sessionId}&token=${nonce}`;
    const claude = (await this.deps.resolveClaude()) ?? null;

    const language = (await this.deps.i18n.getPreference()) ?? FALLBACK_LANGUAGE;
    const prompt = renderSessionPrompt(this.deps.t, language, { initiative, folder, handoffFile });

    return {
      sessionId,
      folder,
      cwd,
      workspaceId: workspace?.id ?? null,
      handoffFile,
      prompt,
      settings: { permissions: { deny: denyRules(folder) } },
      script: renderScript({ cwd, claude, folder, deepLink }),
      claude,
      deepLink,
      nonce,
    };
  }

  /** Grava os artefatos, registra a sessao e manda o terminal preferido abrir o script. */
  async open(slug: string, options: { workspaceId?: string; terminal?: SessionTerminal } = {}): Promise<OpenedSession> {
    const plano = await this.plan(slug, options);
    const terminal = options.terminal ?? (await this.terminal());
    const initiative = (await this.deps.initiatives.get(slug))!;

    const store = new LocalFolderContextStore(plano.folder);
    await store.write(SESSION_PROMPT, plano.prompt);
    await store.write(SESSION_SETTINGS, `${JSON.stringify(plano.settings, null, 2)}\n`);
    await store.write(SESSION_SCRIPT, plano.script);
    const scriptPath = join(plano.folder, SESSION_SCRIPT);
    chmodSync(scriptPath, 0o755);
    mkdirSync(join(plano.folder, "handoffs"), { recursive: true });

    await this.deps.db.insert(schema.sessions).values({
      id: plano.sessionId,
      initiativeId: initiative.id,
      // `setWorkspaces` apaga e recria os workspaces com id novo, e a chave
      // estrangeira ligada travaria a edicao depois da primeira sessao.
      workspaceId: null,
      terminal,
      nonce: plano.nonce,
      status: "open",
      handoffPath: plano.handoffFile,
      startedAt: Math.floor(this.deps.now() / 1000),
    });

    await this.deps.exec("open", ["-a", TERMINAL_APP[terminal], scriptPath]);

    return { sessionId: plano.sessionId, terminal, scriptPath, cwd: plano.cwd, claudeFound: plano.claude !== null };
  }

  /**
   * O fim da sessao, avisado pelo `locum://session/ended`. O nonce vale uma vez
   * so: quem chama depois do primeiro, ou com outro nonce, recebe `false`.
   */
  async finish(sessionId: string, token: string): Promise<boolean> {
    const [linha] = await this.deps.db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    if (!linha || linha.status !== "open" || !sameSecret(linha.nonce, token)) return false;

    const fechadas = await this.deps.db
      .update(schema.sessions)
      .set({ status: "ended", endedAt: Math.floor(this.deps.now() / 1000) })
      .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.status, "open")))
      .returning({ id: schema.sessions.id });
    return fechadas.length > 0;
  }

  /**
   * A passagem mais nova ainda nao lida vira proposta `append` no
   * `context.md`. Serve sessao aberta tambem: o deep link de fim so funciona
   * com o app empacotado, e este botao e o caminho que sempre funciona.
   * Devolve `null` quando nenhuma sessao desta iniciativa deixou passagem.
   */
  async readHandoff(slug: string): Promise<{ approvalId: string; file: string } | null> {
    const initiative = await this.deps.initiatives.get(slug);
    if (!initiative) throw new Error(`iniciativa "${slug}" nao cadastrada`);

    const candidatas = await this.deps.db
      .select()
      .from(schema.sessions)
      .where(and(eq(schema.sessions.initiativeId, initiative.id), inArray(schema.sessions.status, ["open", "ended"])))
      .orderBy(desc(schema.sessions.startedAt), desc(sql`rowid`));

    const store = new LocalFolderContextStore(initiative.contextPath);
    for (const sessao of candidatas) {
      if (!sessao.handoffPath) continue;
      const conteudo = await store.read(sessao.handoffPath);
      if (conteudo === null || conteudo.trim().length === 0) continue;

      const language = (await this.deps.i18n.getPreference()) ?? FALLBACK_LANGUAGE;
      const bloco = this.deps.t(language, "session.handoff.block", {
        file: sessao.handoffPath,
        content: conteudo.trim(),
      });
      const { approvalId } = await this.deps.initiatives.proposeContextUpdate({
        slug,
        mode: "append",
        content: bloco,
        origin: "session.handoff",
      });

      await this.deps.db
        .update(schema.sessions)
        .set({ status: "read", endedAt: sessao.endedAt ?? Math.floor(this.deps.now() / 1000) })
        .where(eq(schema.sessions.id, sessao.id));
      return { approvalId, file: sessao.handoffPath };
    }
    return null;
  }
}

export const sessionService = new SessionService();
