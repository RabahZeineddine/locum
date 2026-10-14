import { randomUUID } from "node:crypto";
import { Octokit } from "octokit";
import { and, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import type { ActionHandler } from "../approval/gate.js";
import type { PollFilters, ReviewFinding, ReviewVerdict } from "../config/types.js";
import type { EventPayload } from "../executor/executor.js";
import { GITHUB_TOKEN_ENV, githubService, githubToken } from "../services/github-service.js";
import { fetchCiStatus, type ChecksClient, type CiStatus } from "./ci-status.js";
import { limitDiff, type OmittedFile } from "./diff-limit.js";
import {
  avaliarArquivos,
  avaliarItem,
  avaliarPr,
  avaliarTimes,
  chaveDosFiltros,
  leitorDeTimes,
  montarConsulta,
  resolverFiltros,
  temFiltroDeArquivos,
  type ClienteDeTimes,
  type Descarte,
  type FiltrosResolvidos,
  type ItemDaBusca,
} from "./github-filtros.js";
import {
  alvoDaReacao,
  reagirNoTeams,
  soltarOPr,
  REACAO_DO_VEREDITO,
  REACAO_PEGOU,
  type TeamsReactionOptions,
} from "../teams/reaction.js";

export type Finding = ReviewFinding;

export type ReviewPayload = {
  owner: string;
  repo: string;
  pull: number;
  findings: Finding[];
  author?: string;
  // Opcional porque pendência gravada antes do veredito existir continua na fila.
  verdict?: ReviewVerdict;
};

/** O que o evento de origem deixa no payload para o review avisar de volta. */
type OrigemDoReview = {
  summary?: string;
  slackChannel?: string;
  slackTs?: string;
  channel?: string;
  ts?: string;
};

/**
 * Depois que o review saiu, avisa a mensagem de onde o pedido veio. Cada
 * origem falha sozinha e em silêncio: a reação é cortesia, e o review já saiu.
 */
async function avisarOrigem(
  p: ReviewPayload & OrigemDoReview,
  deps: { teams?: TeamsReactionOptions },
): Promise<void> {
  await reagirNoSlack(p);
  await reagirNoTeamsAoSair(p, deps.teams);
}

/** Troca 👀 pelo veredito na mensagem do Teams, com cada chamada tentada sozinha. */
async function reagirNoTeamsAoSair(p: ReviewPayload, options?: TeamsReactionOptions): Promise<void> {
  const alvo = alvoDaReacao(p);
  if (alvo === null) return;
  const emoji = REACAO_DO_VEREDITO[p.verdict ?? "COMMENT"];
  for (const [acao, reacao] of [["unset", REACAO_PEGOU], ["set", emoji]] as const) {
    try {
      await reagirNoTeams(alvo, acao, reacao, options);
    } catch (err) {
      console.error(`reagir no Teams (${acao} ${reacao}) falhou: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Se este review veio de uma mensagem no Slack, sincroniza a reação. */
async function reagirNoSlack(p: ReviewPayload & OrigemDoReview): Promise<void> {
  const canalSlack = p.slackChannel ?? p.channel;
  const tsSlack = p.slackTs ?? p.ts;
  if (canalSlack && tsSlack) {
    try {
      const emoji = p.verdict === "APPROVE" ? "white_check_mark" : p.verdict === "REQUEST_CHANGES" ? "warning" : "speech_balloon";
      const { mcpService } = await import("../services/mcp-service.js");
      const { McpRegistry } = await import("../mcp/registry.js");
      const configs = await mcpService.enabledConfigs();
      if (configs.some((c) => c.name === "slack")) {
        const reg = McpRegistry.fromList(configs);
        await reg.callTool("slack", "slack_remove_reaction", { channel_id: canalSlack, timestamp: tsSlack, name: "eyes" }).catch(() => undefined);
        await reg.callTool("slack", "slack_add_reaction", { channel_id: canalSlack, timestamp: tsSlack, name: emoji }).catch(() => undefined);
        await reg.closeAll();
      }
    } catch {}
  }
}

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
  /** `open` ou `closed`, como o GitHub devolve. */
  state?: string;
  merged?: boolean;
};

/** O pedaço do cliente que a ingestão usa. Existe para o teste trocar. */
export type PrClient = ChecksClient & {
  rest: ChecksClient["rest"] & { pulls: Pick<Octokit["rest"]["pulls"], "get" | "listFiles"> };
};

/** Um arquivo como o GitHub devolve no `pulls.listFiles`. */
type ArquivoDoPr = Awaited<ReturnType<Octokit["rest"]["pulls"]["listFiles"]>>["data"][number];

function listarArquivos(gh: PrClient, owner: string, repo: string, pull: number): Promise<ArquivoDoPr[]> {
  return gh.paginate(gh.rest.pulls.listFiles, { owner, repo, pull_number: pull, per_page: 100 });
}

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
  lidos?: ArquivoDoPr[],
): Promise<PrContext> {
  const pull = pr.number;
  const files = lidos ?? (await listarArquivos(gh, owner, repo, pull));
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
    state: pr.state,
    merged: pr.merged,
  };
}

/** O pedaço do cliente que a varredura usa. Existe para o teste trocar. */
export type PollClient = PrClient & {
  rest: PrClient["rest"] & {
    search: Pick<Octokit["rest"]["search"], "issuesAndPullRequests">;
    teams: Pick<Octokit["rest"]["teams"], "listMembersInOrg">;
  };
};

export type PollOptions = {
  /** Rascunho fica fora por padrão: revisar o que o autor ainda não pediu é gasto sem leitor. */
  includeDrafts?: boolean;
  /** Filtros do gatilho além do repositório. Ausente, a varredura não filtra nada. */
  filters?: PollFilters;
  /** A conta do token, para trocar `@me`. Nulo é "nunca conferida". */
  viewer?: string | null;
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
  /** O que a varredura viu e não virou evento, cada um com o motivo. */
  descartes?: Descarte[];
}

/** Quantos descartes uma varredura devolve; o resto some para não inchar a batida. */
const TETO_DE_DESCARTES = 200;

/** O que `examinar` decidiu sobre um pull request da busca. */
type Exame =
  | {
      entra: true;
      pr: PullData;
      repo: string;
      /** Arquivos já lidos para os filtros, para a ingestão não paginar de novo. */
      arquivos?: ArquivoDoPr[];
      /** O evento que este commit já tem, se tem. */
      conhecido?: string;
    }
  | { entra: false; descarte: Descarte };

type ContextoDoExame = {
  gh: PollClient;
  db: typeof defaultDb;
  owner: string;
  repoFilter: RegExp;
  includeDrafts: boolean;
  filtros: FiltrosResolvidos;
  membrosDe: ReturnType<typeof leitorDeTimes>;
};

function contextoDoExame(owner: string, repoFilter: RegExp, deps: PollOptions) {
  const gh = deps.client ?? octokit();
  return {
    gh,
    db: deps.db ?? defaultDb,
    owner,
    repoFilter,
    includeDrafts: deps.includeDrafts ?? false,
    // `@me` sem conta conferida estoura aqui, antes de qualquer chamada.
    filtros: resolverFiltros(deps.filters, deps.viewer ?? null),
    membrosDe: leitorDeTimes(gh as unknown as ClienteDeTimes),
  } satisfies ContextoDoExame;
}

/**
 * Decide se um pull request da busca entra, do filtro mais barato ao mais caro.
 *
 * É o único lugar onde os filtros são aplicados: a varredura grava evento com
 * o que entra e a prévia só lê, e as duas passam por aqui para dizerem a mesma
 * coisa. Nulo é pull request de outro repositório, que não é descarte e sim
 * fora do que o gatilho observa.
 */
async function examinar(ctx: ContextoDoExame, item: ItemDaBusca & { repository_url: string }): Promise<Exame | null> {
  const repo = item.repository_url.split("/").pop()!;
  if (!ctx.repoFilter.test(`${ctx.owner}/${repo}`)) return null;

  const ref = `${ctx.owner}/${repo}#${item.number}`;
  const autor = item.user?.login ?? undefined;
  const fora = (motivo: string): Exame => ({
    entra: false,
    descarte: { pr: ref, titulo: item.title, autor, url: item.html_url, motivo },
  });

  if (item.draft && !ctx.includeDrafts) return fora("draft");
  const doItem = avaliarItem(ctx.filtros, item);
  if (doItem !== null) return fora(doItem);
  const dosTimes = await avaliarTimes(ctx.filtros, autor, ctx.membrosDe);
  if (dosTimes !== null) return fora(dosTimes);

  const { data: pr } = await ctx.gh.rest.pulls.get({ owner: ctx.owner, repo, pull_number: item.number });
  // Virou rascunho entre a busca e a leitura: vale o estado mais novo.
  if (pr.draft && !ctx.includeDrafts) return fora("draft");
  const doPr = avaliarPr(ctx.filtros, pr, ctx.owner);
  if (doPr !== null) return fora(doPr);

  const externalId = `pr:${ctx.owner}/${repo}#${item.number}:sha:${pr.head.sha}`;
  const [known] = await ctx.db
    .select({ id: schema.events.id, payload: schema.events.payload })
    .from(schema.events)
    .where(and(eq(schema.events.source, "github"), eq(schema.events.externalId, externalId)));

  let arquivos: ArquivoDoPr[] | undefined;
  let nomes: string[] | undefined;
  if (temFiltroDeArquivos(ctx.filtros)) {
    // O evento já guarda a lista do commit: não vale uma ida ao GitHub por batida.
    const guardados = (known?.payload as { changedFiles?: unknown } | undefined)?.changedFiles;
    if (Array.isArray(guardados) && guardados.every((a) => typeof a === "string")) {
      nomes = guardados as string[];
    } else {
      arquivos = await listarArquivos(ctx.gh, ctx.owner, repo, item.number);
      nomes = arquivos.map((a) => a.filename);
    }
    const dosArquivos = avaliarArquivos(ctx.filtros, nomes);
    if (dosArquivos !== null) return fora(dosArquivos);
  }

  return { entra: true, pr, repo, arquivos, conhecido: known?.id };
}

export async function scanOpenPullRequests(
  owner: string,
  repoFilter: RegExp,
  deps: PollOptions = {},
): Promise<PullRequestScan> {
  const ctx = contextoDoExame(owner, repoFilter, deps);
  const { gh, db, includeDrafts } = ctx;
  const source = "github";
  const exact = exactRepo(owner, repoFilter);

  // Cada escopo de consulta tem o próprio cursor. Com o repositório dentro da
  // consulta, um cursor dividido entre dois gatilhos avançaria pelo que um viu
  // e faria o outro pular o que ainda não tinha visto. O escopo aberto guarda
  // a chave antiga para não perder a posição de quem já varria assim. O mesmo
  // vale para os filtros: sem eles a chave é a de sempre.
  const scope = repoFilter.source === ".*" ? "" : `:${repoFilter.source}`;
  const key = `prs:${owner}${scope}${includeDrafts ? ":rascunhos" : ""}${chaveDosFiltros(deps.filters)}`;

  const [cursor] = await db
    .select()
    .from(schema.cursors)
    .where(and(eq(schema.cursors.source, source), eq(schema.cursors.key, key)));

  const since = searchTimestamp(cursor?.value ?? new Date((deps.now ?? Date.now()) - 24 * 3600 * 1000).toISOString());
  const query = montarConsulta(
    [
      "is:pr",
      "is:open",
      exact ? `repo:${exact}` : `org:${owner}`,
      includeDrafts ? null : "draft:false",
      `updated:>=${since}`,
    ].filter((p): p is string => p !== null),
    ctx.filtros,
  );
  const items = await gh.paginate(gh.rest.search.issuesAndPullRequests, { q: query, per_page: 100 });

  const created: string[] = [];
  const eventIds: string[] = [];
  const descartes: Descarte[] = [];
  let newest = since;

  for (const item of items) {
    if (item.updated_at > newest) newest = item.updated_at;
    const exame = await examinar(ctx, item);
    if (exame === null) continue;
    if (!exame.entra) {
      if (descartes.length < TETO_DE_DESCARTES) descartes.push(exame.descarte);
      continue;
    }
    if (exame.conhecido !== undefined) {
      eventIds.push(exame.conhecido);
      continue;
    }

    const { pr, repo } = exame;
    const externalId = `pr:${owner}/${repo}#${item.number}:sha:${pr.head.sha}`;
    const context = await contextFromPr(gh, owner, repo, pr, deps.diffMaxChars, exame.arquivos);
    const id = randomUUID();
    const inserted = await db
      .insert(schema.events)
      .values({ id, source, externalId, payload: context as object })
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

  return { eventIds, created, descartes };
}

/** Quantos pull requests a prévia examina. */
export const TETO_DA_PREVIA = 50;

/** Um pull request da prévia: se a varredura o aceitaria agora, e por quê. */
export type PreviaDoPr = {
  /** `org/repo#123`. */
  pr: string;
  titulo: string;
  autor?: string;
  url?: string;
  entra: boolean;
  /** O motivo do descarte; para quem entra, a frase que diz isso. */
  motivo: string;
  /** Entra, mas este commit já é um evento: a varredura não grava de novo. */
  jaVirouEvento?: boolean;
};

export type PreviaDaVarredura = { itens: PreviaDoPr[]; cortada: boolean };

/**
 * O que a varredura faria agora, sem fazer.
 *
 * Passa pelo mesmo `examinar` da varredura, então a resposta é a dela. Difere
 * em três pontos de propósito: não tem janela de cursor (a prévia olha o que
 * está aberto, e não só o que mudou desde a última batida), a busca vai sem os
 * qualificadores dos filtros (quem não entra precisa aparecer com o motivo) e
 * nada é gravado: nem cursor, nem evento, nem descarte.
 */
export async function previewOpenPullRequests(
  owner: string,
  repoFilter: RegExp,
  deps: PollOptions = {},
): Promise<PreviaDaVarredura> {
  const ctx = contextoDoExame(owner, repoFilter, deps);
  const exact = exactRepo(owner, repoFilter);
  const query = ["is:pr", "is:open", exact ? `repo:${exact}` : `org:${owner}`].join(" ");
  const { data } = await ctx.gh.rest.search.issuesAndPullRequests({
    q: query,
    sort: "updated",
    order: "desc",
    per_page: TETO_DA_PREVIA,
  });

  const itens: PreviaDoPr[] = [];
  for (const item of data.items) {
    const exame = await examinar(ctx, item);
    if (exame === null) continue;
    if (!exame.entra) {
      const d = exame.descarte;
      itens.push({ pr: d.pr, titulo: d.titulo ?? "", autor: d.autor, url: d.url, entra: false, motivo: d.motivo });
      continue;
    }
    const conhecido = exame.conhecido !== undefined;
    itens.push({
      pr: `${owner}/${exame.repo}#${item.number}`,
      titulo: exame.pr.title,
      autor: exame.pr.user?.login,
      url: exame.pr.html_url,
      entra: true,
      motivo: conhecido ? "passa nos filtros, mas este commit já virou evento" : "passa em todos os filtros",
      ...(conhecido ? { jaVirouEvento: true } : {}),
    });
  }
  const cortada = data.items.length >= TETO_DA_PREVIA && (data.total_count ?? 0) > data.items.length;
  return { itens, cortada };
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

function renderBody(findings: Finding[], summary?: string): string {
  if (findings.length === 0) {
    // Quando aprovado sem achados, publica estritamente texto curto e natural humano, ou vazio com LGTM
    const texto = summary?.trim();
    if (texto && texto.length > 0 && texto !== "LGTM!") {
      return `${texto}\n\n${LOCUM_MARKER}`;
    }
    return `LGTM!\n\n${LOCUM_MARKER}`;
  }
  const corpo = findings
    .map((f) => {
      const local = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "geral";
      const fix = f.fix ? `\n\nSugestão: ${f.fix}` : "";
      return `**${local}** (${SEVERITY_MARK[f.severity]})\n\n${f.problem}${fix}`;
    })
    .join("\n\n---\n\n");
  const prefixo = summary && summary.trim() !== "" ? `${summary.trim()}\n\n---\n\n` : "";
  return `${prefixo}${corpo}\n\n${LOCUM_MARKER}`;
}

/**
 * Handler da acao de review.
 *
 * O modo rascunho usa o proprio mecanismo do GitHub: review criada sem `event`
 * fica em estado pendente, visivel so para quem criou. Voce abre o PR, le e
 * envia. Nada publico antes disso.
 */
export function githubReviewHandler(
  client: () => ReviewClient = octokit,
  deps: { teams?: TeamsReactionOptions } = {},
): ActionHandler {
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
    //
    // Auto-review é bloqueado: ninguém aprova ou pede mudanças no próprio PR.
    holdForApproval(payload) {
      return ((payload as ReviewPayload).verdict ?? "COMMENT") !== "COMMENT";
    },
    async propose(payload) {
      const p = payload as ReviewPayload;
      if (p.author) {
        try {
          const { githubService } = await import("../services/github-service.js");
          const viewer = await githubService.viewerLogin();
          if (viewer && p.author.toLowerCase() === viewer.toLowerCase()) {
            // Se o PR for do próprio usuário autenticado, nunca abre proposta de review público na fila
            return null;
          }
        } catch {}
      }
      return payload;
    },
    async publish(payload, externalId) {
      const p = payload as ReviewPayload & OrigemDoReview;
      if (await jaSaiu(p, externalId)) return;
      await client().rest.pulls.createReview({
        owner: p.owner,
        repo: p.repo,
        pull_number: p.pull,
        event: p.verdict ?? "COMMENT",
        body: `${renderBody(p.findings, p.summary)}\n${marca(externalId)}`,
        comments: comments(p.findings),
      });

      await avisarOrigem(p, deps);
    },
    async draft(payload, externalId) {
      const p = payload as ReviewPayload & { summary?: string };
      if (await jaSaiu(p, externalId)) return;
      await client().rest.pulls.createReview({
        owner: p.owner,
        repo: p.repo,
        pull_number: p.pull,
        body: `${renderBody(p.findings, p.summary)}\n${marca(externalId)}`,
        comments: comments(p.findings),
      });
      // Saiu pendente: ainda não é veredito, então o 👀 só sai.
      await soltarOPr(p, deps.teams);
    },
    // Proposta que não vai sair: o 👀 do "peguei" não pode ficar para sempre.
    async discard(payload) {
      await soltarOPr(payload, deps.teams);
    },
  };
}
