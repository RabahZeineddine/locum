/**
 * Os adaptadores de tracker de tarefa.
 *
 * Voltam da versão Python, que já falava com Jira e com GitHub Issues, e
 * voltam com a mesma fronteira de antes: o adaptador sabe montar requisição e
 * ler resposta, e não sabe nada sobre quando criar tarefa. Quem decide isso é
 * o passo de ação, que nasce em modo de aprovação e para na fila.
 *
 * Os dois falam HTTP direto, sem cliente de terceiro. Não é teimosia: são três
 * rotas por serviço, e arrastar dois SDKs para dentro do processo principal
 * para isso custaria mais em tempo de subida do que economiza em código.
 */

/**
 * Os dois que existiam na versão Python, e o Jira pela conexão Atlassian.
 *
 * `jira-atlassian` não tem token próprio: fala pelo servidor MCP da Atlassian
 * que a vitrine conectou por OAuth, e o adaptador mora em `jira-atlassian.ts`.
 */
export const TRACKER_KINDS = ["jira", "jira-atlassian", "github-issues"] as const;
export type TrackerKind = (typeof TRACKER_KINDS)[number];

export function isTrackerKind(value: string): value is TrackerKind {
  return (TRACKER_KINDS as readonly string[]).includes(value);
}

/**
 * Onde a tarefa cai: projeto no Jira, repositório no GitHub.
 *
 * Os dois viram a mesma coisa de propósito. O que a tela precisa mostrar é uma
 * lista de destinos possíveis, e inventar um tipo por serviço faria a tela
 * aprender a diferença entre "projeto" e "repositório" sem ganhar nada com
 * isso.
 */
export interface TrackerProject {
  /** `ABC` no Jira, `dono/repo` no GitHub. É o que o cadastro guarda. */
  key: string;
  name: string;
}

/** Uma tarefa que já existe lá, do jeito que a procura a encontra. */
export interface TrackerIssue {
  key: string;
  url: string;
  title: string;
}

/** O que o passo de ação vai propor. Montado aqui, publicado só depois do sim. */
export interface TrackerIssueDraft {
  project: string;
  title: string;
  body: string;
  labels?: string[];
  /**
   * O pull request que originou a tarefa.
   *
   * Vai para o corpo, e é por ele que `findByPullRequest` acha o que já foi
   * criado: sem uma marca que sobreviva à edição do título, a segunda execução
   * sobre o mesmo pull request abriria uma segunda tarefa.
   */
  pullRequestUrl: string;
}

export interface TrackerAdapter {
  kind: TrackerKind;
  /** Os destinos visíveis para esta credencial. É também o teste de conexão. */
  listProjects(): Promise<TrackerProject[]>;
  /** A tarefa que já cita este pull request, ou nulo. */
  findByPullRequest(project: string, pullRequestUrl: string): Promise<TrackerIssue | null>;
  /** Cria de verdade. Só a `ApprovalGate` chega aqui, e só depois do clique. */
  createIssue(draft: TrackerIssueDraft): Promise<TrackerIssue>;
}

/** O que o adaptador precisa saber do cadastro para falar com o serviço. */
export interface TrackerConnection {
  kind: TrackerKind;
  baseUrl: string;
  /** O segredo do cofre. Nunca gravado, nunca devolvido por canal nenhum. */
  secret: string;
  /**
   * Quem o segredo autentica. O Jira exige o e-mail da conta junto do token,
   * porque a autenticação dele é básica; o GitHub não usa este campo.
   */
  account?: string | null;
}

/** Segundos antes de desistir. Tracker lento é falha de conexão, não espera. */
const TIMEOUT_MS = 15_000;

/**
 * Tira o segredo de uma mensagem antes de ela virar log ou tela.
 *
 * O texto vem de código de terceiro e de `fetch`, e nenhum dos dois prometeu
 * não repetir o cabeçalho de volta. A forma codificada entra junto porque a
 * autenticação básica do Jira manda o token em base64, e quem lesse só o valor
 * cru deixaria passar exatamente a variante que viaja.
 */
function semSegredo(texto: string, ...segredos: string[]): string {
  let limpo = texto;
  for (const segredo of segredos) {
    if (segredo.length === 0) continue;
    limpo = limpo.split(segredo).join("[credencial]");
  }
  return limpo;
}

