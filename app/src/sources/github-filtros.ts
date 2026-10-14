import { createHash } from "node:crypto";
import picomatch from "picomatch";
import type { Authorship, PollFilters } from "../config/types.js";
import { matchesAuthorship } from "../services/github-service.js";

/**
 * Os filtros do gatilho de varredura do GitHub.
 *
 * A busca do GitHub só estreita (ela devolve um subconjunto), e quem decide é
 * sempre o código daqui: cada filtro é conferido de novo sobre o que a busca
 * trouxe. Por isso um qualificador só entra na consulta quando diz exatamente
 * o mesmo que o filtro, e a varredura e a prévia usam as mesmas funções.
 *
 * Entre filtros diferentes vale E, dentro de uma lista vale OU. Os
 * qualificadores repetidos da busca valem E (`label:a label:b` pede as duas),
 * e o OU só existe com vírgula (`label:a,b`), por isso o que não cabe assim
 * fica só em código.
 *
 * `reviewRequested` olha o pedido que existe agora no pull request. Quando
 * alguém do time já revisou, o GitHub tira o pedido ao time e o filtro deixa
 * de ver o pull request: ele continua sendo o evento que já virou, e um push
 * novo depois da review não pede o time de novo.
 */

/** Descarte de um pull request que a varredura viu e não virou evento. */
export type Descarte = {
  /** `org/repo#123`. */
  pr: string;
  titulo?: string;
  autor?: string;
  url?: string;
  motivo: string;
};

/** O que a busca devolve de cada pull request, e que os filtros baratos usam. */
export type ItemDaBusca = {
  number: number;
  title?: string;
  html_url?: string;
  draft?: boolean;
  user?: { login?: string | null } | null;
  labels?: (string | { name?: string | null })[];
};

/** O que o `pulls.get` acrescenta. */
export type FatosDoPr = {
  base: { ref: string };
  additions: number;
  deletions: number;
  requested_reviewers?: { login?: string }[] | null;
  requested_teams?: { slug?: string }[] | null;
};

/** Os filtros com `@me` já trocado pela conta do token e as listas sempre presentes. */
export type FiltrosResolvidos = {
  authorsInclude: string[];
  authorsExclude: string[];
  reviewUsers: string[];
  reviewTeams: string[];
  teamMembers: string[];
  labelsInclude: string[];
  labelsExclude: string[];
  baseBranches: string[];
  pathsInclude: string[];
  pathsExclude: string[];
  maxChangedLines: number | null;
};

const minusculo = (texto: string) => texto.toLowerCase();

/** O texto não é vazio e não é `@me` sem conta para trocar. */
function trocarEu(logins: string[] | undefined, viewer: string | null): string[] {
  return (logins ?? []).map((login) => {
    if (login !== "@me") return login.replace(/^@/, "");
    // Sem a conta do token não dá para dizer quem é "eu", e deixar passar
    // faria o filtro valer por acidente para todo mundo ou para ninguém.
    if (viewer === null) {
      throw new Error(
        "gatilho filtra por @me e a conta do GitHub nunca foi conferida, confira o token na configuração",
      );
    }
    return viewer;
  });
}

export function resolverFiltros(filters: PollFilters | undefined, viewer: string | null): FiltrosResolvidos {
  const f = filters ?? {};
  const pathsInclude: string[] = [];
  const pathsExclude = [...(f.paths?.exclude ?? [])];
  // `!glob` na lista de inclusão é a notação de quem escreve `src/**, !**/*.md`.
  for (const glob of f.paths?.include ?? []) {
    if (glob.startsWith("!")) pathsExclude.push(glob.slice(1));
    else pathsInclude.push(glob);
  }
  return {
    authorsInclude: trocarEu(f.authors?.include, viewer),
    authorsExclude: trocarEu(f.authors?.exclude, viewer),
    reviewUsers: trocarEu(f.reviewRequested?.users, viewer),
    reviewTeams: f.reviewRequested?.teams ?? [],
    teamMembers: f.teamMembers ?? [],
    labelsInclude: f.labels?.include ?? [],
    labelsExclude: f.labels?.exclude ?? [],
    baseBranches: f.baseBranches ?? [],
    pathsInclude,
    pathsExclude,
    maxChangedLines: f.maxChangedLines ?? null,
  };
}

