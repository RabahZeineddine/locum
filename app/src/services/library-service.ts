import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import {
  AgentProfile,
  AgentSpec,
  Toolset,
  type AgentProfileInput,
  type ToolRef,
  type ToolsetInput,
} from "../config/types.js";

type Db = typeof defaultDb;

export interface ProfileVersion {
  id: string;
  profileId: string;
  version: number;
  spec: AgentProfile;
  note: string | null;
  createdAt: number;
}

export interface ProfileSummary {
  id: string;
  name: string;
  description: string;
  model: string;
  version: number;
  toolsets: string[];
  /** Fluxos que referenciam este agent na versão mais recente deles. */
  usedBy: string[];
}

export interface ToolsetSummary extends Toolset {
  /** Agents da biblioteca que incluem este toolset. */
  usedBy: string[];
}

/** O que o executor precisa para rodar um passo com agent da biblioteca. */
export interface ResolvedProfile {
  version: ProfileVersion;
  /** Ferramentas dos toolsets mais as avulsas, sem repetição. */
  tools: ToolRef[];
  /** Contexto e instruções juntos, prontos para o system. */
  system: string;
}

/**
 * Escrita externa não entra como ferramenta de agent: vira passo de ação, que
 * passa pela fila. O registro de MCP recusa na hora de rodar; aqui recusa na
 * hora de gravar, que é quando a pessoa ainda está olhando a tela.
 */
function recusarEscrita(tools: readonly ToolRef[], onde: string): void {
  const escrita = tools.filter((t) => t.class === "external_write");
  if (escrita.length > 0) {
    throw new Error(
      `${onde} inclui escrita externa (${escrita.map((t) => `${t.server}.${t.tool}`).join(", ")}). ` +
        "Escrita fica num nó de ação do fluxo, que passa pela fila de aprovação.",
    );
  }
}

function semRepetir(tools: readonly ToolRef[]): ToolRef[] {
  const vistos = new Map<string, ToolRef>();
  for (const t of tools) vistos.set(`${t.server}\u0000${t.tool}`, t);
  return [...vistos.values()];
}

/**
 * A biblioteca: agents reutilizáveis e os toolsets que eles usam.
 *
 * Agent da biblioteca tem versão, como o fluxo, porque a tarefa de quem o usa
 * depende das instruções dele: um run antigo precisa dizer com que versão
 * rodou. Toolset não tem, e editar vale para a próxima execução de todos.
 */
export class LibraryService {
  constructor(private readonly db: Db = defaultDb) {}

  /* --------------------------------------------------------------- agents */

