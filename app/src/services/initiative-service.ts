import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { ApprovalGate } from "../approval/gate.js";
import { db as defaultDb, schema } from "../db/index.js";
import { AgentSpec, requiredServers } from "../config/types.js";
import { SYSTEM_CONTEXT_AGENT_SPEC, SYSTEM_CONTEXT_AGENT_VERSION_ID } from "../db/migrate.js";
import { buildGate } from "../executor/build.js";
import { ID_DE_AGENT } from "./agent-service.js";
import type { ContextUpdateMode } from "../context/proposal.js";
import { LocalFolderContextStore, type ContextStore } from "./context-store.js";
import { FALLBACK_LANGUAGE, i18nService, type I18nService, type Language } from "./i18n-service.js";
import { mcpService, type McpService } from "./mcp-service.js";
import { settingsService, type SettingsService } from "./settings-service.js";
import { translate } from "./text-service.js";

type Db = typeof defaultDb;

export type InitiativeRow = typeof schema.initiatives.$inferSelect;
export type InitiativeStatus = "active" | "paused" | "done" | "dropped";

export type InitiativeWorkspaceRow = typeof schema.initiativeWorkspaces.$inferSelect;
export type InitiativeLinkRow = typeof schema.initiativeLinks.$inferSelect;

/** A iniciativa com o que o MCP e a tela de detalhe precisam alem da linha crua. */
export interface InitiativeDetail extends InitiativeRow {
  servers: string[];
  workspaces: InitiativeWorkspaceRow[];
  links: InitiativeLinkRow[];
  agents: { id: string; name: string }[];
}

export interface InitiativeContextFile {
  slug: string;
  file: string;
  content: string | null;
  hash: string | null;
}

export interface InitiativeWorkspaceInput {
  repoPath: string;
  worktreePath?: string | null;
  branch?: string | null;
  label?: string | null;
}

export interface InitiativeLinkInput {
  kind: "doc" | "board" | "repo" | "other";
  url: string;
  label?: string | null;
}

export type Translate = (language: Language, key: string, vars?: Record<string, unknown>) => string;

/** Onde a pasta de contexto de todas as iniciativas mora nesta maquina. */
export async function initiativesRoot(settings: SettingsService = settingsService): Promise<string> {
  const env = process.env.LOCUM_INITIATIVES_DIR;
  if (env && env.length > 0) return env;
  const configurada = await settings.get("initiatives.root");
  if (configurada && configurada.length > 0) return configurada;
  return join(homedir(), "Locum", "initiatives");
}

/**
 * Cadastro de iniciativas: frente de trabalho com objetivo, pasta de contexto
 * e os servidores MCP e workspaces que ela enxerga.
 */
export class InitiativeService {
  constructor(
    private readonly db: Db = defaultDb,
    private readonly mcp: McpService = mcpService,
    private readonly i18n: I18nService = i18nService,
    private readonly settings: SettingsService = settingsService,
    private readonly t: Translate = translate,
    private readonly gate: ApprovalGate = buildGate(),
  ) {}

  async list(): Promise<InitiativeRow[]> {
    return this.db.select().from(schema.initiatives);
  }

  async get(slug: string): Promise<InitiativeRow | undefined> {
    const [linha] = await this.db.select().from(schema.initiatives).where(eq(schema.initiatives.slug, slug));
    return linha;
  }

