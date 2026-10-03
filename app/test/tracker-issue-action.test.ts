import { test } from "node:test";
import assert from "node:assert/strict";
import type { TrackerService } from "../src/services/tracker-service.js";
import { trackerIssueHandler } from "../src/trackers/issue-action.js";

type Criada = { tracker: string; issue: Record<string, unknown> };

function servico(opts: { projeto?: string | null; existente?: unknown } = {}) {
  const criadas: Criada[] = [];
  const buscas: unknown[][] = [];
  const fake = {
    defaultProject: async () => (opts.projeto === undefined ? "WEB" : opts.projeto),
    findIssueForPullRequest: async (...args: unknown[]) => {
      buscas.push(args);
      return opts.existente ?? null;
    },
    createIssue: async (tracker: string, issue: Record<string, unknown>) => {
      criadas.push({ tracker, issue });
      return { key: "WEB-1" };
    },
  } as unknown as TrackerService;
  return { fake, criadas, buscas };
}

const saidaDoPasso = {
  repo: "acme/web",
  pull: 42,
  title: "Tela de login",
  url: "https://github.com/acme/web/pull/42",
  objective: "Deixar entrar com SSO.",
  changes: "Botão novo.",
  testing: "Entrar com a conta de teste.",
  labels: ["front"],
};

test("tarefa aceita approve e auto, sem rascunho", () => {
  assert.deepEqual(trackerIssueHandler(servico().fake).modes, ["approve", "auto"]);
});

test("proposta recusa passo sem tracker e tracker sem projeto", async () => {
  await assert.rejects(trackerIssueHandler(servico().fake).propose!(saidaDoPasso, null), /target/);
  await assert.rejects(trackerIssueHandler(servico().fake).propose!(saidaDoPasso, "  "), /target/);
  await assert.rejects(
    trackerIssueHandler(servico({ projeto: null }).fake).propose!(saidaDoPasso, "jira"),
    /sem projeto de destino/,
  );
});

test("proposta monta título, corpo e projeto, e a publicação cria com o mesmo conteúdo", async () => {
  const { fake, criadas, buscas } = servico();
  const handler = trackerIssueHandler(fake);
  const proposta = (await handler.propose!(saidaDoPasso, "jira")) as Record<string, unknown>;
  assert.equal(proposta.title, "acme/web#42: Tela de login");
  assert.equal(proposta.project, "WEB");
  assert.match(String(proposta.body), /## O que testar\n\nEntrar com a conta de teste\./);

  await handler.publish(proposta, "pendencia-1");
  assert.deepEqual(buscas, [["jira", saidaDoPasso.url, "WEB"]]);
  assert.equal(criadas.length, 1);
  assert.equal(criadas[0]!.tracker, "jira");
  assert.deepEqual(criadas[0]!.issue, {
    project: "WEB",
    title: proposta.title,
    body: proposta.body,
    labels: ["front"],
    pullRequestUrl: saidaDoPasso.url,
  });
});

test("publicação não abre segunda tarefa para o mesmo pull request", async () => {
  const { fake, criadas } = servico({ existente: { key: "WEB-7" } });
  const handler = trackerIssueHandler(fake);
  const proposta = await handler.propose!(saidaDoPasso, "jira");
  await handler.publish(proposta, "pendencia-1");
  assert.equal(criadas.length, 0);
});

test("saída de modelo incompleta diz que faltou o corpo, e evento sem pull request diz isso", async () => {
  const handler = trackerIssueHandler(servico().fake);
  const { testing: _, ...semTeste } = saidaDoPasso;
  await assert.rejects(handler.propose!(semTeste, "jira"), /nao escreveu o corpo da tarefa: testing/);
  const { url: __, ...semUrl } = saidaDoPasso;
  await assert.rejects(handler.propose!(semUrl, "jira"), /nao identifica o pull request/);
});
