import { test } from "node:test";
import assert from "node:assert/strict";
import { criarI18n } from "../renderer/lib/i18n.js";
import { tradutorDe } from "../renderer/lib/operacao-da-ferramenta.js";
import {
  appDoServidor,
  fonteDaMarca,
  servidorDoNoVazio,
  appsDaPaleta,
  buscarNaPaleta,
  nomeDoApp,
  operacoesDoApp,
  passoDaOperacao,
  passoSemOperacao,
  reconhecerPasso,
  type OperacaoDoApp,
} from "../renderer/lib/apps-da-paleta.js";
import type { ConexaoParaPaleta } from "../renderer/lib/paleta-conexoes.js";
import type { AgentSpec, Step } from "../src/config/types.js";

const pt = tradutorDe(criarI18n({ idioma: "pt-BR", estrito: false }));
const en = tradutorDe(criarI18n({ idioma: "en", estrito: false }));

const CONEXOES: ConexaoParaPaleta[] = [
  {
    servidor: "slack",
    ferramentas: [
      { name: "slack_post_message", inputSchema: { properties: { channel_id: {}, text: {} } } },
      { name: "slack_add_reaction", inputSchema: { properties: { channel_id: {}, timestamp: {}, reaction: {} } } },
      { name: "slack_get_channel_history", readOnlyHint: true, inputSchema: { properties: { channel_id: {}, limit: {} } } },
    ],
  },
  {
    servidor: "ms365",
    ferramentas: [
      { name: "send-mail" },
      { name: "list-mail-messages", readOnlyHint: true },
      { name: "set-chat-message-reaction" },
      { name: "get-me", readOnlyHint: true },
    ],
  },
  { servidor: "github", ferramentas: [{ name: "list_issues", readOnlyHint: true }, { name: "get_me", readOnlyHint: true }] },
  { servidor: "locum-fixture", ferramentas: [{ name: "echo", readOnlyHint: true }] },
  { servidor: "novo", ferramentas: null },
];

const SPEC = { id: "a", name: "A", steps: [] } as unknown as AgentSpec;

test("o servidor pertence ao app pelo id conhecido; o desconhecido é o próprio app", () => {
  assert.equal(appDoServidor("slack"), "slack");
  assert.equal(appDoServidor("Slack-MCP"), "slack");
  assert.equal(appDoServidor("github"), "github");
  assert.equal(appDoServidor("ms365"), "microsoft365");
  assert.equal(appDoServidor("microsoft-graph"), "microsoft365");
  assert.equal(appDoServidor("teams-mcp"), "teams");
  for (const s of ["jira", "atlassian", "shortcut"]) assert.equal(appDoServidor(s), "tracker");
  assert.equal(appDoServidor("locum-fixture"), "locum-fixture");
});

test("a paleta tem os apps do Locum e um por servidor desconhecido, sem duplicar", () => {
  const ids = appsDaPaleta(CONEXOES).map((a) => a.id);
  assert.deepEqual(ids, ["teams", "slack", "github", "tracker", "http", "microsoft365", "locum-fixture", "novo"]);
  const slack = appsDaPaleta(CONEXOES).find((a) => a.id === "slack")!;
  assert.deepEqual([slack.nativas, slack.servidores], [["slack.post", "slack.react"], ["slack"]]);
  assert.equal(appsDaPaleta(CONEXOES).find((a) => a.id === "novo")!.semLista, true);
  assert.equal(appsDaPaleta(CONEXOES).find((a) => a.id === "teams")!.nativas.length, 2);
});

test("nomes dos apps", () => {
  assert.equal(nomeDoApp("microsoft365", pt), "Microsoft 365");
  assert.equal(nomeDoApp("teams", pt), "Teams");
  assert.equal(nomeDoApp("locum-fixture", pt), "Locum fixture");
});

test("as ações do Locum vêm primeiro, marcadas, e as ferramentas agrupadas por recurso", () => {
  const { nativas, grupos } = operacoesDoApp("slack", CONEXOES, pt);
  assert.deepEqual(nativas.map((o) => [o.acao, o.titulo, o.leitura]), [
    ["slack.post", "Enviar mensagem", false],
    ["slack.react", "Reagir", false],
  ]);
  assert.deepEqual(grupos.map((g) => [g.recurso, g.itens.map((i) => i.titulo)]), [
    ["message", ["Enviar mensagem"]],
    ["reaction", ["Reagir"]],
    ["channel", ["Ler canal"]],
  ]);
  assert.equal(grupos[2]!.itens[0]!.leitura, true);
});

