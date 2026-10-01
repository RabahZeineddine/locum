import { unwrap } from "../sources/mcp-poll.js";
import type { TrackerAdapter, TrackerIssue, TrackerIssueDraft, TrackerProject } from "./registry.js";

/** O nome com que a vitrine cadastra o servidor oficial da Atlassian. */
export const ATLASSIAN_SERVER = "atlassian";

/** Quem chama uma ferramenta do servidor da Atlassian. Trocável no teste. */
export type AtlassianCaller = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/** Tipos de tarefa que valem como "tarefa", na ordem de preferência. */
const TIPOS_DE_TAREFA = ["task", "tarefa"];

interface ProjetoDoAtlassian {
  key?: unknown;
  name?: unknown;
  issueTypes?: { name?: unknown; subtask?: unknown }[];
}

interface TarefaDoAtlassian {
  key?: unknown;
  fields?: { summary?: unknown };
}

/** Lista no topo, ou dentro do campo que o servidor escolheu para ela. */
function lista<T>(payload: unknown, ...campos: string[]): T[] {
  if (Array.isArray(payload)) return payload as T[];
  const objeto = payload as Record<string, unknown> | null | undefined;
  for (const campo of campos) {
    const valor = objeto?.[campo];
    if (Array.isArray(valor)) return valor as T[];
  }
  return [];
}

/**
 * Jira pela conexão Atlassian, sem token próprio.
 *
 * Fala com o servidor MCP oficial da Atlassian, o mesmo que a vitrine conecta
 * por OAuth. A credencial é a dessa conexão, e por isso o cadastro do tracker
 * não pede e-mail nem token: quem já autorizou a Atlassian não deveria
 * autorizar de novo só para abrir tarefa.
 *
 * O site vai como `cloudId`. As ferramentas do servidor aceitam o endereço do
 * site no lugar do UUID, o que poupa uma ida a `getAccessibleAtlassianResources`
 * e deixa o cadastro legível para quem olha.
 */
export class JiraAtlassianAdapter implements TrackerAdapter {
  readonly kind = "jira-atlassian" as const;
  private readonly site: string;
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly call: AtlassianCaller,
  ) {
    const endereco = new URL(baseUrl);
    this.site = endereco.hostname;
    this.base = `${endereco.protocol}//${endereco.host}`;
  }

  private async pedir(tool: string, args: Record<string, unknown>): Promise<unknown> {
    return unwrap(await this.call(tool, { cloudId: this.site, ...args }));
  }

  private async projetos(searchString?: string): Promise<ProjetoDoAtlassian[]> {
    const resposta = await this.pedir("getVisibleJiraProjects", {
      action: "create",
      expandIssueTypes: searchString !== undefined,
      maxResults: 50,
      ...(searchString === undefined ? {} : { searchString }),
    });
    return lista<ProjetoDoAtlassian>(resposta, "values", "projects");
  }

  async listProjects(): Promise<TrackerProject[]> {
    return (await this.projetos())
      .filter((p): p is ProjetoDoAtlassian & { key: string } => typeof p.key === "string")
      .map((p) => ({ key: p.key, name: typeof p.name === "string" ? p.name : p.key }));
  }

  async findByPullRequest(project: string, pullRequestUrl: string): Promise<TrackerIssue | null> {
    // Mesmo JQL do adaptador por token, e pelo mesmo motivo: a aspa não pode
    // vir de fora, e um endereço de pull request não tem como conter uma.
    const jql = `project = "${project}" AND text ~ "${pullRequestUrl.replace(/"/g, "")}" ORDER BY created DESC`;
    const resposta = await this.pedir("searchJiraIssuesUsingJql", { jql, fields: ["summary"], maxResults: 50 });

    const achada = lista<TarefaDoAtlassian>(resposta, "issues")[0];
    if (typeof achada?.key !== "string") return null;
    return {
      key: achada.key,
      url: `${this.base}/browse/${achada.key}`,
      title: typeof achada.fields?.summary === "string" ? achada.fields.summary : achada.key,
    };
  }

  async createIssue(draft: TrackerIssueDraft): Promise<TrackerIssue> {
    const criada = (await this.pedir("createJiraIssue", {
      projectKey: draft.project,
      issueTypeName: await this.tipoDeTarefa(draft.project),
      summary: draft.title,
      description: `${draft.body}\n\n${draft.pullRequestUrl}`,
      contentFormat: "markdown",
      ...(draft.labels === undefined ? {} : { additional_fields: { labels: draft.labels } }),
    })) as { key?: unknown } | null;

    if (typeof criada?.key !== "string") throw new Error("o Jira criou a tarefa sem devolver a chave dela");
    return { key: criada.key, url: `${this.base}/browse/${criada.key}`, title: draft.title };
  }

  /**
   * O nome do tipo "tarefa" neste projeto.
   *
   * O adaptador por token manda `Task` fixo, e num site em português o tipo se
   * chama `Tarefa`: a criação seria recusada por um nome que só existe em
   * inglês. Aqui o servidor já devolve os tipos do projeto, então a escolha sai
   * dele, e `Task` só fica como último recurso.
   */
  private async tipoDeTarefa(project: string): Promise<string> {
    const projeto = (await this.projetos(project)).find((p) => p.key === project);
    const tipos = (projeto?.issueTypes ?? [])
      .filter((tipo) => tipo.subtask !== true && typeof tipo.name === "string")
      .map((tipo) => tipo.name as string);

    for (const preferido of TIPOS_DE_TAREFA) {
      const achado = tipos.find((nome) => nome.toLowerCase() === preferido);
      if (achado !== undefined) return achado;
    }
    return tipos[0] ?? "Task";
  }
}