  async listProfiles(): Promise<ProfileSummary[]> {
    const perfis = await this.db.select().from(schema.agentProfiles);
    const usos = await this.usosPorPerfil();
    const lista: ProfileSummary[] = [];
    for (const perfil of perfis) {
      const ultima = await this.latestProfile(perfil.id);
      if (ultima === undefined) continue;
      lista.push({
        id: perfil.id,
        name: ultima.spec.name,
        description: ultima.spec.description,
        model: ultima.spec.model,
        version: ultima.version,
        toolsets: ultima.spec.toolsets,
        usedBy: usos.get(perfil.id) ?? [],
      });
    }
    return lista.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getProfile(id: string): Promise<ProfileVersion | null> {
    return (await this.latestProfile(id)) ?? null;
  }

  async getProfileVersion(id: string, version: number): Promise<ProfileVersion | null> {
    const [row] = await this.db
      .select()
      .from(schema.agentProfileVersions)
      .where(and(eq(schema.agentProfileVersions.profileId, id), eq(schema.agentProfileVersions.version, version)));
    return row === undefined ? null : this.parse(row);
  }

  async listProfileVersions(id: string): Promise<ProfileVersion[]> {
    const rows = await this.db
      .select()
      .from(schema.agentProfileVersions)
      .where(eq(schema.agentProfileVersions.profileId, id))
      .orderBy(desc(schema.agentProfileVersions.version));
    return rows.map((r) => this.parse(r));
  }

  /**
   * Grava versão nova. Igual à anterior não grava nada, e `create` recusa id
   * que já existe, para o "novo agent" não sobrescrever outro de mesmo nome.
   */
  async saveProfile(input: { spec: AgentProfileInput; note?: string; create?: boolean }): Promise<ProfileVersion> {
    const spec = AgentProfile.parse(input.spec);
    recusarEscrita(spec.tools, `O agent "${spec.name}"`);
    const conhecidos = new Set((await this.db.select({ id: schema.toolsets.id }).from(schema.toolsets)).map((r) => r.id));
    const faltando = spec.toolsets.filter((t) => !conhecidos.has(t));
    if (faltando.length > 0) throw new Error(`toolset inexistente: ${faltando.join(", ")}`);

    const anterior = await this.latestProfile(spec.id);
    if (input.create === true && anterior !== undefined) throw new Error(`já existe um agent "${spec.id}"`);
    if (anterior !== undefined && JSON.stringify(anterior.spec) === JSON.stringify(spec)) return anterior;

    const row = this.db.transaction((tx) => {
      tx.insert(schema.agentProfiles)
        .values({ id: spec.id, name: spec.name })
        .onConflictDoUpdate({ target: schema.agentProfiles.id, set: { name: spec.name } })
        .run();
      return tx
        .insert(schema.agentProfileVersions)
        .values({
          id: randomUUID(),
          profileId: spec.id,
          version: (anterior?.version ?? 0) + 1,
          spec: spec as unknown as object,
          note: input.note?.trim() || null,
        })
        .returning()
        .get();
    });
    return this.parse(row);
  }

  /** Remove o agent e as versões. Recusa enquanto algum fluxo o usar. */
  async removeProfile(id: string): Promise<void> {
    const usos = (await this.usosPorPerfil()).get(id) ?? [];
    if (usos.length > 0) throw new Error(`o agent "${id}" está em uso em: ${usos.join(", ")}`);
    this.db.transaction((tx) => {
      tx.delete(schema.agentProfileVersions).where(eq(schema.agentProfileVersions.profileId, id)).run();
      tx.delete(schema.agentProfiles).where(eq(schema.agentProfiles.id, id)).run();
    });
  }

  /**
   * O agent pronto para rodar: versão mais recente, ferramentas dos toolsets
   * somadas às avulsas, e o system montado. Toolset apagado depois de gravado
   * falha aqui, com nome, em vez de rodar com menos ferramenta sem avisar.
   */
  async resolveProfile(id: string): Promise<ResolvedProfile> {
    const version = await this.latestProfile(id);
    if (version === undefined) throw new Error(`agent da biblioteca "${id}" não existe`);
    const tools: ToolRef[] = [];
    for (const toolsetId of version.spec.toolsets) {
      const toolset = await this.getToolset(toolsetId);
      if (toolset === null) throw new Error(`o agent "${id}" usa o toolset "${toolsetId}", que não existe mais`);
      tools.push(...toolset.tools);
    }
    tools.push(...version.spec.tools);
    const partes = [
      version.spec.context.trim() === "" ? "" : `# Contexto\n\n${version.spec.context.trim()}`,
      version.spec.instructions.trim() === "" ? "" : `# Como trabalhar\n\n${version.spec.instructions.trim()}`,
    ].filter((p) => p !== "");
    return { version, tools: semRepetir(tools), system: partes.join("\n\n") };
  }

  /** Id livre a partir do nome, como o da automação. */
  async suggestId(nome: string, tipo: "profile" | "toolset"): Promise<string> {
    const base =
      nome
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50) || (tipo === "profile" ? "agent" : "toolset");
    for (let n = 1; n < 1000; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      const existe = tipo === "profile" ? (await this.latestProfile(id)) !== undefined : (await this.getToolset(id)) !== null;
      if (!existe) return id;
    }
    throw new Error("não achei identificador livre para esse nome");
  }

