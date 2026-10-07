import { randomUUID } from "node:crypto";
import { Octokit } from "octokit";
import { and, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import type { ActionHandler } from "../approval/gate.js";
import type { ReviewFinding, ReviewVerdict } from "../config/types.js";
import type { EventPayload } from "../executor/executor.js";
import { GITHUB_TOKEN_ENV, githubService, githubToken } from "../services/github-service.js";
import { fetchCiStatus, type ChecksClient, type CiStatus } from "./ci-status.js";
import { limitDiff, type OmittedFile } from "./diff-limit.js";

export type Finding = ReviewFinding;

export type ReviewPayload = {
  owner: string;
  repo: string;
  pull: number;
  findings: Finding[];
  // Opcional porque pendência gravada antes do veredito existir continua na fila.
  verdict?: ReviewVerdict;
};

/**
 * O cliente autenticado, com o token vindo do cofre ou do ambiente.
 *
 * Quem decide de onde o token sai é o `githubToken`, e não este arquivo: a
 * mesma ordem vale para a varredura, para a ingestão e para a publicação, e
 * repetir a decisão aqui faria um desses três caminhos ficar para trás no dia
 * em que ela mudasse.
 */
export function octokit(): Octokit {
  const auth = githubToken();
  if (auth === undefined) {
    throw new Error(
      `sem token do GitHub: guarde um na configuração ou exporte ${GITHUB_TOKEN_ENV}`,
    );
  }
  return new Octokit({ auth });
}

/** O pedaço do cliente que a ação de review usa. Existe para o teste trocar. */
export type ReviewClient = { rest: { pulls: Pick<Octokit["rest"]["pulls"], "createReview" | "listReviews"> } };

export type PrContext = EventPayload & {
  owner: string;
  repoName: string;
  pull: number;
  title: string;
  description: string;
  diff: string;
  /**
   * O que ficou fora do diff e por quê.
   *
   * Opcional porque evento gravado antes do corte não tem, e reexecutar um
   * desses não pode quebrar por falta de campo.
   */
  omittedFiles?: OmittedFile[];
  omittedSummary?: string;
  /**
   * Os checks do commit de cabeça na hora da ingestão.
   *
   * Opcional pelo mesmo motivo do corte: evento antigo não tem, e a auditoria
   * lê "null" em vez de quebrar.
   */
  ci?: CiStatus;
  headSha: string;
  /**
   * Quem abriu, para onde vai e o tamanho da mudança.
   *
   * Nada disso entra no prompt: serve para a fila e para a lista de execuções
   * dizerem de que trabalho se trata sem obrigar a abrir o pull request. Uma
   * linha que diz só "PR #482" obriga a sair do aplicativo para saber se vale
   * olhar agora.
   */
  author: string;
  baseBranch: string;
  headBranch: string;
  url: string;
  additions: number;
  deletions: number;
  fileCount: number;
  draft: boolean;
};

/** O pedaço do cliente que a ingestão usa. Existe para o teste trocar. */
export type PrClient = ChecksClient & {
  rest: ChecksClient["rest"] & { pulls: Pick<Octokit["rest"]["pulls"], "get" | "listFiles"> };
};

/** O pull request como o GitHub devolve no `pulls.get`. */
type PullData = Awaited<ReturnType<Octokit["rest"]["pulls"]["get"]>>["data"];

/** Ingestao deterministica: sem LLM, sem token gasto. */
export async function fetchPr(
  owner: string,
  repo: string,
  pull: number,
  deps: { client?: PrClient; diffMaxChars?: number } = {},
): Promise<PrContext> {
  const gh = deps.client ?? octokit();
  const { data: pr } = await gh.rest.pulls.get({ owner, repo, pull_number: pull });
  return contextFromPr(gh, owner, repo, pr, deps.diffMaxChars);
}

/**
 * A parte cara da ingestão: arquivos, diff e checks.
 *
 * Separada do `pulls.get` porque a varredura precisa do commit de cabeça para
 * saber se o evento já existe, e só depois disso vale gastar a paginação dos
 * arquivos.
 */
async function contextFromPr(
  gh: PrClient,
  owner: string,
  repo: string,
  pr: PullData,
  diffMaxChars?: number,
): Promise<PrContext> {
  const pull = pr.number;
  const files = await gh.paginate(gh.rest.pulls.listFiles, { owner, repo, pull_number: pull, per_page: 100 });
  const ci = await fetchCiStatus(gh, owner, repo, pr.head.sha);

  const { diff, omittedFiles, omittedSummary } = limitDiff(
    files,
    diffMaxChars ?? (await githubService.diffMaxChars()),
  );

  return {
    repo: `${owner}/${repo}`,
    owner,
    repoName: repo,
    pull,
    title: pr.title,
    description: pr.body ?? "",
    headSha: pr.head.sha,
    changedFiles: files.map((f) => f.filename),
    diff,
    omittedFiles,
    omittedSummary,
    ci,
    author: pr.user?.login ?? "desconhecido",
    baseBranch: pr.base.ref,
    headBranch: pr.head.ref,
    url: pr.html_url,
    additions: pr.additions,
    deletions: pr.deletions,
    fileCount: files.length,
    draft: pr.draft ?? false,
  };
}

/** O pedaço do cliente que a varredura usa. Existe para o teste trocar. */
export type PollClient = PrClient & {
  rest: PrClient["rest"] & { search: Pick<Octokit["rest"]["search"], "issuesAndPullRequests"> };
};

export type PollOptions = {
  /** Rascunho fica fora por padrão: revisar o que o autor ainda não pediu é gasto sem leitor. */
  includeDrafts?: boolean;
  client?: PollClient;
  db?: typeof defaultDb;
  /** Relógio da janela inicial, para teste. */
  now?: number;
  diffMaxChars?: number;
};

/**
 * O repositório exato que o padrão descreve, quando ele descreve um só.
 *
 * Só vale para padrão ancorado nas duas pontas e sem metacaractere solto:
 * `^o/api$` vira `o/api`, mas `api` também casa com `o/api-gateway`, e pôr
 * `repo:o/api` na consulta esconderia esse outro. Ponto sem barra é "qualquer
 * caractere" e também desqualifica, pelo mesmo motivo.
 */
export function exactRepo(owner: string, filter: RegExp): string | null {
  if (filter.flags !== "") return null;
  const m = /^\^((?:[\w-]|\\[./-]|\/)+)\$$/.exec(filter.source);
  if (!m?.[1]) return null;
  const nome = m[1].replace(/\\([./-])/g, "$1");
  const [dono, repo, ...resto] = nome.split("/");
  if (dono !== owner || !repo || resto.length > 0) return null;
  return nome;
}

/** Hora completa, sem milissegundo, que é o formato que a busca do GitHub aceita. */
function searchTimestamp(iso: string): string {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Varredura por cursor. Intervalo fixo perde a janela quando o Mac dorme; o
 * cursor recupera tudo que passou, e o indice unico de evento mata duplicata.
 *
 * O `>=` com hora completa devolve de novo o último pull request da batida
 * anterior. Isso é de propósito, para não perder dois atualizados no mesmo
 * segundo, e sai barato porque a deduplicação pelo commit de cabeça acontece
 * antes de buscar arquivo e check.
 */
export async function pollOpenPullRequests(
  owner: string,
  repoFilter: RegExp,
  deps: PollOptions = {},
): Promise<string[]> {
  return (await scanOpenPullRequests(owner, repoFilter, deps)).created;
}

/** O que uma varredura do GitHub viu. */
export interface PullRequestScan {
  /**
   * Todo evento da janela, novo ou já conhecido. É a lista que o agendador
   * entrega a cada gatilho, porque "novo para a tabela" não é "novo para o
   * gatilho": dois gatilhos sobre a mesma organização dividem o cursor, e o
   * primeiro a varrer gravaria o evento que o segundo nunca receberia. O mesmo
   * vale para o evento gravado numa batida que morreu antes de criar o run.
   */
  eventIds: string[];
  /** Só os que esta varredura gravou. */
  created: string[];
}

export async function scanOpenPullRequests(
  owner: string,
  repoFilter: RegExp,
  deps: PollOptions = {},
): Promise<PullRequestScan> {
  const gh = deps.client ?? octokit();
  const db = deps.db ?? defaultDb;
  const includeDrafts = deps.includeDrafts ?? false;
  const source = "github";
  const exact = exactRepo(owner, repoFilter);

  // Cada escopo de consulta tem o próprio cursor. Com o repositório dentro da
  // consulta, um cursor dividido entre dois gatilhos avançaria pelo que um viu
  // e faria o outro pular o que ainda não tinha visto. O escopo aberto guarda
  // a chave antiga para não perder a posição de quem já varria assim.
  const scope = repoFilter.source === ".*" ? "" : `:${repoFilter.source}`;
  const key = `prs:${owner}${scope}${includeDrafts ? ":rascunhos" : ""}`;

  const [cursor] = await db
    .select()
    .from(schema.cursors)
    .where(and(eq(schema.cursors.source, source), eq(schema.cursors.key, key)));

  const since = searchTimestamp(cursor?.value ?? new Date((deps.now ?? Date.now()) - 24 * 3600 * 1000).toISOString());
  const query = [
    "is:pr",
    "is:open",
    exact ? `repo:${exact}` : `org:${owner}`,
    includeDrafts ? null : "draft:false",
    `updated:>=${since}`,
  ]
    .filter(Boolean)
    .join(" ");
  const items = await gh.paginate(gh.rest.search.issuesAndPullRequests, { q: query, per_page: 100 });

  const created: string[] = [];
  const eventIds: string[] = [];
  let newest = since;

  for (const item of items) {
    if (item.updated_at > newest) newest = item.updated_at;
    const repo = item.repository_url.split("/").pop()!;
    if (!repoFilter.test(`${owner}/${repo}`)) continue;
    if (item.draft && !includeDrafts) continue;

    const { data: pr } = await gh.rest.pulls.get({ owner, repo, pull_number: item.number });
    // Virou rascunho entre a busca e a leitura: vale o estado mais novo.
    if (pr.draft && !includeDrafts) continue;

    const externalId = `pr:${owner}/${repo}#${item.number}:sha:${pr.head.sha}`;
    const [known] = await db
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(and(eq(schema.events.source, source), eq(schema.events.externalId, externalId)));
    if (known) {
      eventIds.push(known.id);
      continue;
    }

    const ctx = await contextFromPr(gh, owner, repo, pr, deps.diffMaxChars);
    const id = randomUUID();
    const inserted = await db
      .insert(schema.events)
      .values({ id, source, externalId, payload: ctx as object })
      .onConflictDoNothing()
      .returning({ id: schema.events.id });

    if (inserted.length > 0) {
      created.push(id);
      eventIds.push(id);
    }
  }

  // Cursor avanca so depois de gravar, senao um crash no meio perde eventos.
  await db
    .insert(schema.cursors)
    .values({ source, key, value: newest })
    .onConflictDoUpdate({
      target: [schema.cursors.source, schema.cursors.key],
      set: { value: newest, updatedAt: Math.floor(Date.now() / 1000) },
    });

  return { eventIds, created };
}

/**
 * Marca invisivel no corpo do que o Locum publica. O token e pessoal, entao a
 * review automatica sai assinada pela mesma conta que revisa a mao: sem a marca
 * o reconciliador leria o proprio achado como confirmacao humana dele mesmo.
 */
export const LOCUM_MARKER = "<!-- locum -->";

/** Review ou comentario que saiu daqui. Sem a marca, conta como humano. */
export function isLocumAuthored(body: string | null | undefined): boolean {
  return typeof body === "string" && body.includes(LOCUM_MARKER);
}

const SEVERITY_MARK: Record<Finding["severity"], string> = {
  critical: "critico",
  high: "alto",
  medium: "medio",
  low: "baixo",
};

function renderBody(findings: Finding[]): string {
  if (findings.length === 0) return `Revisao automatica: nenhum achado.\n\n${LOCUM_MARKER}`;
  const corpo = findings
    .map((f) => {
      const local = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "geral";
      const fix = f.fix ? `\n\nSugestao: ${f.fix}` : "";
      return `**${local}** (${SEVERITY_MARK[f.severity]})\n\n${f.problem}${fix}`;
    })
    .join("\n\n---\n\n");
  return `${corpo}\n\n${LOCUM_MARKER}`;
}

/**
 * Handler da acao de review.
 *
 * O modo rascunho usa o proprio mecanismo do GitHub: review criada sem `event`
 * fica em estado pendente, visivel so para quem criou. Voce abre o PR, le e
 * envia. Nada publico antes disso.
 */
export function githubReviewHandler(client: () => ReviewClient = octokit): ActionHandler {
  const comments = (findings: Finding[]) =>
    findings
      .filter((f): f is Finding & { file: string; line: number } => Boolean(f.file && f.line))
      .map((f) => ({
        path: f.file,
        line: f.line,
        body: `**${SEVERITY_MARK[f.severity]}**: ${f.problem}${f.fix ? `\n\nSugestao: ${f.fix}` : ""}\n\n${LOCUM_MARKER}`,
      }));

  // A marca da ação vai no corpo, e antes de criar a review o handler procura
  // a marca no pull request. Um passo `auto` que falha depois do POST (o
  // tempo esgota com a review já criada) e é reexecutado acharia a review
  // que saiu, em vez de assinar uma segunda igual.
  const marca = (externalId: string) => `<!-- locum:${externalId} -->`;
  const jaSaiu = async (p: ReviewPayload, externalId: string): Promise<boolean> => {
    const procurada = marca(externalId);
    for (let page = 1; ; page++) {
      const { data } = await client().rest.pulls.listReviews({
        owner: p.owner,
        repo: p.repo,
        pull_number: p.pull,
        per_page: 100,
        page,
      });
      if (data.some((review) => review.body?.includes(procurada))) return true;
      if (data.length < 100) return false;
    }
  };

  return {
    // Aprovar ou pedir mudança no pull request de outra pessoa é decisão
    // assinada por quem revisa, e por isso nunca sai sem clique, nem com o
    // passo em modo automático. Só o comentário pode pular a fila.
    holdForApproval(payload) {
      return ((payload as ReviewPayload).verdict ?? "COMMENT") !== "COMMENT";
    },
    async publish(payload, externalId) {
      const p = payload as ReviewPayload & { slackChannel?: string; slackTs?: string };
      if (await jaSaiu(p, externalId)) return;
      await client().rest.pulls.createReview({
        owner: p.owner,
        repo: p.repo,
        pull_number: p.pull,
        event: p.verdict ?? "COMMENT",
        body: `${renderBody(p.findings)}\n${marca(externalId)}`,
        comments: comments(p.findings),
      });

      // Se este review veio de uma mensagem no Slack, sincroniza a reação
      if (p.slackChannel && p.slackTs) {
        try {
          const emoji = p.verdict === "APPROVE" ? "approved-5788" : p.verdict === "REQUEST_CHANGES" ? "warning" : "speech_balloon";
          const { mcpService } = await import("../services/mcp-service.js");
          const { McpRegistry } = await import("../mcp/registry.js");
          const configs = await mcpService.enabledConfigs();
          if (configs.some((c) => c.name === "slack")) {
            const reg = McpRegistry.fromList(configs);
            await reg.callTool("slack", "slack_remove_reaction", { channel_id: p.slackChannel, timestamp: p.slackTs, name: "eyes" }).catch(() => undefined);
            await reg.callTool("slack", "slack_add_reaction", { channel_id: p.slackChannel, timestamp: p.slackTs, name: emoji }).catch(() => undefined);
            await reg.closeAll();
          }
        } catch {}
      }
    },
    async draft(payload, externalId) {
      const p = payload as ReviewPayload;
      if (await jaSaiu(p, externalId)) return;
      await client().rest.pulls.createReview({
        owner: p.owner,
        repo: p.repo,
        pull_number: p.pull,
        body: `${renderBody(p.findings)}\n${marca(externalId)}`,
        comments: comments(p.findings),
      });
    },
  };
}
