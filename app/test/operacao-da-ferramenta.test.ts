import { test } from "node:test";
import assert from "node:assert/strict";
import { criarI18n } from "../renderer/lib/i18n.js";
import {
  agruparPor,
  classificarOperacao,
  tituloDaOperacao,
  tituloDoGrupo,
  tradutorDe,
} from "../renderer/lib/operacao-da-ferramenta.js";

const pt = tradutorDe(criarI18n({ idioma: "pt-BR", estrito: false }));
const en = tradutorDe(criarI18n({ idioma: "en", estrito: false }));

/** Nomes reais escritos à mão, de cada servidor, com o que a pessoa deve ver. */
const SLACK: [string, string | undefined, string, string | null][] = [
  ["slack_post_message", "slack", "write", "message"],
  ["slack_reply_to_thread", "slack", "write", "thread"],
  ["slack_add_reaction", "slack", "write", "reaction"],
  ["slack_get_channel_history", "slack", "read", "message"],
  ["slack_list_channels", "slack", "read", "channel"],
  ["slack_get_thread_replies", "slack", "read", "thread"],
  ["slack_get_users", "slack", "read", "user"],
  ["slack_get_user_profile", "slack", "read", "user"],
  ["conversations_history", "slack", "read", "message"],
];
const MS365: [string, string | undefined, string, string | null][] = [
  ["send-mail", "ms365", "write", "mail"],
  ["list-mail-messages", "ms365", "read", "mail"],
  ["send-chat-message", "ms365", "write", "message"],
  ["list-chat-messages", "ms365", "read", "message"],
  ["set-chat-message-reaction", "ms365", "update", "reaction"],
  ["create-calendar-event", "ms365", "write", "event"],
  ["delete-calendar-event", "ms365", "delete", "event"],
  ["list-joined-teams", "ms365", "read", "team"],
  ["upload-file-content", "ms365", "write", "file"],
  ["download-bytes", "ms365", "read", null],
  ["list-mail-folder-messages", "ms365", "read", "mail"],
  ["list-mail-folders", "ms365", "read", "folder"],
  ["list-drives", "ms365", "read", "drive"],
  ["list-folder-files", "ms365", "read", "file"],
  ["list-chat-message-replies", "ms365", "read", "message"],
];
const GITHUB: [string, string | undefined, string, string | null][] = [
  ["create_pull_request", "github", "write", "pull_request"],
  ["pull_request_read", "github", "read", "pull_request"],
  ["get_file_contents", "github", "read", "file"],
  ["list_issues", "github", "read", "issue"],
  ["issue_read", "github", "read", "issue"],
  ["issue_write", "github", "write", "issue"],
  ["add_issue_comment", "github", "write", "comment"],
  ["pull_request_review_write", "github", "write", "review"],
  ["merge_pull_request", "github", "update", "pull_request"],
  ["list_commits", "github", "read", "commit"],
  ["create_branch", "github", "write", "branch"],
  ["get_me", "github", "read", null],
  ["search_code", "github", "read", null],
  ["request_copilot_review", "github", "write", "review"],
  ["submit_pending_pull_request_review", "github", "write", "review"],
];

for (const [nome, servidor, acao, recurso] of [...SLACK, ...MS365, ...GITHUB]) {
  test(`${servidor}: ${nome} é ${acao} de ${recurso ?? "nada conhecido"}`, () => {
    const c = classificarOperacao(nome, servidor);
    assert.equal(c.acao, acao);
    assert.equal(c.recurso, recurso);
  });
}

test("nome sem verbo nem substantivo conhecido cai na regra de leitura do executor", () => {
  assert.deepEqual(classificarOperacao("graphql"), { acao: "write", verbo: null, recurso: null, detalhe: null });
  assert.equal(classificarOperacao("whoami").acao, "read");
});

test("o prefixo mcp__servidor__ e o camelCase não atrapalham", () => {
  const c = classificarOperacao("mcp__slack__addReaction");
  assert.deepEqual([c.acao, c.recurso], ["write", "reaction"]);
});

test("títulos em português", () => {
  assert.equal(tituloDaOperacao("slack_post_message", pt, "slack"), "Enviar mensagem");
  assert.equal(tituloDaOperacao("slack_list_channels", pt, "slack"), "Listar canais");
  assert.equal(tituloDaOperacao("slack_add_reaction", pt, "slack"), "Reagir");
  assert.equal(tituloDaOperacao("slack_get_channel_history", pt, "slack"), "Ler mensagens do canal");
  assert.equal(tituloDaOperacao("set-chat-message-reaction", pt, "ms365"), "Reagir");
  assert.equal(tituloDaOperacao("create_pull_request", pt, "github"), "Criar pull request");
  assert.equal(tituloDaOperacao("list-mail-messages", pt, "ms365"), "Listar e-mails");
  assert.equal(tituloDaOperacao("delete-calendar-event", pt, "ms365"), "Apagar evento");
});

test("títulos em inglês", () => {
  assert.equal(tituloDaOperacao("slack_post_message", en, "slack"), "Send message");
  assert.equal(tituloDaOperacao("list_issues", en, "github"), "List issues");
  assert.equal(tituloDaOperacao("slack_add_reaction", en, "slack"), "React");
  assert.equal(tituloDaOperacao("slack_get_channel_history", en, "slack"), "Read channel messages");
});

test("sem tradução conhecida, cai no nome humanizado", () => {
  assert.equal(tituloDaOperacao("get_me", pt, "github"), "Get me");
  assert.equal(tituloDaOperacao("download-bytes", pt, "ms365"), "Download bytes");
  assert.equal(tituloDaOperacao("mcp__x__frobnicate_widget", pt), "Frobnicate widget");
});

test("agrupa por recurso, na ordem em que aparecem, e deixa Outras por último", () => {
  const itens = ["get_me", "list_issues", "create_pull_request", "issue_write", "get_file_contents"].map((nome) => ({ nome }));
  const grupos = agruparPor(itens, (i) => classificarOperacao(i.nome, "github").recurso);
  assert.deepEqual(
    grupos.map((g) => [g.recurso, g.itens.map((i) => i.nome)]),
    [
      ["issue", ["list_issues", "issue_write"]],
      ["pull_request", ["create_pull_request"]],
      ["file", ["get_file_contents"]],
      [null, ["get_me"]],
    ],
  );
  assert.equal(tituloDoGrupo("issue", pt), "Issues");
  assert.equal(tituloDoGrupo(null, pt), "Outras");
  assert.equal(tituloDoGrupo("message", en), "Messages");
});

test("operações parecidas de um mesmo servidor não repetem o título", () => {
  const pares: [string, string, string][] = [
    ["ms365", "list-mail-messages", "list-mail-folders"],
    ["ms365", "list-drives", "list-folder-files"],
    ["ms365", "list-chat-messages", "list-chat-message-replies"],
    ["slack", "slack_get_users", "slack_get_user_profile"],
    ["github", "request_copilot_review", "submit_pending_pull_request_review"],
    ["slack", "slack_get_channel_history", "slack_post_message"],
  ];
  for (const [servidor, a, b] of pares) {
    assert.notEqual(tituloDaOperacao(a, pt, servidor), tituloDaOperacao(b, pt, servidor), `${a} e ${b}`);
    assert.notEqual(tituloDaOperacao(a, en, servidor), tituloDaOperacao(b, en, servidor), `${a} e ${b} em inglês`);
  }
  assert.equal(tituloDaOperacao("conversations_history", pt, "slack"), "Ler mensagens do canal");
  assert.equal(tituloDaOperacao("slack_get_user_profile", pt, "slack"), "Ler perfil do usuário");
});