  /**
   * Cria a iniciativa e o `context.md` inicial quando ainda nao existem. Uma
   * segunda chamada com o mesmo slug so atualiza os campos: o `context.md` e
   * da pessoa a partir da primeira gravacao, e nunca e reescrito aqui.
   */
  async upsert(input: {
    slug: string;
    title: string;
    objective: string;
    doneCriteria: string;
    dueAt?: number | null;
    goalRef?: string | null;
  }): Promise<InitiativeRow> {
    const slug = input.slug.trim();
    if (!ID_DE_AGENT.test(slug)) {
      throw new Error("identificador em minusculas, numeros e hifen, de 2 a 63 caracteres");
    }

    const existente = await this.get(slug);
    if (existente) {
      await this.db
        .update(schema.initiatives)
        .set({
          title: input.title,
          objective: input.objective,
          doneCriteria: input.doneCriteria,
          dueAt: input.dueAt ?? null,
          goalRef: input.goalRef ?? null,
          updatedAt: sql`(unixepoch())`,
        })
        .where(eq(schema.initiatives.id, existente.id));
      return (await this.get(slug))!;
    }

    const raiz = await initiativesRoot(this.settings);
    const contextPath = join(raiz, slug);
    const store = this.storeFor(contextPath);

    const jaExiste = (await store.read("context.md")) !== null;
    if (!jaExiste) {
      const preferencia = await this.i18n.getPreference();
      const idioma = preferencia ?? FALLBACK_LANGUAGE;
      const conteudo = this.t(idioma, "initiatives.contextTemplate.initial", { title: input.title });
      await store.write("context.md", conteudo);
    }

    const [inserida] = await this.db
      .insert(schema.initiatives)
      .values({
        id: randomUUID(),
        slug,
        title: input.title,
        objective: input.objective,
        doneCriteria: input.doneCriteria,
        dueAt: input.dueAt ?? null,
        goalRef: input.goalRef ?? null,
        contextPath,
      })
      .returning();
    return inserida!;
  }

  async setStatus(slug: string, status: InitiativeStatus): Promise<InitiativeRow> {
    const linha = await this.mustGet(slug);
    await this.db
      .update(schema.initiatives)
      .set({ status, updatedAt: sql`(unixepoch())` })
      .where(eq(schema.initiatives.id, linha.id));
    return (await this.get(slug))!;
  }

  /**
   * Substitui os servidores MCP que a iniciativa enxerga, validados contra o
   * cadastro. Devolve os agents ja ligados a ela (fatia 3a) que ficariam sem
   * uma ferramenta que a lista nova deixa de trazer: sem `linkAgent` ainda,
   * a lista sai sempre vazia, mas o calculo ja reage assim que o primeiro
   * agent for ligado.
   */
  async setServers(slug: string, names: string[]): Promise<{ affectedAgents: { agentId: string; name: string }[] }> {
    const linha = await this.mustGet(slug);
    const cadastrados = new Set((await this.mcp.list()).map((entrada) => entrada.config.name));
    for (const nome of names) {
      if (!cadastrados.has(nome)) throw new Error(`servidor MCP "${nome}" nao cadastrado`);
    }

    await this.db
      .delete(schema.initiativeMcpServers)
      .where(eq(schema.initiativeMcpServers.initiativeId, linha.id));
    if (names.length > 0) {
      await this.db
        .insert(schema.initiativeMcpServers)
        .values(names.map((serverName) => ({ initiativeId: linha.id, serverName })));
    }

    const ligados = await this.db.select().from(schema.agents).where(eq(schema.agents.initiativeId, linha.id));
    const afetados: { agentId: string; name: string }[] = [];
    for (const agent of ligados) {
      const [versao] = await this.db
        .select()
        .from(schema.agentVersions)
        .where(eq(schema.agentVersions.agentId, agent.id))
        .orderBy(desc(schema.agentVersions.version))
        .limit(1);
      if (!versao) continue;

      const spec = AgentSpec.safeParse(versao.spec);
      if (!spec.success) continue;

      const exigidos = new Set<string>();
      for (const passo of spec.data.steps) {
        if (passo.type !== "model") continue;
        for (const ref of passo.tools ?? spec.data.defaultTools) exigidos.add(ref.server);
        for (const servidor of passo.requiresServers) exigidos.add(servidor);
      }
      const faltando = [...exigidos].some((servidor) => !names.includes(servidor));
      if (faltando) afetados.push({ agentId: agent.id, name: agent.name });
    }

    return { affectedAgents: afetados };
  }

