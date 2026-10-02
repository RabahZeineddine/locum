import { test } from "node:test";
import assert from "node:assert/strict";
import { pollOpenPullRequests, scanOpenPullRequests, type PollClient } from "../src/sources/github.js";
import { bancoDeTeste } from "./helpers/db.js";

type Pr = { number: number; repo: string; sha: string; updatedAt: string; draft?: boolean };

/**
 * Um GitHub de mentira com pull requests fixos.
 *
 * A busca devolve em páginas de verdade pelo `paginate`, e cada chamada fica
 * anotada para o teste conferir o que a varredura pediu e o que ela evitou.
 */
function githubFalso(prs: Pr[], porPagina = 100) {
  const chamadas = { buscas: [] as string[], paginasDeBusca: 0, get: 0, listFiles: 0, checks: 0 };

  const rest = {
    search: {
      issuesAndPullRequests: async (params: { q: string; per_page: number; page?: number }) => {
        chamadas.paginasDeBusca++;
        const pagina = params.page ?? 1;
        if (pagina === 1) chamadas.buscas.push(params.q);
        const inicio = (pagina - 1) * porPagina;
        return {
          data: {
            items: prs.slice(inicio, inicio + porPagina).map((p) => ({
              number: p.number,
              repository_url: `https://api.github.com/repos/o/${p.repo}`,
              updated_at: p.updatedAt,
              draft: p.draft ?? false,
            })),
          },
        };
      },
    },
    pulls: {
      get: async ({ pull_number }: { pull_number: number }) => {
        chamadas.get++;
        const p = prs.find((x) => x.number === pull_number)!;
        return {
          data: {
            title: `PR ${p.number}`,
            body: "",
            head: { sha: p.sha, ref: "feat/x" },
            base: { ref: "main" },
            user: { login: "autora" },
            html_url: `https://example.invalid/pr/${p.number}`,
            additions: 1,
            deletions: 0,
            draft: p.draft ?? false,
          },
        };
      },
      listFiles: async () => ({}),
    },
    checks: { listForRef: async () => ({}) },
  };

  // Imita o `paginate` do octokit: pede página por página até vir uma curta.
  const paginate = async (rota: unknown, params: Record<string, unknown>) => {
    if (rota === rest.pulls.listFiles) {
      chamadas.listFiles++;
      return [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "+x" }];
    }
    if (rota === rest.checks.listForRef) {
      chamadas.checks++;
      return [];
    }
    if (rota === rest.search.issuesAndPullRequests) {
      const itens: unknown[] = [];
      for (let page = 1; ; page++) {
        const { data } = await rest.search.issuesAndPullRequests({ ...(params as { q: string; per_page: number }), page });
        itens.push(...data.items);
        if (data.items.length < (params.per_page as number)) break;
      }
      return itens;
    }
    throw new Error("rota inesperada");
  };

  return { client: { rest, paginate } as unknown as PollClient, chamadas };
}

const agora = Date.parse("2026-09-22T12:00:00Z");

test("a segunda batida sobre os mesmos pull requests não busca diff nenhum", async () => {
  const db = bancoDeTeste();
  const { client, chamadas } = githubFalso([
    { number: 1, repo: "api", sha: "a1", updatedAt: "2026-09-22T10:15:30Z" },
    { number: 2, repo: "web", sha: "b1", updatedAt: "2026-09-22T11:40:05Z" },
  ]);
  const deps = { client, db, now: agora, diffMaxChars: 100_000 };

  const primeira = await pollOpenPullRequests("o", /.*/, deps);
  assert.equal(primeira.length, 2);
  assert.equal(chamadas.listFiles, 2);

  const segunda = await pollOpenPullRequests("o", /.*/, deps);
  assert.deepEqual(segunda, []);
  assert.equal(chamadas.listFiles, 2, "nenhum diff buscado na segunda batida");
  assert.equal(chamadas.checks, 2, "nem os checks, que também são do mesmo commit");
});

test("a varredura devolve a janela inteira, e não só o que acabou de gravar", async () => {
  const db = bancoDeTeste();
  const { client } = githubFalso([
    { number: 1, repo: "api", sha: "a1", updatedAt: "2026-09-22T10:15:30Z" },
  ]);
  const deps = { client, db, now: agora, diffMaxChars: 100_000 };

  const primeira = await scanOpenPullRequests("o", /.*/, deps);
  assert.equal(primeira.created.length, 1);

  // Segundo gatilho sobre a mesma organização, ou a batida que voltou depois
  // de morrer antes de criar o run: o evento já existe e ainda é deles.
  const segunda = await scanOpenPullRequests("o", /.*/, deps);
  assert.deepEqual(segunda.created, []);
  assert.deepEqual(segunda.eventIds, primeira.created);
});

