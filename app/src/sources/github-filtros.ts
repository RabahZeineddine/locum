import { createHash } from "node:crypto";
import type { PollFilters } from "../config/types.js";

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
export function chaveDosFiltros(filters: PollFilters | undefined): string {
  const limpo = limpar(filters);
  return limpo === undefined ? "" : `:f${createHash("sha1").update(JSON.stringify(limpo)).digest("hex").slice(0, 10)}`;
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

const CACHE_DE_GLOB = new Map<string, RegExp>();

/** `**` atravessa pasta, `*` e `?` ficam dentro de um nome. */
function globParaRegex(glob: string): RegExp {
  const guardado = CACHE_DE_GLOB.get(glob);
  if (guardado) return guardado;
  let fonte = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        fonte += "(?:.*/)?";
        i += 2;
      } else {
        fonte += ".*";
        i += 1;
      }
    } else if (c === "*") fonte += "[^/]*";
    else if (c === "?") fonte += "[^/]";
    else fonte += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const regex = new RegExp(`^${fonte}$`);
  CACHE_DE_GLOB.set(glob, regex);
  return regex;
}

export function casaGlob(glob: string, texto: string): boolean {
  return globParaRegex(glob).test(texto);
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
 */
export function qualificadores(f: FiltrosResolvidos): string[] {
  const q: string[] = [];
  if (f.authorsInclude.length === 1 && SIMPLES.test(f.authorsInclude[0]!)) q.push(`author:${f.authorsInclude[0]}`);

  const alvos = f.reviewUsers.length + f.reviewTeams.length;
  if (alvos === 1) {
    if (f.reviewUsers[0] !== undefined && SIMPLES.test(f.reviewUsers[0])) q.push(`review-requested:${f.reviewUsers[0]}`);
    if (f.reviewTeams[0] !== undefined && SIMPLES.test(f.reviewTeams[0])) q.push(`team-review-requested:${f.reviewTeams[0]}`);
  }

  const incluiLabels = f.labelsInclude.filter((l) => !/["\\]/.test(l));
  if (incluiLabels.length > 0 && incluiLabels.length === f.labelsInclude.length) {
    q.push(`label:${incluiLabels.map((l) => `"${l}"`).join(",")}`);
  }

  if (f.baseBranches.length === 1 && !TEM_CORINGA.test(f.baseBranches[0]!) && SIMPLES.test(f.baseBranches[0]!)) {
    q.push(`base:${f.baseBranches[0]}`);
  }

  const negativos = [
    ...f.authorsExclude.filter((a) => SIMPLES.test(a)).map((a) => `-author:${a}`),
    ...f.labelsExclude.filter((l) => !/["\\]/.test(l)).map((l) => `-label:"${l}"`),
  ];
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

/** O que o `pulls.get` mostra: branch, pedido de review e tamanho. */
export function avaliarPr(f: FiltrosResolvidos, pr: FatosDoPr, owner: string): string | null {
  if (f.baseBranches.length > 0 && !f.baseBranches.some((g) => casaGlob(g, pr.base.ref))) {
    return `base ${pr.base.ref} fora de ${f.baseBranches.join(", ")}`;
  }

  if (f.reviewUsers.length + f.reviewTeams.length > 0) {
    const pessoas = new Set((pr.requested_reviewers ?? []).map((r) => minusculo(r.login ?? "")));
    const times = new Set((pr.requested_teams ?? []).map((t) => minusculo(`${owner}/${t.slug ?? ""}`)));
    const pedido =
      f.reviewUsers.some((u) => pessoas.has(minusculo(u))) || f.reviewTeams.some((t) => times.has(minusculo(t)));
    if (!pedido) return `sem review pedido para ${[...f.reviewUsers, ...f.reviewTeams].join(" ou ")}`;
  }

  if (f.maxChangedLines !== null) {
    const linhas = pr.additions + pr.deletions;
    if (linhas > f.maxChangedLines) return `${linhas} linhas, teto ${f.maxChangedLines}`;
  }
  return null;
}

/** Os arquivos alterados contra `paths.include` e `paths.exclude`. */
export function avaliarArquivos(f: FiltrosResolvidos, arquivos: string[]): string | null {
  if (!temFiltroDeArquivos(f)) return null;
  if (arquivos.length === 0) return "sem arquivos alterados";
  const dentro =
    f.pathsInclude.length === 0 ? arquivos : arquivos.filter((a) => f.pathsInclude.some((g) => casaGlob(g, a)));
  if (dentro.length === 0) return `nenhum arquivo em ${f.pathsInclude.join(", ")}`;
  const restantes = dentro.filter((a) => !f.pathsExclude.some((g) => casaGlob(g, a)));
  return restantes.length === 0 ? `só mexe em ${f.pathsExclude.join(", ")}` : null;
}

/* --------------------------------------------------------------------- time */

/** O pedaço do cliente que lista membros de time. Existe para o teste trocar. */
export type ClienteDeTimes = {
  paginate: (rota: never, params: never) => Promise<unknown>;
  rest: { teams: { listMembersInOrg: unknown } };
};

type MembrosDoTime = { membros: Set<string> } | { erro: string };

/**
 * Quem é membro de cada time, lido uma vez por batida.
 *
 * `read:org` falta com 403 ou 404, e aí o time não pôde ser conferido: quem
 * pergunta recebe o erro e descarta o pull request, nunca deixa passar. Erro
 * de outro tipo (rede, 5xx) sobe, para a batida falhar e o cursor não andar
 * por cima de um pull request que ninguém conferiu.
 */
export function leitorDeTimes(gh: ClienteDeTimes): (time: string) => Promise<MembrosDoTime> {
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
        const status = (err as { status?: number }).status;
        if (status === 403 || status === 404) {
          return { erro: `não deu para conferir o time ${time}: o token precisa de read:org` };
        }
        throw err;
      }
    })();
    cache.set(time.toLowerCase(), lido);
    return lido;
  };
}

/** O autor é membro de algum dos times. Time que não deu para ler vale como falha. */
export async function avaliarTimes(
  f: FiltrosResolvidos,
  autor: string | undefined,
  membrosDe: (time: string) => Promise<MembrosDoTime>,
): Promise<string | null> {
  if (f.teamMembers.length === 0) return null;
  const nome = autor ?? "";
  let erro: string | null = null;
  for (const time of f.teamMembers) {
    const lido = await membrosDe(time);
    if ("erro" in lido) {
      erro ??= lido.erro;
    } else if (nome !== "" && lido.membros.has(minusculo(nome))) {
      return null;
    }
  }
  if (erro !== null) return erro;
  const times = f.teamMembers.join(", ");
  return `autor ${nome || "desconhecido"} fora ${f.teamMembers.length === 1 ? "do time" : "dos times"} ${times}`;
}