/** Junta base e caminho sem depender de barra no fim do que alguém cadastrou. */
function endereco(baseUrl: string, caminho: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${caminho}`;
}

interface Pedido {
  method?: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  /** Para raspar da mensagem de erro, se ela chegar a existir. */
  segredos: string[];
}

async function pedir<T>(url: string, pedido: Pedido): Promise<T> {
  const { method = "GET", headers, body, segredos } = pedido;

  let resposta: Response;
  try {
    resposta = await fetch(url, {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const bruta = err instanceof Error ? err.message : String(err);
    throw new Error(semSegredo(bruta, ...segredos));
  }

  if (!resposta.ok) {
    // O corpo do erro costuma ser o único lugar que diz qual permissão falta,
    // então ele entra na mensagem. Cortado, porque alguns serviços devolvem
    // uma página inteira de HTML quando o endereço cadastrado está errado.
    const corpo = await resposta.text().catch(() => "");
    const detalhe = corpo.trim().slice(0, 200);
    throw new Error(
      semSegredo(
        detalhe.length === 0
          ? `respondeu ${resposta.status}`
          : `respondeu ${resposta.status}: ${detalhe}`,
        ...segredos,
      ),
    );
  }

  return (await resposta.json()) as T;
}

/* ------------------------------------------------------------------- jira */

interface JiraProjectPage {
  values?: { key?: string; name?: string }[];
}

interface JiraSearchPage {
  issues?: { key?: string; fields?: { summary?: string } }[];
}

/**
 * Jira Cloud, na API v3.
 *
 * A procura vai por `POST /rest/api/3/search/jql`, e não pelo `GET
 * /rest/api/3/search` que a maior parte dos exemplos antigos usa: a Atlassian
 * está removendo o segundo, e uma integração escrita hoje contra ele nasceria
 * com data de validade.
 *
 * A autenticação é básica, com o e-mail da conta e um token de API. Não é
 * escolha: o Jira Cloud não aceita o token sozinho em `Bearer`, e por isso o
 * cadastro pede o e-mail junto.
 */
class JiraAdapter implements TrackerAdapter {
  readonly kind = "jira" as const;
  private readonly cabecalho: string;
  private readonly segredos: string[];

  constructor(private readonly conexao: TrackerConnection) {
    const conta = conexao.account?.trim() ?? "";
    if (conta.length === 0) {
      throw new Error("o Jira autentica por e-mail e token, e o cadastro está sem o e-mail");
    }
    const basica = Buffer.from(`${conta}:${conexao.secret}`).toString("base64");
    this.cabecalho = `Basic ${basica}`;
    this.segredos = [conexao.secret, basica];
  }

  private get headers(): Record<string, string> {
    return { authorization: this.cabecalho, accept: "application/json" };
  }

  async listProjects(): Promise<TrackerProject[]> {
    const pagina = await pedir<JiraProjectPage>(
      endereco(this.conexao.baseUrl, "/rest/api/3/project/search?maxResults=100&orderBy=key"),
      { headers: this.headers, segredos: this.segredos },
    );
    return (pagina.values ?? [])
      .filter((projeto): projeto is { key: string; name?: string } => typeof projeto.key === "string")
      .map((projeto) => ({ key: projeto.key, name: projeto.name ?? projeto.key }));
  }

  async findByPullRequest(project: string, pullRequestUrl: string): Promise<TrackerIssue | null> {
    // O endereço do pull request entra entre aspas porque ele tem barra e dois
    // pontos, que o JQL leria como operador. A aspa em si não pode vir de fora
    // sem escape, e um endereço de pull request não tem como conter uma.
    const jql = `project = "${project}" AND text ~ "${pullRequestUrl.replace(/"/g, "")}" ORDER BY created DESC`;
    const pagina = await pedir<JiraSearchPage>(
      endereco(this.conexao.baseUrl, "/rest/api/3/search/jql"),
      {
        method: "POST",
        headers: this.headers,
        body: { jql, fields: ["summary"], maxResults: 1 },
        segredos: this.segredos,
      },
    );

    const achada = (pagina.issues ?? [])[0];
    if (achada?.key === undefined) return null;
    return {
      key: achada.key,
      url: endereco(this.conexao.baseUrl, `/browse/${achada.key}`),
      title: achada.fields?.summary ?? achada.key,
    };
  }

  async createIssue(draft: TrackerIssueDraft): Promise<TrackerIssue> {
    const criada = await pedir<{ key?: string }>(
      endereco(this.conexao.baseUrl, "/rest/api/3/issue"),
      {
        method: "POST",
        headers: this.headers,
        body: {
          fields: {
            project: { key: draft.project },
            summary: draft.title,
            issuetype: { name: "Task" },
            description: adf(`${draft.body}\n\n${draft.pullRequestUrl}`),
            ...(draft.labels === undefined ? {} : { labels: draft.labels }),
          },
        },
        segredos: this.segredos,
      },
    );

    if (criada.key === undefined) throw new Error("o Jira criou a tarefa sem devolver a chave dela");
    return {
      key: criada.key,
      url: endereco(this.conexao.baseUrl, `/browse/${criada.key}`),
      title: draft.title,
    };
  }
}