/** Algum filtro da lista de arquivos está ligado. */
export function temFiltroDeArquivos(f: FiltrosResolvidos): boolean {
  return f.pathsInclude.length > 0 || f.pathsExclude.length > 0;
}

/**
 * Sufixo da chave do cursor. Vazio sem filtro, para quem já varre assim não
 * perder a posição; com filtro, cada combinação tem o seu cursor, porque o
 * cursor de uma não vale para a outra (o que uma recusou a outra quer ver).
 */
export function chaveDosFiltros(filters: PollFilters | undefined, authorship: Authorship = "any"): string {
  // A autoria também decide o que vira evento, então entra na chave quando não é a padrão.
  const limpo = limpar({ ...(filters ?? {}), ...(authorship === "any" ? {} : { authorship }) });
  return limpo === undefined ? "" : `:f${createHash("sha1").update(JSON.stringify(limpo)).digest("hex").slice(0, 10)}`;
}

/** Algum filtro precisa da conta do token: `@me` ou autoria diferente de `any`. */
export function precisaDaConta(filters: PollFilters | undefined, authorship: Authorship): boolean {
  return authorship !== "any" || JSON.stringify(filters ?? {}).includes('"@me"');
}

/** Tira o que está vazio, para `{}` e `{ labels: { include: [] } }` valerem como sem filtro. */
function limpar(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.length === 0 ? undefined : valor;
  if (valor !== null && typeof valor === "object") {
    const entradas = Object.entries(valor)
      .map(([chave, v]) => [chave, limpar(v)] as const)
      .filter(([, v]) => v !== undefined);
    return entradas.length === 0 ? undefined : Object.fromEntries(entradas);
  }
  return valor;
}

/* ------------------------------------------------------------------ glob */

const CACHE_DE_GLOB = new Map<string, (texto: string) => boolean>();

/**
 * Glob de caminho: sem barra casa em qualquer pasta, como no gitignore
 * (`*.md`), e `**`, `[...]` e `{a,b}` valem. Branch não tem pasta de verdade,
 * então o glob dela casa o nome inteiro.
 */
export function casaGlob(glob: string, texto: string, caminho = false): boolean {
  let casa = CACHE_DE_GLOB.get(glob);
  if (!casa) {
    casa = picomatch(glob, { dot: true });
    CACHE_DE_GLOB.set(glob, casa);
  }
  if (casa(texto)) return true;
  // Sem barra, o glob de caminho vale para o nome do arquivo em qualquer pasta.
  return caminho && !glob.includes("/") && casa(texto.slice(texto.lastIndexOf("/") + 1));
}

const TEM_CORINGA = /[*?[\]{}]/;

/* ----------------------------------------------------------- qualificadores */

/** A busca do GitHub recusa consulta com mais de 256 caracteres. */
const TETO_DA_CONSULTA = 256;
/** E aceita poucos operadores lógicos: o que passar disso fica em código. */
const TETO_DE_NEGACOES = 3;

const SIMPLES = /^[\w.@/-]+$/;

/**
 * Os pedaços da consulta que dizem o mesmo que um filtro. Só entram os que
 * não mudam o sentido: lista de dois ou mais para o mesmo qualificador viraria
 * E, e glob não existe na busca.
 *
 * Login e time nunca vão para a consulta: o GitHub responde 422 à busca
 * inteira quando o login não existe ou não é visível (`author:`,
 * `review-requested:`) ou o time é inválido, e o gatilho morreria sem o
 * cursor andar. Autor, review pedido e membro de time são conferidos em código.
 */