test("as ferramentas de chat do ms365 vão para o Teams, e o resto fica no Microsoft 365, sem repetir", () => {
  const teams = operacoesDoApp("teams", CONEXOES, pt);
  assert.deepEqual(teams.nativas.map((o) => o.acao), ["teams.post", "teams.react"]);
  assert.deepEqual(teams.grupos.map((g) => [g.recurso, g.itens.map((i) => [i.servidor, i.ferramenta])]), [["reaction", [["ms365", "set-chat-message-reaction"]]]]);
  const m365 = operacoesDoApp("microsoft365", CONEXOES, pt);
  assert.deepEqual(m365.grupos.map((g) => [g.recurso, g.itens.map((i) => i.ferramenta)]), [["mail", ["send-mail", "list-mail-messages"]], [null, ["get-me"]]]);
  const apps = appsDaPaleta(CONEXOES);
  assert.deepEqual(apps.find((a) => a.id === "teams")!.servidores, ["ms365"]);
  assert.deepEqual(apps.find((a) => a.id === "microsoft365")!.servidores, ["ms365"]);
});

test("app que junta mais de um servidor expõe todos, para cada operação mostrar o dela", () => {
  const conexoes: ConexaoParaPaleta[] = [
    { servidor: "jira", ferramentas: [{ name: "create_issue" }] },
    { servidor: "shortcut", ferramentas: [{ name: "stories-create" }] },
  ];
  const { grupos, servidores } = operacoesDoApp("tracker", conexoes, pt);
  assert.deepEqual(servidores, ["jira", "shortcut"]);
  assert.deepEqual(grupos[0]!.itens.map((i) => [i.titulo, i.servidor]), [["Criar issue", "jira"]]);
  assert.deepEqual(operacoesDoApp("slack", CONEXOES, pt).servidores, ["slack"]);
});

test("busca acha operação em qualquer app e já devolve a operação", () => {
  const { apps, operacoes } = buscarNaPaleta(CONEXOES, "reagir", pt);
  assert.deepEqual(apps, []);
  assert.deepEqual(operacoes.map((o) => [o.app, o.titulo]), [
    ["teams", "Reagir à mensagem"],
    ["slack", "Reagir"],
    ["teams", "Reagir"],
    ["slack", "Reagir"],
  ]);
  assert.deepEqual(operacoes.map((o) => o.acao !== undefined), [true, true, false, false]);
});

test("busca pelo nome do app acha o app, e em inglês acha o verbo em inglês", () => {
  assert.deepEqual(buscarNaPaleta(CONEXOES, "slack", pt).apps.map((a) => a.id), ["slack"]);
  assert.deepEqual(buscarNaPaleta(CONEXOES, "react", en).operacoes.map((o) => o.titulo), ["React to message", "React", "React", "React"]);
  assert.deepEqual(buscarNaPaleta(CONEXOES, "", pt), { apps: appsDaPaleta(CONEXOES), operacoes: [] });
});

const base = { key: "k", name: "x", needs: [], optional: false };

test("passo gravado é reconhecido como app e operação, sem migração", () => {
  const rec = (p: Partial<Step> & { type: string }) => reconhecerPasso({ ...base, ...p } as Step);
  assert.deepEqual(rec({ type: "action", action: "teams.post", mode: "approve" }), { app: "teams", operacao: { tipo: "nativa", acao: "teams.post" } });
  assert.deepEqual(rec({ type: "action", action: "teams.react", mode: "approve" }).app, "teams");
  assert.equal(rec({ type: "action", action: "slack.react", mode: "approve" }).app, "slack");
  assert.equal(rec({ type: "action", action: "github.review_comment", mode: "approve" }).app, "github");
  assert.equal(rec({ type: "action", action: "tracker.create_issue", mode: "approve" }).app, "tracker");
  assert.deepEqual(rec({ type: "action", action: "http.request", mode: "approve" }), { app: "http", operacao: { tipo: "nativa", acao: "http.request" } });
  assert.deepEqual(
    rec({ type: "action", action: "mcp.call", mode: "approve", params: { server: "ms365", tool: "send-mail", args: {} } }),
    { app: "microsoft365", operacao: { tipo: "ferramenta", servidor: "ms365", ferramenta: "send-mail" } },
  );
  assert.deepEqual(rec({ type: "model", model: "m", prompt: "" } as never), { app: "ia", operacao: { tipo: "modelo" } });
  assert.deepEqual(rec({ type: "logic", op: "if" } as never), { app: "logica", operacao: { tipo: "logica", op: "if" } });
});

test("a ferramenta de chat do ms365 é reconhecida como Teams, a de e-mail como Microsoft 365", () => {
  const rec = (tool: string) => reconhecerPasso({ ...base, type: "action", action: "mcp.call", mode: "approve", params: { server: "ms365", tool } } as Step).app;
  assert.deepEqual([rec("send-chat-message"), rec("send-mail")], ["teams", "microsoft365"]);
});

