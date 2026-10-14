import type { PollClient } from "../sources/github.js";

/**
 * Um GitHub de exemplo para a prévia do gatilho, na fumaça e nas capturas.
 *
 * Responde como a API responderia, sem rede e sem token. Os pull requests
 * cobrem os motivos de descarte que a tela mostra: tamanho, rascunho, branch
 * base e só documentação.
 */
type Exemplo = {
  number: number;
  repo: string;
  title: string;
  author: string;
  labels: string[];
  base: string;
  additions: number;
  deletions: number;
  draft?: boolean;
  files: string[];
};

const EXEMPLOS: Exemplo[] = [
  { number: 412, repo: "checkout", title: "Corrige o tempo esgotado na confirmação", author: "ana", labels: ["bug"], base: "main", additions: 84, deletions: 36, files: ["src/confirmacao.ts", "test/confirmacao.test.ts"] },
  { number: 405, repo: "contratos", title: "Migra o esquema de contratos para a versão 2", author: "bia", labels: ["feature"], base: "main", additions: 200, deletions: 145, files: ["src/esquema.ts", "src/migracao.ts"] },
  { number: 398, repo: "portal", title: "Atualiza o guia de instalação", author: "caio", labels: ["docs"], base: "main", additions: 30, deletions: 4, files: ["docs/instalacao.md", "README.md"] },
  { number: 391, repo: "checkout", title: "Novo painel de cobrança (em andamento)", author: "ana", labels: [], base: "main", additions: 12, deletions: 0, draft: true, files: ["src/painel.tsx"] },
  { number: 388, repo: "contratos", title: "Backport da correção de arredondamento", author: "duda", labels: ["bug"], base: "release/1.4", additions: 18, deletions: 6, files: ["src/arredondar.ts"] },
];

export function clienteDeExemplo(owner = "acme"): PollClient {
  const achar = (n: number) => EXEMPLOS.find((e) => e.number === n)!;
  const rest = {
    search: {
      issuesAndPullRequests: async (params: { per_page?: number }) => ({
        data: {
          total_count: EXEMPLOS.length,
          items: EXEMPLOS.slice(0, params.per_page ?? EXEMPLOS.length).map((e) => ({
            number: e.number,
            title: e.title,
            html_url: `https://github.com/${owner}/${e.repo}/pull/${e.number}`,
            repository_url: `https://api.github.com/repos/${owner}/${e.repo}`,
            updated_at: "2026-10-01T12:00:00Z",
            draft: e.draft ?? false,
            user: { login: e.author },
            labels: e.labels.map((name) => ({ name })),
          })),
        },
      }),
    },
    pulls: {
      get: async ({ pull_number }: { pull_number: number }) => {
        const e = achar(pull_number);
        return {
          data: {
            number: e.number,
            title: e.title,
            body: "",
            head: { sha: `exemplo${e.number}`, ref: `ajuste-${e.number}` },
            base: { ref: e.base },
            user: { login: e.author },
            html_url: `https://github.com/${owner}/${e.repo}/pull/${e.number}`,
            additions: e.additions,
            deletions: e.deletions,
            draft: e.draft ?? false,
            requested_reviewers: [],
            requested_teams: [],
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
      return achar(params.pull_number as number).files.map((filename) => ({ filename, status: "modified", additions: 1, deletions: 0 }));
    }
    if (rota === rest.teams.listMembersInOrg) return [{ login: "ana" }, { login: "bia" }];
    return [];
  };

  return { rest, paginate } as unknown as PollClient;
}