export function qualificadores(f: FiltrosResolvidos): string[] {
  const q: string[] = [];
  const incluiLabels = f.labelsInclude.filter((l) => !/["\\]/.test(l));
  if (incluiLabels.length > 0 && incluiLabels.length === f.labelsInclude.length) {
    q.push(`label:${incluiLabels.map((l) => `"${l}"`).join(",")}`);
  }

  if (f.baseBranches.length === 1 && !TEM_CORINGA.test(f.baseBranches[0]!) && SIMPLES.test(f.baseBranches[0]!)) {
    q.push(`base:${f.baseBranches[0]}`);
  }

  const negativos = f.labelsExclude.filter((l) => !/["\\]/.test(l)).map((l) => `-label:"${l}"`);
  q.push(...negativos.slice(0, TETO_DE_NEGACOES));
  return q;
}

/** A consulta com os qualificadores, ou sem eles quando estourariam o limite. */
export function montarConsulta(base: string[], f: FiltrosResolvidos): string {
  const simples = base.join(" ");
  const completa = [...base, ...qualificadores(f)].join(" ");
  return completa.length <= TETO_DA_CONSULTA ? completa : simples;
}

/* ------------------------------------------------------------ conferência */

const nomeDaLabel = (l: string | { name?: string | null }) => (typeof l === "string" ? l : (l.name ?? ""));

/** Autor e labels, que a própria busca já traz. Devolve o motivo do descarte, ou nulo. */
export function avaliarItem(f: FiltrosResolvidos, item: ItemDaBusca): string | null {
  const autor = item.user?.login ?? "";
  const autorMin = minusculo(autor);
  if (f.authorsInclude.length > 0 && !f.authorsInclude.some((a) => minusculo(a) === autorMin)) {
    return `autor ${autor || "desconhecido"} fora da lista`;
  }
  if (f.authorsExclude.some((a) => minusculo(a) === autorMin)) return `autor ${autor} na lista de exclusão`;

  const labels = (item.labels ?? []).map((l) => minusculo(nomeDaLabel(l)));
  const barrada = f.labelsExclude.find((l) => labels.includes(minusculo(l)));
  if (barrada !== undefined) return `com a label ${barrada}`;
  if (f.labelsInclude.length > 0 && !f.labelsInclude.some((l) => labels.includes(minusculo(l)))) {
    return `sem a label ${f.labelsInclude.join(" ou ")}`;
  }
  return null;
}

/** O que o `pulls.get` mostra de branch e tamanho. */
export function avaliarPr(f: FiltrosResolvidos, pr: FatosDoPr): string | null {
  if (f.baseBranches.length > 0 && !f.baseBranches.some((g) => casaGlob(g, pr.base.ref))) {
    return `base ${pr.base.ref} fora de ${f.baseBranches.join(", ")}`;
  }
  if (f.maxChangedLines !== null) {
    const linhas = pr.additions + pr.deletions;
    if (linhas > f.maxChangedLines) return `${linhas} linhas, teto ${f.maxChangedLines}`;
  }
  return null;
}

/**
 * Review pedido para as pessoas ou os times do filtro.
 *
 * Como na tela do GitHub, o pedido feito a um time de que a pessoa é membro
 * conta como pedido à pessoa: `requested_teams` mais a membresia, lida pelo
 * mesmo cache da batida. Se a membresia não puder ser lida, vale o erro do
 * time, e o pull request não é descartado por isso.
 */
export async function avaliarReview(
  f: FiltrosResolvidos,
  pr: FatosDoPr,
  owner: string,
  membrosDe: LeitorDeTimes,
): Promise<string | null> {
  if (f.reviewUsers.length + f.reviewTeams.length === 0) return null;
  const pessoas = new Set((pr.requested_reviewers ?? []).map((r) => minusculo(r.login ?? "")));
  const times = (pr.requested_teams ?? []).map((t) => `${owner}/${t.slug ?? ""}`);
  const timesMin = new Set(times.map(minusculo));

  let pedido = f.reviewUsers.some((u) => pessoas.has(minusculo(u))) || f.reviewTeams.some((t) => timesMin.has(minusculo(t)));
  for (const time of pedido || f.reviewUsers.length === 0 ? [] : times) {
    const { membros } = await membrosDe(time);
    if (f.reviewUsers.some((u) => membros.has(minusculo(u)))) {
      pedido = true;
      break;
    }
  }
  return pedido ? null : `sem review pedido para ${[...f.reviewUsers, ...f.reviewTeams].join(" ou ")}`;
}

/** A autoria do gatilho (`mine` ou `others`) contra a conta do token, com o mesmo motivo de descarte em todo caminho. */
export function avaliarAutoria(wanted: Authorship, autor: string | undefined, viewer: string | null): string | null {
  if (wanted === "any") return null;
  // Sem a conta conferida não dá para dizer de quem é o pull request, e deixar
  // passar acordaria o gatilho de um com o do outro.
  if (viewer === null) {
    throw new Error("gatilho filtra por autoria e a conta do GitHub nunca foi conferida, confira o token na configuração");
  }
  if (matchesAuthorship(wanted, autor, viewer)) return null;
  const nome = autor ?? "autor desconhecido";
  return wanted === "others"
    ? `PR de ${nome}, que é você (autoria "others")`
    : `PR de ${nome}, que não é você (autoria "mine")`;
}

/** Os arquivos alterados contra `paths.include` e `paths.exclude`. */
export function avaliarArquivos(f: FiltrosResolvidos, arquivos: string[]): string | null {
  if (!temFiltroDeArquivos(f)) return null;
  if (arquivos.length === 0) return "sem arquivos alterados";
  const dentro =
    f.pathsInclude.length === 0 ? arquivos : arquivos.filter((a) => f.pathsInclude.some((g) => casaGlob(g, a, true)));
  if (dentro.length === 0) return `nenhum arquivo em ${f.pathsInclude.join(", ")}`;
  const restantes = dentro.filter((a) => !f.pathsExclude.some((g) => casaGlob(g, a, true)));
  return restantes.length === 0 ? `só mexe em ${f.pathsExclude.join(", ")}` : null;
}

/* --------------------------------------------------------------------- time */

/** O pedaço do cliente que lista membros de time. Existe para o teste trocar. */
export type ClienteDeTimes = {
  paginate: (rota: never, params: never) => Promise<unknown>;
  rest: { teams: { listMembersInOrg: unknown } };
};

type MembrosDoTime = { membros: Set<string> };
export type LeitorDeTimes = (time: string) => Promise<MembrosDoTime>;

/** Falha de configuração ou de permissão ao ler um time: a batida para e o cursor não anda. */
export class ErroDeTime extends Error {}

type Falha = { status?: number; message?: string; response?: { headers?: Record<string, string | undefined> } };

/**
 * O que cada falha ao ler um time significa.
 *
 * Limite de uso, 5xx e rede sobem como vieram. Permissão (`read:org`), SSO e
 * time inexistente viram `ErroDeTime` com o motivo certo. Nenhuma delas
 * descarta pull request: a batida falha, o cursor não anda, e com o token ou o
 * cadastro corrigidos os pull requests voltam.
 */
function falhaDoTime(err: unknown, time: string): unknown {
  const { status, message = "", response } = err as Falha;
  const h = response?.headers ?? {};
  const limite = status === 429 || h["x-ratelimit-remaining"] === "0" || h["retry-after"] !== undefined || /rate limit|abuse/i.test(message);
  if (limite) return err;
  if (status === 403 && (h["x-github-sso"] !== undefined || /saml|sso/i.test(message))) {
    return new ErroDeTime(`não deu para conferir o time ${time}: autorize o token no SSO da org`);
  }
  if (status === 403) return new ErroDeTime(`não deu para conferir o time ${time}: o token precisa de read:org`);
  if (status === 404) return new ErroDeTime(`time ${time} não encontrado ou sem acesso`);
  return err;
}

/** Quem é membro de cada time, lido uma vez por batida. */
export function leitorDeTimes(gh: ClienteDeTimes): LeitorDeTimes {
  const cache = new Map<string, Promise<MembrosDoTime>>();
  return (time) => {
    const guardado = cache.get(time.toLowerCase());
    if (guardado) return guardado;
    const [org, slug] = time.split("/") as [string, string];
    const lido = (async (): Promise<MembrosDoTime> => {
      try {
        const lista = (await gh.paginate(gh.rest.teams.listMembersInOrg as never, {
          org,
          team_slug: slug,
          per_page: 100,
        } as never)) as { login: string }[];
        return { membros: new Set(lista.map((m) => minusculo(m.login))) };
      } catch (err) {
        throw falhaDoTime(err, time);
      }
    })();
    cache.set(time.toLowerCase(), lido);
    return lido;
  };
}

/** O autor é membro de algum dos times. */
export async function avaliarTimes(
  f: FiltrosResolvidos,
  autor: string | undefined,
  membrosDe: LeitorDeTimes,
): Promise<string | null> {
  if (f.teamMembers.length === 0) return null;
  const nome = autor ?? "";
  for (const time of f.teamMembers) {
    const { membros } = await membrosDe(time);
    if (nome !== "" && membros.has(minusculo(nome))) return null;
  }
  return `autor ${nome || "desconhecido"} fora ${f.teamMembers.length === 1 ? "do time" : "dos times"} ${f.teamMembers.join(", ")}`;
}
