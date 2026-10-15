import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import {
  AgentProfile,
  AgentSpec,
  type AgentConnection,
  Toolset,
  type AgentProfileInput,
  type ToolRef,
  type ToolsetInput,
} from "../config/types.js";
import { ehLeitura, ehLeituraDa, escolhaDe, ligadaPorPadrao } from "../config/leitura.js";

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
  /** Ids das conexões que o agent alcança. */
  connections: string[];
  /** Quantas ferramentas de escrita estão ligadas nas conexões. */
  writes: number;
  skills: number;
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
  /**
   * O que o agent chama sozinho: ferramentas dos toolsets, avulsas e a leitura
   * das conexões, sem repetição.
   */
  tools: ToolRef[];
  /**
   * Escrita que o agent recebeu numa conexão. Não entra em `tools`: escrita
   * externa não roda sem alguém ver, e quem confirma é o chat do agent.
   */
  confirmar: ToolRef[];
  /** Conexões do agent sem servidor utilizável agora (não ligado, desligado ou que não listou). */
  semServidor: ConexaoIndisponivel[];
  /** Só o que vem de toolsets e ferramentas avulsas: o que o agent exige, ao contrário das conexões. */
  fixas: ToolRef[];
  /** Os servidores utilizáveis de cada conexão, para quem filtra por iniciativa. */
  grupos: { connectionId: string; servers: string[] }[];
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