  /**
   * Liga um agent a esta iniciativa, ou desliga com `slug` nulo.
   *
   * Recusa ligar quando alguma ferramenta ou `requiresServers` da versao mais
   * recente do agent sai dos servidores da frente: ligar sem essa checagem
   * deixaria o agent com um passo que falha na primeira execucao, com o
   * motivo `outside_initiative`.
   */
  async linkAgent(agentId: string, slug: string | null): Promise<void> {
    const [agent] = await this.db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
    if (!agent) throw new Error(`agent "${agentId}" nao cadastrado`);

    if (slug === null) {
      await this.db.update(schema.agents).set({ initiativeId: null }).where(eq(schema.agents.id, agentId));
      return;
    }

    const linha = await this.mustGet(slug);
    const servidores = new Set(
      (
        await this.db
          .select({ serverName: schema.initiativeMcpServers.serverName })
          .from(schema.initiativeMcpServers)
          .where(eq(schema.initiativeMcpServers.initiativeId, linha.id))
      ).map((r) => r.serverName),
    );

    const [versaoRow] = await this.db
      .select()
      .from(schema.agentVersions)
      .where(eq(schema.agentVersions.agentId, agentId))
      .orderBy(desc(schema.agentVersions.version))
      .limit(1);
    if (versaoRow) {
      const spec = AgentSpec.safeParse(versaoRow.spec);
      if (spec.success) {
        const fora = requiredServers(spec.data).filter((servidor) => !servidores.has(servidor));
        if (fora.length > 0) {
          throw new Error(`agent usa servidor fora da iniciativa "${slug}": ${fora.join(", ")}`);
        }
      }
    }

    await this.db.update(schema.agents).set({ initiativeId: linha.id }).where(eq(schema.agents.id, agentId));
  }

  /** Substitui os workspaces. Caminho relativo, inexistente ou arquivo recusam. */
  async setWorkspaces(slug: string, workspaces: InitiativeWorkspaceInput[]): Promise<void> {
    const linha = await this.mustGet(slug);
    const normalizados = workspaces.map((workspace) => ({
      repoPath: this.absoluteDir(workspace.repoPath),
      worktreePath: workspace.worktreePath ? this.absoluteDir(workspace.worktreePath) : null,
      branch: workspace.branch?.trim() || null,
      label: workspace.label?.trim() || null,
    }));

    await this.db
      .delete(schema.initiativeWorkspaces)
      .where(eq(schema.initiativeWorkspaces.initiativeId, linha.id));
    if (normalizados.length > 0) {
      await this.db
        .insert(schema.initiativeWorkspaces)
        .values(normalizados.map((workspace) => ({ id: randomUUID(), initiativeId: linha.id, ...workspace })));
    }
  }

  async addLink(slug: string, link: InitiativeLinkInput): Promise<void> {
    const linha = await this.mustGet(slug);
    await this.db.insert(schema.initiativeLinks).values({
      id: randomUUID(),
      initiativeId: linha.id,
      kind: link.kind,
      url: link.url,
      label: link.label ?? null,
    });
  }

  async removeLink(slug: string, linkId: string): Promise<boolean> {
    const linha = await this.mustGet(slug);
    const removidos = await this.db
      .delete(schema.initiativeLinks)
      .where(and(eq(schema.initiativeLinks.id, linkId), eq(schema.initiativeLinks.initiativeId, linha.id)))
      .returning();
    return removidos.length > 0;
  }

  /**
   * Fato cru de cada iniciativa, para o Inicio montar a frase no idioma da
   * janela. Relogio injetavel, como em `deep-link-service.ts`, para o teste
   * fixar a data em vez de depender de `Date.now()` correndo durante o run.
   */
  async overview(
    now: () => number = Date.now,
  ): Promise<{ slug: string; title: string; status: InitiativeStatus; daysSinceUpdate: number }[]> {
    const linhas = await this.list();
    const hoje = now();
    return linhas.map((linha) => ({
      slug: linha.slug,
      title: linha.title,
      status: linha.status as InitiativeStatus,
      daysSinceUpdate: Math.floor(hoje / 1000 / 86_400 - linha.updatedAt / 86_400),
    }));
  }