  /* ------------------------------------------------------------- toolsets */

  async listToolsets(): Promise<ToolsetSummary[]> {
    const rows = await this.db.select().from(schema.toolsets);
    const perfis = await this.listProfiles();
    return rows
      .map((r) => {
        const toolset = Toolset.parse({ ...r, description: r.description ?? "" });
        return { ...toolset, usedBy: perfis.filter((p) => p.toolsets.includes(r.id)).map((p) => p.id) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getToolset(id: string): Promise<Toolset | null> {
    const [row] = await this.db.select().from(schema.toolsets).where(eq(schema.toolsets.id, id));
    return row === undefined ? null : Toolset.parse({ ...row, description: row.description ?? "" });
  }

  async saveToolset(input: { toolset: ToolsetInput; create?: boolean }): Promise<Toolset> {
    const toolset = Toolset.parse(input.toolset);
    recusarEscrita(toolset.tools, `O toolset "${toolset.name}"`);
    const existe = (await this.getToolset(toolset.id)) !== null;
    if (input.create === true && existe) throw new Error(`já existe um toolset "${toolset.id}"`);
    const valores = {
      name: toolset.name,
      description: toolset.description,
      tools: semRepetir(toolset.tools) as unknown as object,
      updatedAt: Math.floor(Date.now() / 1000),
    };
    await this.db
      .insert(schema.toolsets)
      .values({ id: toolset.id, ...valores })
      .onConflictDoUpdate({ target: schema.toolsets.id, set: valores });
    return (await this.getToolset(toolset.id))!;
  }

  async removeToolset(id: string): Promise<void> {
    const usos = (await this.listProfiles()).filter((p) => p.toolsets.includes(id)).map((p) => p.name);
    if (usos.length > 0) throw new Error(`o toolset "${id}" está em uso em: ${usos.join(", ")}`);
    await this.db.delete(schema.toolsets).where(eq(schema.toolsets.id, id));
  }

  /* -------------------------------------------------------------- interno */

  private async latestProfile(id: string): Promise<ProfileVersion | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.agentProfileVersions)
      .where(eq(schema.agentProfileVersions.profileId, id))
      .orderBy(desc(schema.agentProfileVersions.version))
      .limit(1);
    return row === undefined ? undefined : this.parse(row);
  }

  private parse(row: typeof schema.agentProfileVersions.$inferSelect): ProfileVersion {
    return {
      id: row.id,
      profileId: row.profileId,
      version: row.version,
      spec: AgentProfile.parse(row.spec),
      note: row.note,
      createdAt: row.createdAt,
    };
  }

  /** Quem usa cada agent: o passo `profile` na versão mais recente de cada fluxo. */
  private async usosPorPerfil(): Promise<Map<string, string[]>> {
    const versoes = await this.db
      .select({ agentId: schema.agentVersions.agentId, version: schema.agentVersions.version, spec: schema.agentVersions.spec })
      .from(schema.agentVersions);
    const ultima = new Map<string, { version: number; spec: unknown }>();
    for (const v of versoes) {
      const atual = ultima.get(v.agentId);
      if (atual === undefined || v.version > atual.version) ultima.set(v.agentId, v);
    }
    const usos = new Map<string, string[]>();
    for (const [agentId, { spec }] of ultima) {
      const lido = AgentSpec.safeParse(spec);
      if (!lido.success) continue;
      for (const passo of lido.data.steps) {
        if (passo.type !== "model" || passo.profile === undefined) continue;
        const lista = usos.get(passo.profile) ?? [];
        if (!lista.includes(agentId)) lista.push(agentId);
        usos.set(passo.profile, lista);
      }
    }
    return usos;
  }
}

export const libraryService = new LibraryService();