/** Uma ferramenta que o servidor oferece, com o que ele anotou dela. */
export interface FerramentaDoServidor {
  name: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/** Onde a biblioteca descobre o que uma conexão alcança. */
export interface CatalogoDeConexoes {
  /** Servidores MCP da conexão, ligados ou não; vazio quando não há nenhum cadastrado. */
  servidoresDe(connectionId: string): Promise<{ nome: string; ligado: boolean }[]>;
  /** Ferramentas que o servidor oferece agora. Lança quando não dá para listar. */
  ferramentasDe(servidor: string): Promise<FerramentaDoServidor[]>;
  /** A última lista boa do servidor, sem subi-lo. Nula quando nunca listou. */
  guardadasDe?(servidor: string): Promise<FerramentaDoServidor[] | null>;
}

/** As conexões e ferramentas de verdade, carregadas só na primeira vez que alguém pede. */
const catalogoPadrao: CatalogoDeConexoes = {
  servidoresDe: async (id) => {
    const { connectionService } = await import("./connection-service.js");
    const { mcpService } = await import("./mcp-service.js");
    const nomes = (await connectionService.list()).find((c) => c.id === id)?.servers ?? [];
    return Promise.all(nomes.map(async (nome) => ({ nome, ligado: (await mcpService.get(nome))?.enabled === true })));
  },
  // A lista vem do cache da última leitura boa, e só sobe o servidor sem cache:
  // ferramenta nova ou anotação mudada entra quando alguém usa "Atualizar" na tela.
  ferramentasDe: async (servidor) => {
    const { mcpService } = await import("./mcp-service.js");
    const guardada = await mcpService.cachedTools(servidor);
    return (guardada?.tools ?? (await mcpService.listTools(servidor))).map(
      ({ name, readOnlyHint, destructiveHint }) => ({ name, readOnlyHint, destructiveHint }),
    );
  },
  guardadasDe: async (servidor) => {
    const { mcpService } = await import("./mcp-service.js");
    const guardada = await mcpService.cachedTools(servidor);
    return guardada?.tools.map(({ name, readOnlyHint, destructiveHint }) => ({ name, readOnlyHint, destructiveHint })) ?? null;
  },
};

/** Conexão do agent que não tem servidor utilizável agora, e por quê. */
export interface ConexaoIndisponivel {
  connectionId: string;
  motivo: string;
}

/** A frase de quem recusa rodar o agent com conexão sem servidor. */
export function conexoesIndisponiveis(agentId: string, lista: readonly ConexaoIndisponivel[]): string {
  return lista.map((c) => `o agent "${agentId}" usa a conexão "${c.connectionId}", ${c.motivo}`).join("; ");
}

export interface ConexoesExpandidas {
  leitura: ToolRef[];
  escrita: ToolRef[];
  /** Os servidores utilizáveis de cada conexão. */
  grupos: { connectionId: string; servers: string[] }[];
  semServidor: ConexaoIndisponivel[];
}

/**
 * Cada conexão vira as ferramentas que os servidores ligados dela oferecem
 * agora: leitura liberada (menos em servidor com mais de
 * `LIMITE_DE_LEITURA_PADRAO` leituras, que começa sem nenhuma), escrita só a
 * marcada, e a escolha por ferramenta manda nos dois lados. A classe vem da anotação do servidor, e do nome quando
 * ele não anotou. "read" na escolha manda a ferramenta para a leitura mesmo
 * classificada como escrita. Ferramenta que o servidor não oferece mais fica
 * de fora, mesmo escolhida.
 */
export async function expandirConexoes(
  conexoes: readonly AgentConnection[],
  catalogo: CatalogoDeConexoes,
): Promise<ConexoesExpandidas> {
  const saida: ConexoesExpandidas = { leitura: [], escrita: [], grupos: [], semServidor: [] };
  for (const conexao of conexoes) {
    const cadastrados = await catalogo.servidoresDe(conexao.connectionId);
    const ligados = cadastrados.filter((s) => s.ligado);
    if (ligados.length === 0) {
      saida.semServidor.push({
        connectionId: conexao.connectionId,
        motivo: cadastrados.length === 0 ? "sem servidor ligado nesta máquina" : "o servidor dela está desligado",
      });
      continue;
    }
    const usaveis: string[] = [];
    const falhas: string[] = [];
    for (const { nome: server } of ligados) {
      let oferecidas: FerramentaDoServidor[];
      try {
        oferecidas = await catalogo.ferramentasDe(server);
      } catch (erro) {
        falhas.push(`${server}: ${erro instanceof Error ? erro.message : String(erro)}`);
        continue;
      }
      usaveis.push(server);
      const leiturasDoServidor = oferecidas.filter(ehLeituraDa).length;
      for (const f of oferecidas) {
        const escolha = escolhaDe(conexao.tools, server, f.name);
        const leitura = ehLeituraDa(f);
        if (!(escolha === undefined ? ligadaPorPadrao(f, leiturasDoServidor) : escolha !== false)) continue;
        if (leitura || escolha === "read") saida.leitura.push({ server, tool: f.name, class: "read" });
        else saida.escrita.push({ server, tool: f.name, class: "external_write" });
      }
    }
    if (usaveis.length === 0) {
      saida.semServidor.push({ connectionId: conexao.connectionId, motivo: `não consegui listar as ferramentas (${falhas.join("; ")})` });
      continue;
    }
    saida.grupos.push({ connectionId: conexao.connectionId, servers: usaveis });
  }
  return saida;
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
  constructor(
    private readonly db: Db = defaultDb,
    private readonly conexoes: CatalogoDeConexoes = catalogoPadrao,
  ) {}

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
        connections: ultima.spec.connections.map((c) => c.connectionId),
        writes: await this.contarEscritaLigada(ultima.spec.connections),
        skills: ultima.spec.skills.length,
        usedBy: usos.get(perfil.id) ?? [],
      });
    }
    return lista.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * A ferramenta que a pessoa liberou numa conexão escreve? A anotação que o
   * servidor deixou no cache manda, e o nome só decide quando não há cache ou
   * a ferramenta não está nele. A chave é `servidor/ferramenta` ou só o nome.
   */
  async ehEscritaLigada(conexao: AgentConnection, chave: string): Promise<boolean> {
    const corte = chave.indexOf("/");
    const servidor = corte < 0 ? undefined : chave.slice(0, corte);
    const nome = chave.slice(corte + 1);
    const cadastrados = servidor === undefined ? await this.conexoes.servidoresDe(conexao.connectionId) : [{ nome: servidor }];
    for (const { nome: candidato } of cadastrados) {
      const guardadas = (await this.conexoes.guardadasDe?.(candidato)) ?? null;
      const achada = guardadas?.find((f) => f.name === nome);
      if (achada !== undefined) return !ehLeituraDa(achada);
    }
    return !ehLeitura(nome);
  }

  private async contarEscritaLigada(conexoes: readonly AgentConnection[]): Promise<number> {
    let total = 0;
    for (const c of conexoes) {
      for (const [chave, escolha] of Object.entries(c.tools)) {
        if (escolha === true && (await this.ehEscritaLigada(c, chave))) total += 1;
      }
    }
    return total;
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
   * somadas às avulsas e às das conexões, e o system montado. Toolset apagado depois de gravado
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
    const fixas = semRepetir(tools);
    const { leitura, escrita, grupos, semServidor } = await expandirConexoes(version.spec.connections, this.conexoes);
    tools.push(...leitura);
    const partes = [
      version.spec.context.trim() === "" ? "" : `# Contexto\n\n${version.spec.context.trim()}`,
      version.spec.instructions.trim() === "" ? "" : `# Como trabalhar\n\n${version.spec.instructions.trim()}`,
    ].filter((p) => p !== "");
    return { version, tools: semRepetir(tools), confirmar: semRepetir(escrita), semServidor, fixas, grupos, system: partes.join("\n\n") };
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
