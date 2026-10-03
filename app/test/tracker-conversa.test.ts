import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIssueProposal, conversaDe } from "../src/trackers/proposal.js";

/** Tarefa que nasce de conversa, e não de pull request. */

const escrito = {
  title: "Fila de cobrança parada desde as 9h",
  objective: "Descobrir por que a fila parou e voltar a processar.",
  changes: "Relato no canal de suporte: boletos não saem desde as 9h.",
  testing: "Boleto novo sai em menos de cinco minutos.",
};

test("mensagem do Slack vira tarefa com o título do modelo e o link da conversa", () => {
  const proposta = buildIssueProposal(
    { ...escrito, repo: "slack/C123", threadTs: "1759490000.000100" },
    "jira",
    "OPS",
  );
  assert.equal(proposta.title, escrito.title);
  assert.equal(proposta.pullRequestUrl, "https://slack.com/archives/C123/p1759490000000100");
  assert.match(proposta.body, /## Contexto/);
  assert.match(proposta.body, /Conversa no Slack: https:\/\/slack\.com\/archives\/C123/);
});

test("permalink do evento vence o endereço montado", () => {
  const link = "https://empresa.slack.com/archives/C123/p1759490000000100";
  assert.equal(conversaDe({ repo: "slack/C123", ts: "1.2", permalink: link })?.link, link);
});

test("tarefa de conversa sem título explica o que faltou", () => {
  const { title: _title, ...semTitulo } = escrito;
  assert.throws(
    () => buildIssueProposal({ ...semTitulo, repo: "slack/C123", ts: "1.2" }, "jira", "OPS"),
    /title/,
  );
});

test("evento que não é pull request nem conversa continua recusado", () => {
  assert.throws(() => buildIssueProposal({ ...escrito, repo: "" }, "jira", "OPS"), /pull request/);
});
