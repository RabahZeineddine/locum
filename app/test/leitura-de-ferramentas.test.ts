import { test } from "node:test";
import assert from "node:assert/strict";
import { contarDaConexao } from "../renderer/lib/ferramentas-do-agent.js";
import { ehLeitura, ehLeituraDa, escolhaDe, escolhaInicial, fixarLista, ligadaPorPadrao } from "../src/config/leitura.js";

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
  assert.deepEqual(pequeno, { tools: { "gh/get_issue": true, "gh/create_issue": false }, leituraPadrao: "limitada", linhaDeBase: "feita" });

  const grande = Array.from({ length: 31 }, (_, i) => ({ name: `get_item_${i}` }));
  const todasDesligadas = Object.fromEntries(grande.map((f) => [`ms/${f.name}`, false]));
  assert.deepEqual(escolhaInicial([{ nome: "ms", ferramentas: grande }]), { tools: todasDesligadas, leituraPadrao: "limitada", linhaDeBase: "feita" });
  assert.deepEqual(escolhaInicial([{ nome: "novo", ferramentas: null }]), { tools: {}, leituraPadrao: "limitada", linhaDeBase: "pendente" });
});

test("run e request depois de and, then, or ou colados no verbo de leitura são ação", () => {
  for (const nome of ["list-and-run", "get-and-run", "analyze_and_run", "retrieve_then_request", "preview_run", "count_and_request", "query_and_run_job", "get_and_execute"]) {
    assert.equal(ehLeitura(nome), false, nome);
  }
  for (const nome of [
    "get-settings", "list-updates", "search-created", "get-asset", "list-datasets", "get-offset", "get-update-status",
    "list-update-history", "get-send-status", "get-data-set", "list-chats", "get_pull_request", "get_workflow_run_logs", "pull_request_read",
  ]) {
    assert.equal(ehLeituraDa({ name: nome, readOnlyHint: true }), true, nome);
  }
  for (const nome of ["get-settings", "list-updates", "search-created", "get-asset", "list-datasets", "get-offset", "list-chats"]) {
    assert.equal(ehLeitura(nome), true, nome);
  }
});

test("connect só pesa como verbo inicial: get_code_connect_map lê", () => {
  assert.equal(ehLeitura("get_code_connect_map"), true);
  assert.equal(ehLeitura("get_code_connect_suggestions"), true);
  assert.equal(ehLeitura("connect-account"), false);
  assert.equal(ehLeitura("disconnect_session"), false);
});

test("limitada nunca liga nada por padrão, e sem modo toda leitura liga", () => {
  assert.equal(ligadaPorPadrao({ name: "get_issue" }, "limitada"), false);
  assert.equal(ligadaPorPadrao({ name: "get_issue" }, undefined), true);
  assert.equal(ligadaPorPadrao({ name: "get_issue" }, "todas"), true);
  assert.equal(ligadaPorPadrao({ name: "create_issue" }, undefined), false);
});

test("fixar a lista liga o que hoje vale ligado, desliga o resto e fecha a porta para ferramenta nova", () => {
  const catalogo = [{ nome: "gh", ferramentas: [{ name: "get_issue" }, { name: "list_commits" }, { name: "create_comment" }, { name: "get_pr" }] }];
  const antes: { connectionId: string; tools: Record<string, boolean> } = { connectionId: "github", tools: { "gh/get_pr": false, create_comment: true } };
  const depois = fixarLista(antes, catalogo);
  assert.deepEqual(depois, {
    connectionId: "github",
    leituraPadrao: "limitada" as const,
    linhaDeBase: "feita" as const,
    tools: { "gh/get_issue": true, "gh/list_commits": true, "gh/create_comment": true, "gh/get_pr": false },
  });
  // Ferramenta que o servidor ganhar depois não está no mapa, e na lista explícita ausente é desligada.
  assert.equal(ligadaPorPadrao({ name: "get_nova" }, depois.leituraPadrao), false);
  assert.deepEqual(fixarLista(depois, catalogo), depois, "fixar de novo não muda nada");
});

test("sem lista guardada de algum servidor a conexão fica como estava", () => {
  const antes = { connectionId: "github", tools: { "gh/get_pr": false } };
  assert.equal(fixarLista(antes, [{ nome: "gh", ferramentas: null }]), antes);
  assert.equal(fixarLista(antes, []), antes);
});

test("migrar o modo antigo grava true ou false para tudo do catálogo: só o que o servidor ganhar depois é novo", () => {
  const antes = [{ name: "get_issue" }, { name: "create_comment" }, { name: "get_nova" }];
  const catalogo = [{ nome: "gh", ferramentas: antes }];
  const migrada = fixarLista({ connectionId: "github", tools: { "gh/get_nova": false } }, catalogo);
  assert.deepEqual(migrada.tools, { "gh/get_issue": true, "gh/create_comment": false, "gh/get_nova": false });
  assert.equal(contarDaConexao(migrada, catalogo).novas, 0);
  const comGanho = [{ nome: "gh", ferramentas: [...antes, { name: "list_commits" }] }];
  assert.equal(contarDaConexao(migrada, comGanho).novas, 1);
  assert.equal(fixarLista(migrada, comGanho), migrada, "salvar de novo não decide pela pessoa");
});

test("agent limitada vindo da main, com mapa vazio ou parcial, ganha a linha de base uma vez e depois só conta o que o servidor ganhou", () => {
  const base = [{ name: "list-chats" }, { name: "send-mail" }, { name: "get-event" }];
  const catalogo = [{ nome: "ms365", ferramentas: base }];
  for (const tools of [{}, { "ms365/get-event": true }] as Record<string, boolean>[]) {
    const daMain: { connectionId: string; leituraPadrao: "limitada"; linhaDeBase?: "feita"; tools: Record<string, boolean> } = { connectionId: "ms365", leituraPadrao: "limitada", tools };
    const fixada = fixarLista(daMain, catalogo);
    assert.deepEqual(fixada.tools, { "ms365/list-chats": false, "ms365/send-mail": false, "ms365/get-event": tools["ms365/get-event"] ?? false });
    assert.equal(fixada.linhaDeBase, "feita");
    assert.equal(contarDaConexao(fixada, catalogo).novas, 0);
    const comGanho = [{ nome: "ms365", ferramentas: [...base, { name: "list-files" }] }];
    assert.equal(contarDaConexao(fixada, comGanho).novas, 1);
    assert.equal(fixarLista(fixada, comGanho), fixada, "o segundo save não zera o aviso");
  }
});

test("conexão adicionada sem lista em cache: quando a lista chega, leitura liga, escrita fica desligada e o estado é normal", () => {
  const { tools, leituraPadrao, linhaDeBase } = escolhaInicial([{ nome: "gh", ferramentas: null }]);
  assert.deepEqual(tools, {});
  assert.equal(linhaDeBase, "pendente");
  const chegou = [{ nome: "gh", ferramentas: [{ name: "get_issue" }, { name: "create_comment" }] }];
  const fixada = fixarLista({ connectionId: "github", tools, leituraPadrao, linhaDeBase }, chegou);
  assert.deepEqual(fixada.tools, { "gh/get_issue": true, "gh/create_comment": false });
  assert.deepEqual(contarDaConexao(fixada, chegou), { total: 2, ligadas: 1, escrita: 0, novas: 0, conhecida: true });
  assert.equal(escolhaInicial([{ nome: "gh", ferramentas: [] }]).linhaDeBase, "feita");
});