test("o cursor vai na consulta com hora completa, e não só com o dia", async () => {
  const db = bancoDeTeste();
  const { client, chamadas } = githubFalso([
    { number: 1, repo: "api", sha: "a1", updatedAt: "2026-09-22T10:15:30Z" },
  ]);
  const deps = { client, db, now: agora, diffMaxChars: 100_000 };

  await pollOpenPullRequests("o", /.*/, deps);
  await pollOpenPullRequests("o", /.*/, deps);

  assert.match(chamadas.buscas[0] ?? "", /updated:>=2026-09-21T12:00:00Z/);
  assert.match(chamadas.buscas[1] ?? "", /updated:>=2026-09-22T10:15:30Z/);
});

test("commit novo no mesmo pull request vira evento novo", async () => {
  const db = bancoDeTeste();
  const prs: Pr[] = [{ number: 1, repo: "api", sha: "a1", updatedAt: "2026-09-22T10:00:00Z" }];
  const { client, chamadas } = githubFalso(prs);
  const deps = { client, db, now: agora, diffMaxChars: 100_000 };

  await pollOpenPullRequests("o", /.*/, deps);
  prs[0] = { ...prs[0]!, sha: "a2", updatedAt: "2026-09-22T11:00:00Z" };
  const novos = await pollOpenPullRequests("o", /.*/, deps);

  assert.equal(novos.length, 1);
  assert.equal(chamadas.listFiles, 2);
});

test("a busca pagina até o fim, e não para nos primeiros resultados", async () => {
  const db = bancoDeTeste();
  const prs = Array.from({ length: 130 }, (_, i) => ({
    number: i + 1,
    repo: "api",
    sha: `s${i}`,
    updatedAt: "2026-09-22T10:00:00Z",
  }));
  const { client, chamadas } = githubFalso(prs);

  const criados = await pollOpenPullRequests("o", /.*/, { client, db, now: agora, diffMaxChars: 100_000 });
  assert.equal(criados.length, 130);
  assert.equal(chamadas.paginasDeBusca, 2);
});

test("rascunho fica fora por padrão, e entra quando o gatilho pede", async () => {
  const prs: Pr[] = [
    { number: 1, repo: "api", sha: "a1", updatedAt: "2026-09-22T10:00:00Z", draft: true },
    { number: 2, repo: "api", sha: "b1", updatedAt: "2026-09-22T10:00:00Z" },
  ];

  const padrao = githubFalso(prs);
  const semRascunho = await pollOpenPullRequests("o", /.*/, {
    client: padrao.client,
    db: bancoDeTeste(),
    now: agora,
    diffMaxChars: 100_000,
  });
  assert.equal(semRascunho.length, 1);
  assert.match(padrao.chamadas.buscas[0] ?? "", /draft:false/);
  assert.equal(padrao.chamadas.listFiles, 1, "o diff do rascunho não é buscado");

  const comRascunho = githubFalso(prs);
  const todos = await pollOpenPullRequests("o", /.*/, {
    client: comRascunho.client,
    db: bancoDeTeste(),
    now: agora,
    diffMaxChars: 100_000,
    includeDrafts: true,
  });
  assert.equal(todos.length, 2);
  assert.doesNotMatch(comRascunho.chamadas.buscas[0] ?? "", /draft:/);
});

test("repositório exato vai na própria consulta, e padrão aberto fica no filtro", async () => {
  const exato = githubFalso([{ number: 1, repo: "api", sha: "a1", updatedAt: "2026-09-22T10:00:00Z" }]);
  await pollOpenPullRequests("o", /^o\/api$/, { client: exato.client, db: bancoDeTeste(), now: agora, diffMaxChars: 100_000 });
  assert.match(exato.chamadas.buscas[0] ?? "", /(^| )repo:o\/api( |$)/);
  assert.doesNotMatch(exato.chamadas.buscas[0] ?? "", /org:/);

  const aberto = githubFalso([
    { number: 1, repo: "api", sha: "a1", updatedAt: "2026-09-22T10:00:00Z" },
    { number: 2, repo: "web", sha: "b1", updatedAt: "2026-09-22T10:00:00Z" },
  ]);
  const criados = await pollOpenPullRequests("o", /api/, {
    client: aberto.client,
    db: bancoDeTeste(),
    now: agora,
    diffMaxChars: 100_000,
  });
  assert.match(aberto.chamadas.buscas[0] ?? "", /org:o/);
  assert.doesNotMatch(aberto.chamadas.buscas[0] ?? "", /repo:/);
  assert.equal(criados.length, 1);
  assert.equal(aberto.chamadas.get, 1, "o repositório fora do padrão nem é aberto");
});

test("gatilhos de repositórios diferentes não dividem o mesmo cursor", async () => {
  const db = bancoDeTeste();
  const api = githubFalso([{ number: 1, repo: "api", sha: "a1", updatedAt: "2026-09-22T11:00:00Z" }]);
  await pollOpenPullRequests("o", /^o\/api$/, { client: api.client, db, now: agora, diffMaxChars: 100_000 });

  const web = githubFalso([{ number: 2, repo: "web", sha: "b1", updatedAt: "2026-09-22T09:00:00Z" }]);
  await pollOpenPullRequests("o", /^o\/web$/, { client: web.client, db, now: agora, diffMaxChars: 100_000 });

  assert.match(web.chamadas.buscas[0] ?? "", /updated:>=2026-09-21T12:00:00Z/);
});
