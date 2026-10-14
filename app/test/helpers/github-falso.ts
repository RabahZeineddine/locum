import type { PollClient } from "../../src/sources/github.js";

export type Pr = {
  number: number;
  repo?: string;
  sha?: string;
  author?: string;
  labels?: string[];
  base?: string;
  reviewers?: string[];
  teams?: string[];
  files?: string[];
  additions?: number;
  deletions?: number;
  draft?: boolean;
};

export type Membros = Record<string, string[] | { status: number }>;

/**
 * Um GitHub de mentira para os filtros. A busca ignora os qualificadores de
 * propósito: o que o teste prova é o filtro em código, que é quem decide, e
 * os qualificadores ficam anotados para conferir o que a consulta pediu.
 */
export function githubFalso(prs: Pr[], membros: Membros = {}) {
  const chamadas = { buscas: [] as string[], listFiles: 0, get: 0, membros: [] as string[] };
  const pr = (n: number) => prs.find((p) => p.number === n)!;

  const rest = {
    search: {
      issuesAndPullRequests: async (params: { q: string }) => {
        chamadas.buscas.push(params.q);
        return {
          data: {
            items: prs.map((p) => ({
              number: p.number,
              title: `PR ${p.number}`,
              html_url: `https://example.invalid/pr/${p.number}`,
              repository_url: `https://api.github.com/repos/o/${p.repo ?? "api"}`,
              updated_at: "2026-09-22T10:00:00Z",
              draft: p.draft ?? false,
              user: { login: p.author ?? "autora" },
              labels: (p.labels ?? []).map((name) => ({ name })),
            })),
          },
        };
      },
    },
    pulls: {
      get: async ({ pull_number }: { pull_number: number }) => {
        chamadas.get++;
        const p = pr(pull_number);
        return {
          data: {
            number: p.number,
            title: `PR ${p.number}`,
            body: "",
            head: { sha: p.sha ?? `sha${p.number}`, ref: "feat/x" },
            base: { ref: p.base ?? "main" },
            user: { login: p.author ?? "autora" },
            html_url: `https://example.invalid/pr/${p.number}`,
            additions: p.additions ?? 1,
            deletions: p.deletions ?? 0,
            draft: p.draft ?? false,
            requested_reviewers: (p.reviewers ?? []).map((login) => ({ login })),
            requested_teams: (p.teams ?? []).map((slug) => ({ slug })),
          },
        };
      },
      listFiles: async () => ({}),
    },
    checks: { listForRef: async () => ({}) },
    teams: { listMembersInOrg: async () => ({}) },
  };

  const paginate = async (rota: unknown, params: Record<string, unknown>) => {
    if (rota === rest.pulls.listFiles) {
      chamadas.listFiles++;
      const p = pr(params.pull_number as number);
      return (p.files ?? ["src/a.ts"]).map((filename) => ({ filename, status: "modified", additions: 1, deletions: 0, patch: "+x" }));
    }
    if (rota === rest.checks.listForRef) return [];
    if (rota === rest.search.issuesAndPullRequests) {
      const { data } = await rest.search.issuesAndPullRequests(params as { q: string });
      return data.items;
    }
    if (rota === rest.teams.listMembersInOrg) {
      const chave = `${params.org}/${params.team_slug}`;
      chamadas.membros.push(chave);
      const m = membros[chave];
      if (m === undefined || !Array.isArray(m)) {
        throw Object.assign(new Error("Not Found"), { status: m?.status ?? 404 });
      }
      return m.map((login) => ({ login }));
    }
    throw new Error("rota inesperada");
  };

  return { client: { rest, paginate } as unknown as PollClient, chamadas };
}