/**
 * Texto puro no formato de documento do Atlassian.
 *
 * A v3 recusa descrição em string, e o corpo que o passo monta é markdown de
 * um modelo. Converter markdown para ADF de verdade é outro projeto; um
 * parágrafo por linha preserva o que importa e não inventa estrutura errada.
 */
function adf(texto: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: texto.split("\n").map((linha) => ({
      type: "paragraph",
      content: linha.length === 0 ? [] : [{ type: "text", text: linha }],
    })),
  };
}

/* ----------------------------------------------------------- github issues */

interface GithubRepo {
  full_name?: string;
  name?: string;
}

interface GithubIssue {
  number?: number;
  html_url?: string;
  title?: string;
}

/**
 * GitHub Issues.
 *
 * O "projeto" aqui é o repositório, no formato `dono/repo`, e é o que a lista
 * devolve: o cadastro guarda uma string só, e traduzir repositório para projeto
 * na fronteira deixa o resto do app sem saber de qual serviço veio.
 *
 * A credencial é própria, e não a do source de pull request. São permissões
 * diferentes, e um token que só lê pull request não abre issue: separar os dois
 * é o que permite conceder escrita de issue sem conceder escrita em pull
 * request.
 */
class GithubIssuesAdapter implements TrackerAdapter {
  readonly kind = "github-issues" as const;
  private readonly segredos: string[];

  constructor(private readonly conexao: TrackerConnection) {
    this.segredos = [conexao.secret];
  }

  private get headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.conexao.secret}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    };
  }

  async listProjects(): Promise<TrackerProject[]> {
    const repos = await pedir<GithubRepo[]>(
      endereco(this.conexao.baseUrl, "/user/repos?per_page=100&sort=full_name"),
      { headers: this.headers, segredos: this.segredos },
    );
    return (Array.isArray(repos) ? repos : [])
      .filter((repo): repo is { full_name: string; name?: string } =>
        typeof repo.full_name === "string",
      )
      .map((repo) => ({ key: repo.full_name, name: repo.name ?? repo.full_name }));
  }

  async findByPullRequest(project: string, pullRequestUrl: string): Promise<TrackerIssue | null> {
    // `type:issue` não é detalhe: sem ele a busca devolveria o próprio pull
    // request, que cita o endereço dele mesmo, e toda execução concluiria que
    // a tarefa já existe.
    const consulta = `${pullRequestUrl} in:body repo:${project} type:issue`;
    const resposta = await pedir<{ items?: GithubIssue[] }>(
      endereco(
        this.conexao.baseUrl,
        `/search/issues?per_page=1&q=${encodeURIComponent(consulta)}`,
      ),
      { headers: this.headers, segredos: this.segredos },
    );

    const achada = (resposta.items ?? [])[0];
    if (achada?.number === undefined) return null;
    return {
      key: `${project}#${achada.number}`,
      url: achada.html_url ?? endereco(this.conexao.baseUrl, `/${project}/issues/${achada.number}`),
      title: achada.title ?? `#${achada.number}`,
    };
  }

  async createIssue(draft: TrackerIssueDraft): Promise<TrackerIssue> {
    const criada = await pedir<GithubIssue>(
      endereco(this.conexao.baseUrl, `/repos/${draft.project}/issues`),
      {
        method: "POST",
        headers: this.headers,
        body: {
          title: draft.title,
          body: `${draft.body}\n\n${draft.pullRequestUrl}`,
          ...(draft.labels === undefined ? {} : { labels: draft.labels }),
        },
        segredos: this.segredos,
      },
    );

    if (criada.number === undefined) {
      throw new Error("o GitHub criou a tarefa sem devolver o número dela");
    }
    return {
      key: `${draft.project}#${criada.number}`,
      url: criada.html_url ?? endereco(this.conexao.baseUrl, `/${draft.project}/issues/${criada.number}`),
      title: criada.title ?? draft.title,
    };
  }
}

/** O endereço de fábrica de cada tipo, para o cadastro que não quer escolher. */
export const TRACKER_DEFAULT_BASE_URL: Record<TrackerKind, string> = {
  jira: "",
  "jira-atlassian": "",
  "github-issues": "https://api.github.com",
};

export function buildTracker(conexao: TrackerConnection): TrackerAdapter {
  switch (conexao.kind) {
    case "jira":
      return new JiraAdapter(conexao);
    case "github-issues":
      return new GithubIssuesAdapter(conexao);
    case "jira-atlassian":
      // Não há segredo para montar este: a credencial é a da conexão, e quem
      // sabe chamar o servidor MCP é o `TrackerService`.
      throw new Error("o Jira pela conexão Atlassian se monta pelo TrackerService");
  }
}
