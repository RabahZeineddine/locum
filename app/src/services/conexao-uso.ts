import type { AgentProfile, AgentSpec, ToolRef, Toolset } from "../config/types.js";
import { agentService } from "./agent-service.js";
import { libraryService } from "./library-service.js";

/** Como a automação ou o agent chega no servidor. */
export type ComoUsa = "ferramenta" | "exige" | "acao";

export interface UsoDaConexao {
  /** `automation` é um fluxo (spec com passos); `agent` é o da biblioteca. */
  tipo: "automation" | "agent";
  id: string;
  nome: string;
  como: ComoUsa[];
  /** A automação está arquivada: o uso é só do que está gravado nela. */
  arquivada?: true;
}

export interface FontesDeUso {
  automacoes: readonly AgentSpec[];
  /** Ids das automações arquivadas, entre as de `automacoes`. */
  arquivadas?: ReadonlySet<string>;
  agents: readonly AgentProfile[];
  toolsets: readonly Toolset[];
}

/**
 * Quem depende de um servidor MCP: as automações que o citam em
 * `requiresServers`, nas ferramentas dos passos (com a herança do agent
 * padrão) ou numa ação `mcp.call`, e os agents da biblioteca que têm
 * ferramenta dele, avulsa ou por toolset.
 *
 * Só lê o que já está gravado. O servidor que o passo cita é o nome do
 * cadastro, que é o id da conexão.
 */
export function quemUsa(servidor: string, fontes: FontesDeUso): UsoDaConexao[] {
  const uso: UsoDaConexao[] = [];

  for (const spec of fontes.automacoes) {
    const como = new Set<ComoUsa>();
    for (const passo of spec.steps) {
      if (passo.type === "model") {
        if (passo.requiresServers.includes(servidor)) como.add("exige");
        if ((passo.tools ?? spec.defaultTools).some((t) => t.server === servidor)) como.add("ferramenta");
      } else if (passo.type === "action" && passo.action === "mcp.call" && passo.params?.server === servidor) {
        como.add("acao");
      }
    }
    if (como.size > 0) uso.push({ tipo: "automation", id: spec.id, nome: spec.name, como: [...como], ...(fontes.arquivadas?.has(spec.id) ? { arquivada: true as const } : {}) });
  }

  const doToolset = new Map(fontes.toolsets.map((t) => [t.id, t.tools]));
  for (const agent of fontes.agents) {
    const ferramentas: ToolRef[] = [...agent.tools, ...agent.toolsets.flatMap((id) => doToolset.get(id) ?? [])];
    if (ferramentas.some((t) => t.server === servidor)) {
      uso.push({ tipo: "agent", id: agent.id, nome: agent.name, como: ["ferramenta"] });
    }
  }

  return uso;
}

/** O que está gravado hoje: a última versão de cada automação e de cada agent. */
export async function carregarFontesDeUso(): Promise<FontesDeUso> {
  const automacoes: AgentSpec[] = [];
  const arquivadas = new Set<string>();
  for (const linha of await agentService.list({ arquivadas: "todas" })) {
    const versao = await agentService.getLatestVersion(linha.id);
    if (versao === undefined) continue;
    automacoes.push(versao.spec);
    if (linha.archivedAt !== null) arquivadas.add(linha.id);
  }
  const agents: AgentProfile[] = [];
  for (const resumo of await libraryService.listProfiles()) {
    const versao = await libraryService.getProfile(resumo.id);
    if (versao !== null) agents.push(versao.spec);
  }
  return { automacoes, arquivadas, agents, toolsets: await libraryService.listToolsets() };
}