  /**
   * Propoe uma mudanca no `context.md` da iniciativa pela mesma fila de
   * aprovacao de qualquer outra acao. Nao escreve nada no arquivo: so cria o
   * run pausado, o passo aguardando aprovacao e a pendencia, e devolve o id
   * dela para a tela mostrar. `context.update` grava de verdade no clique.
   *
   * `runs.started_at` ja vem marcado daqui: o agent de sistema nao chama
   * modelo nenhum, entao nao ha gasto de verdade a contar na cota do dia. Se
   * ficasse nulo, o `execute()` do executor trataria a decisao humana como o
   * primeiro passo do run e contaria um run fantasma em `usage_daily.runs`.
   */
  async proposeContextUpdate(input: {
    slug: string;
    mode: ContextUpdateMode;
    content: string;
    baseHash?: string;
    origin: string;
  }): Promise<{ approvalId: string }> {
    const linha = await this.mustGet(input.slug);
    const [versao] = await this.db
      .select({ id: schema.agentVersions.id })
      .from(schema.agentVersions)
      .where(eq(schema.agentVersions.id, SYSTEM_CONTEXT_AGENT_VERSION_ID));
    if (!versao) throw new Error(`agent do sistema "${SYSTEM_CONTEXT_AGENT_VERSION_ID}" nao encontrado`);

    const payload = {
      initiativeId: linha.id,
      slug: linha.slug,
      file: "context.md" as const,
      mode: input.mode,
      content: input.content,
      baseHash: input.baseHash,
      origin: input.origin,
    };

    const prepared = await this.gate.prepare("context.update", payload, "approve");

    const runId = randomUUID();
    const stepId = randomUUID();
    const stepName = SYSTEM_CONTEXT_AGENT_SPEC.steps[0]!.name;
    const nowSec = Math.floor(Date.now() / 1000);

    let approvalId = "";
    this.db.transaction((tx) => {
      tx.insert(schema.runs)
        .values({
          id: runId,
          agentVersionId: SYSTEM_CONTEXT_AGENT_VERSION_ID,
          eventId: null,
          triggerId: null,
          initiativeId: linha.id,
          status: "paused",
          startedAt: nowSec,
        })
        .run();
      tx.insert(schema.steps)
        .values({
          id: stepId,
          runId,
          idx: 0,
          stepKey: "propose",
          name: stepName,
          status: "awaiting_approval",
          input: prepared.payload as object,
          startedAt: nowSec,
        })
        .run();
      approvalId = this.gate.enqueue(tx, { runId, stepId, kind: "context.update", payload: prepared.payload }, prepared)
        .id;
    });

    return { approvalId };
  }

  /**
   * A iniciativa com servidores, workspaces, links e agents ligados, numa ida
   * so. Usada pelo MCP (`get_initiative`) e pela ponte, para as duas
   * superficies nao duplicarem a mesma juncao.
   */
  async detail(slug: string): Promise<InitiativeDetail | undefined> {
    const linha = await this.get(slug);
    if (!linha) return undefined;

    const [servers, workspaces, links, agents] = await Promise.all([
      this.db
        .select({ serverName: schema.initiativeMcpServers.serverName })
        .from(schema.initiativeMcpServers)
        .where(eq(schema.initiativeMcpServers.initiativeId, linha.id)),
      this.db.select().from(schema.initiativeWorkspaces).where(eq(schema.initiativeWorkspaces.initiativeId, linha.id)),
      this.db.select().from(schema.initiativeLinks).where(eq(schema.initiativeLinks.initiativeId, linha.id)),
      this.db
        .select({ id: schema.agents.id, name: schema.agents.name })
        .from(schema.agents)
        .where(eq(schema.agents.initiativeId, linha.id)),
    ]);

    return {
      ...linha,
      servers: servers.map((s) => s.serverName),
      workspaces,
      links,
      agents,
    };
  }

  /** Um arquivo da pasta de contexto, com o hash. `null` quando ele nao existe ainda. */
  async readContext(slug: string, file = "context.md"): Promise<InitiativeContextFile> {
    const linha = await this.mustGet(slug);
    const store = this.storeFor(linha.contextPath);
    const [content, hash] = await Promise.all([store.read(file), store.hash(file)]);
    return { slug, file, content, hash };
  }

  private storeFor(contextPath: string): ContextStore {
    return new LocalFolderContextStore(contextPath);
  }

  private absoluteDir(path: string): string {
    if (!isAbsolute(path)) throw new Error(`workspace precisa de caminho absoluto: "${path}"`);
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new Error(`workspace precisa ser uma pasta existente: "${path}"`);
    }
    return realpathSync(path);
  }

  private async mustGet(slug: string): Promise<InitiativeRow> {
    const linha = await this.get(slug);
    if (!linha) throw new Error(`iniciativa "${slug}" nao cadastrada`);
    return linha;
  }
}

export const initiativeService = new InitiativeService();
