import { test } from "node:test";
import assert from "node:assert/strict";
import { ehLeitura, ehLeituraDa, escolhaDe, escolhaInicial } from "../src/config/leitura.js";

/** Nomes reais dos servidores que o Locum mais liga: GitHub, Atlassian e Grafana. */

const GITHUB_LEITURA = [
  "get_commit", "get_file_contents", "get_label", "get_latest_release", "get_me", "get_tag", "get_teams",
  "get_pull_request", "get_pull_request_files", "get_pull_request_diff", "get_pull_request_reviews", "get_pull_request_status",
  "get_workflow_run", "get_workflow_run_logs", "get_job_logs", "pull_request_read", "issue_read", "actions_get", "actions_list",
  "list_branches", "list_commits", "list_issues", "list_pull_requests", "list_workflow_runs", "search_code", "search_issues",
  "search_pull_requests", "search_repositories",
];
const GITHUB_ESCRITA = [
  "add_issue_comment", "create_branch", "create_or_update_file", "create_pull_request", "delete_file", "fork_repository",
  "issue_write", "merge_pull_request", "push_files", "update_pull_request", "update_pull_request_branch",
  "pull_request_review_write", "request_copilot_review", "actions_run_trigger", "run_workflow", "rerun_workflow_run",
];
const JIRA_LEITURA = [
  "getJiraIssue", "searchJiraIssuesUsingJql", "getConfluencePage", "getVisibleJiraProjects", "getAccessibleAtlassianResources",
  "lookupJiraAccountId", "getTransitionsForJiraIssue", "getJiraIssueRemoteIssueLinks", "search", "fetch",
];
const JIRA_ESCRITA = ["createJiraIssue", "editJiraIssue", "transitionJiraIssue", "addCommentToJiraIssue", "createConfluencePage"];
const GRAFANA_LEITURA = [
  "generate_deeplink", "query_prometheus", "query_loki_logs", "list_datasources", "search_dashboards", "get_dashboard_by_uid",
  "find_error_pattern_logs", "list_alert_rules",
];
const GRAFANA_ESCRITA = ["update_dashboard", "create_incident", "add_activity_to_incident", "create_alert_rule"];

test("leitura de verdade com request ou run no nome continua leitura", () => {
  for (const nome of [...GITHUB_LEITURA, ...JIRA_LEITURA, ...GRAFANA_LEITURA]) assert.equal(ehLeitura(nome), true, nome);
});

test("escrita de verdade continua escrita", () => {
  for (const nome of [...GITHUB_ESCRITA, ...JIRA_ESCRITA, ...GRAFANA_ESCRITA]) assert.equal(ehLeitura(nome), false, nome);
});

test("verbo de escrita depois de um verbo de leitura ainda ganha", () => {
  assert.equal(ehLeitura("get_and_delete_item"), false);
});

test("a anotação do servidor manda sobre o nome", () => {
  assert.equal(ehLeituraDa({ name: "pid", readOnlyHint: true }), true);
  assert.equal(ehLeituraDa({ name: "get_thing", readOnlyHint: false }), false);
  assert.equal(ehLeituraDa({ name: "get_thing", destructiveHint: true }), false);
  assert.equal(ehLeituraDa({ name: "get_thing" }), true);
  assert.equal(ehLeituraDa({ name: "mystery" }), false);
});

test("a escolha por servidor e ferramenta vale sobre a chave antiga, só pelo nome", () => {
  const tools = { echo: true, "a/echo": false, "b/sum": "read" as const };
  assert.equal(escolhaDe(tools, "a", "echo"), false);
  assert.equal(escolhaDe(tools, "c", "echo"), true);
  assert.equal(escolhaDe(tools, "b", "sum"), "read");
  assert.equal(escolhaDe(tools, "c", "sum"), undefined);
});

/** Nomes do servidor ms365: hífen em vez de sublinhado, e as anotações que ele entrega. */
test("nome com hífen é classificado como o com sublinhado", () => {
  for (const nome of ["list-chats", "get-chat-message", "list-calendar-events", "search-query"]) {
    assert.equal(ehLeitura(nome), true, nome);
  }
  assert.equal(ehLeitura("list-chats"), true);
  assert.equal(ehLeitura("send-chat-message"), false);
  assert.equal(ehLeitura("delete-calendar-event"), false);
});

test("a anotação de leitura não vale para nome que escreve, mesmo local", () => {
  assert.equal(ehLeituraDa({ name: "download-bytes-to-file", readOnlyHint: true }), false);
  for (const nome of ["upload-file", "create-draft-email", "delete-chat", "send-mail", "set-presence", "update-event", "move-mail-message"]) {
    assert.equal(ehLeituraDa({ name: nome, readOnlyHint: true }), false, nome);
  }
  assert.equal(ehLeituraDa({ name: "copilot-retrieve", readOnlyHint: true }), true);
  assert.equal(ehLeituraDa({ name: "get_settings", readOnlyHint: true }), true);
});

const ESCRITA_DE_SUBSTANTIVO = [
  "drop-schema", "clear-logs", "purge-history", "grant-access-policy", "destroy-resource", "subscribe-events",
  "acknowledge-events", "snooze-events", "export-report", "lock-documents", "kill-process-tree", "reset-status",
  "drop_schema", "clear_logs", "purge_history",
];

test("verbo de escrita antes de substantivo de leitura continua escrita, com ou sem hífen", () => {
  for (const nome of ESCRITA_DE_SUBSTANTIVO) {
    assert.equal(ehLeitura(nome), false, nome);
    assert.equal(ehLeituraDa({ name: nome }), false, nome);
  }
});

test("composto com hífen só é leitura com verbo de leitura na frente", () => {
  for (const nome of ["list-chats", "get-settings", "list-updates", "search-created"]) {
    assert.equal(ehLeitura(nome), true, nome);
  }
  for (const nome of ["events-feed", "schema-tree", "report-status"]) assert.equal(ehLeitura(nome), false, nome);
});

test("só o verbo inicial ou to-file e upload derrubam a anotação de leitura", () => {
  for (const nome of ["get-update-status", "list-update-history", "get-send-status", "get-data-set"]) {
    assert.equal(ehLeituraDa({ name: nome, readOnlyHint: true }), true, nome);
  }
  assert.equal(ehLeituraDa({ name: "download-bytes-to-file", readOnlyHint: true }), false);
  assert.equal(ehLeituraDa({ name: "send-mail", readOnlyHint: true }), false);
});

test("a escolha ao adicionar a conexão grava as leituras ligadas e não depende de regra reavaliada", () => {
  const pequeno = escolhaInicial([{ nome: "gh", ferramentas: [{ name: "get_issue" }, { name: "create_issue" }] }]);
  assert.deepEqual(pequeno, { tools: { "gh/get_issue": true } });

  const grande = Array.from({ length: 31 }, (_, i) => ({ name: `get_item_${i}` }));
  assert.deepEqual(escolhaInicial([{ nome: "ms", ferramentas: grande }]), { tools: {}, leituraPadrao: "limitada" });
  assert.deepEqual(escolhaInicial([{ nome: "novo", ferramentas: null }]), { tools: {}, leituraPadrao: "limitada" });
});