test("mcp.call sem ferramenta é um app sem operação", () => {
  assert.deepEqual(
    reconhecerPasso({ ...base, type: "action", action: "mcp.call", mode: "approve", params: { server: "slack", tool: "" } } as Step),
    { app: "slack", operacao: { tipo: "vazia" } },
  );
  assert.deepEqual(reconhecerPasso({ ...base, type: "action", action: "mcp.call", mode: "approve" } as Step).operacao, { tipo: "vazia" });
});

test("o nó novo do app nasce sem operação e continua no mesmo app", () => {
  const passo = passoSemOperacao(SPEC, "microsoft365", "Microsoft 365", "ms365");
  assert.deepEqual(reconhecerPasso(passo), { app: "microsoft365", operacao: { tipo: "vazia" } });
  assert.equal(passo.mode, "approve");
  const teams = passoSemOperacao(SPEC, "teams", "Teams");
  assert.equal(reconhecerPasso(teams).app, "teams");
});

function op(app: string, ferramenta: string): OperacaoDoApp {
  return operacoesDoApp(app, CONEXOES, pt).grupos.flatMap((g) => g.itens).find((o) => o.ferramenta === ferramenta)!;
}

test("escolher a operação vira o passo real, e a nativa vira a ação do Locum", () => {
  const vazio = passoSemOperacao(SPEC, "slack", "Slack", "slack");
  const leitura = passoDaOperacao(SPEC, op("slack", "slack_get_channel_history"), vazio) as Extract<Step, { type: "action" }>;
  assert.deepEqual([leitura.key, leitura.action, leitura.params], [vazio.key, "mcp.call", { server: "slack", tool: "slack_get_channel_history", args: {} }]);
  assert.equal(leitura.mode, "approve");
  const nativa = operacoesDoApp("teams", CONEXOES, pt).nativas.find((o) => o.acao === "teams.react")!;
  const passo = passoDaOperacao(SPEC, nativa, passoSemOperacao(SPEC, "teams", "Teams")) as Extract<Step, { type: "action" }>;
  assert.deepEqual([passo.action, passo.mode], ["teams.react", "approve"]);
});

test("trocar a operação mantém os campos de mesmo nome, rebaixa o modo e não herda autoEscrita", () => {
  const anterior: Step = {
    ...base,
    name: "Minha resposta",
    needs: ["gatilho"],
    type: "action",
    action: "mcp.call",
    mode: "auto",
    params: { server: "slack", tool: "slack_get_channel_history", args: { channel_id: "C1", limit: 5 }, autoEscrita: true },
  } as Step;
  const novo = passoDaOperacao(SPEC, op("slack", "slack_post_message"), anterior) as Extract<Step, { type: "action" }>;
  assert.deepEqual(novo.params, { server: "slack", tool: "slack_post_message", args: { channel_id: "C1" } });
  assert.equal(novo.mode, "approve");
  assert.deepEqual([novo.key, novo.name, novo.needs], ["k", "Minha resposta", ["gatilho"]]);
  // leitura continua em automático quando o anterior estava.
  const leitura = passoDaOperacao(SPEC, op("slack", "slack_get_channel_history"), { ...anterior, params: { server: "slack", tool: "slack_post_message", args: {} } } as Step);
  assert.equal(leitura.type === "action" && leitura.mode, "auto");
});

test("o nome padrão acompanha a operação, o renomeado fica", () => {
  const vazio = passoSemOperacao(SPEC, "slack", "Slack", "slack");
  const a = passoDaOperacao(SPEC, op("slack", "slack_post_message"), vazio);
  const b = passoDaOperacao(SPEC, op("slack", "slack_add_reaction"), a);
  assert.notEqual(a.name, b.name);
  assert.equal(b.name, "Slack add reaction");
  const renomeado = passoDaOperacao(SPEC, op("slack", "slack_add_reaction"), { ...a, name: "Avisar o time" });
  assert.equal(renomeado.name, "Avisar o time");
});

test("ícone e servidor do nó vazio vêm do app", () => {
  const apps = appsDaPaleta(CONEXOES);
  const por = (id: string) => apps.find((a) => a.id === id)!;
  assert.deepEqual([fonteDaMarca(por("slack")), fonteDaMarca(por("microsoft365")), fonteDaMarca(por("tracker")), fonteDaMarca(por("locum-fixture"))], ["slack", "ms365", "atlassian", "locum-fixture"]);
  assert.deepEqual([servidorDoNoVazio(por("slack")), servidorDoNoVazio(por("http")), servidorDoNoVazio(por("microsoft365"))], ["slack", "http", "ms365"]);
});
