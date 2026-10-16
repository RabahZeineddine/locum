import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regra 6 do ADR 0006: escrita fora da máquina só sai de um passo de ação, pelos
 * handlers registrados em `src/executor/build.ts` e pela `approval/`. Este teste
 * lê o código-fonte de `src/` e falha quando uma função de escrita externa
 * aparece fora da lista de arquivos de CADA regra. A permissão é por regra e por
 * arquivo nomeado: ser handler não isenta o arquivo inteiro (`sources/github.ts`
 * é também a fonte do polling), só o que a regra lista.
 */

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(appDir, "src");

const AJUDA =
  "Escrita fora da máquina só sai de um passo de ação, pelos handlers registrados em src/executor/build.ts " +
  "(ADR 0006, regra 1, e CLAUDE.md, \"Todo efeito fora da máquina é um nó\"). Mova a chamada para um handler de ação; " +
  "se for uma leitura que o serviço faz por POST, ou a exceção do chat do agent, nomeie o arquivo na regra certa deste teste, com o motivo.";

interface Regra {
  nome: string;
  acha: (codigo: string) => boolean;
  /** Os arquivos exatos (relativos a `src/`) onde a regra permite. Sem prefixo de pasta. */
  permitidos: { onde: string; motivo: string }[];
}

const contem = (re: RegExp) => (codigo: string) => re.test(codigo);

const REGRAS: Regra[] = [
  {
    // Sem o `(`: pega também o import renomeado (`reagirNoTeams as r`) e o `m.reagirNoTeams`.
    nome: "reagirNoTeams",
    acha: contem(/\breagirNoTeams\b/),
    permitidos: [
      { onde: "teams/reaction.ts", motivo: "a definição" },
      { onde: "teams/react-action.ts", motivo: "o handler teams.react" },
    ],
  },
  {
    nome: "postSlackReply",
    acha: contem(/\bpostSlackReply\b/),
    permitidos: [
      { onde: "slack/post.ts", motivo: "a definição" },
      { onde: "slack/action.ts", motivo: "o handler slack.post" },
    ],
  },
  {
    nome: "graphNativo.post (teams.post do Graph)",
    acha: contem(/\bteams\.post\s*\(/),
    permitidos: [
      { onde: "teams/graph.ts", motivo: "o transporte do Graph" },
      { onde: "teams/reaction.ts", motivo: "a função de reação, chamada só pelo handler teams.react" },
      { onde: "teams/action.ts", motivo: "o handler teams.post" },
    ],
  },
  {
    nome: ".post( em objeto de abrirTeams",
    acha: (c) => /\babrirTeams\b/.test(c) && /\.post\s*\(/.test(c),
    permitidos: [
      { onde: "teams/graph.ts", motivo: "o transporte do Graph" },
      { onde: "teams/reaction.ts", motivo: "a função de reação, chamada só pelo handler teams.react" },
      { onde: "teams/action.ts", motivo: "o handler teams.post" },
    ],
  },
  {
    nome: "pulls.createReview",
    acha: contem(/\.pulls\.createReview\b/),
    permitidos: [{ onde: "sources/github.ts", motivo: "githubReviewHandler (o arquivo é também a fonte do polling, que só lê)" }],
  },
  {
    nome: "octokit.rest.*.create/update/delete (fora de pulls.createReview)",
    acha: contem(/\.rest\.(?!pulls\.createReview\b)\w+\.(create|update|delete|add|remove|merge|submit|dismiss)\w*\s*\(/),
    permitidos: [],
  },
  {
    nome: "octokit.request com método que não é GET literal",
    acha: contem(/\.request\s*\((?!\s*["'`]GET\b)/),
    permitidos: [],
  },
  {
    nome: "createIssue dos trackers",
    acha: contem(/\bcreateIssue\b/),
    permitidos: [
      { onde: "trackers/registry.ts", motivo: "os adaptadores dos trackers" },
      { onde: "trackers/jira-atlassian.ts", motivo: "o adaptador do Jira" },
      { onde: "trackers/issue-action.ts", motivo: "o handler tracker.create_issue" },
      { onde: "services/tracker-service.ts", motivo: "o serviço que o handler chama" },
    ],
  },
  {
    nome: "ferramenta MCP de escrita pelo nome",
    acha: contem(
      /\b(chat_postMessage|slack_add_reaction|slack_remove_reaction|slack_post_message|slack_reply_to_thread|send-chat-message|send-channel-message|reply-to-chat-message|reply-to-channel-message|(?:un)?set-(?:chat|channel)-message-reaction)\b/,
    ),
    permitidos: [
      { onde: "teams/graph.ts", motivo: "o transporte do Teams por MCP" },
      { onde: "slack/react-action.ts", motivo: "o handler slack.react" },
      { onde: "services/slack-service.ts", motivo: "só o nome padrão da ferramenta do cadastro; quem chama é o handler slack.post" },
    ],
  },
  {
    // `callTool`, `chamarNoPool` e `registry.callTool` com a ferramenta vinda de variável: o nome literal é auditável, o outro não.
    nome: "callTool/chamarNoPool com nome de ferramenta não literal",
    acha: contem(/\b(?:callTool|chamarNoPool)\s*\(\s*[^,()]+,(?!\s*["'`])/),
    permitidos: [
      { onde: "mcp/registry.ts", motivo: "a definição do registro" },
      { onde: "executor/build.ts", motivo: "chamarNoPool: o handler mcp.call" },
      { onde: "slack/post.ts", motivo: "o handler slack.post (e a definição de callTool)" },
      { onde: "slack/react-action.ts", motivo: "o handler slack.react: a ferramenta é uma de duas constantes, de reação" },
      { onde: "teams/graph.ts", motivo: "o transporte do Teams, usado só pelos handlers e pelo polling de leitura" },
      { onde: "services/tracker-service.ts", motivo: "o serviço que o handler tracker.create_issue chama, e as leituras de cadastro" },
      { onde: "sources/mcp-poll.ts", motivo: "polling: ferramenta de leitura escolhida pela configuração do gatilho" },
      { onde: "sources/slack.ts", motivo: "polling: leitura do Slack" },
    ],
  },
  {
    nome: ".publish( fora de approval/gate.ts",
    acha: contem(/\.publish\s*\(/),
    permitidos: [{ onde: "approval/gate.ts", motivo: "a Fila é quem publica, depois do sim" }],
  },
  {
    // Chamar o handler direto pularia a Fila; a definição (`function xHandler(`) não conta.
    nome: "chamada de *Handler(",
    acha: contem(/(?<!function\s+)\b\w+Handler\s*\(/),
    permitidos: [{ onde: "executor/build.ts", motivo: "registra os handlers no gate" }],
  },
  {
    nome: "fetch com método que não é GET literal",
    acha: contem(/(?<![\w.])method\s*:(?!\s*["'`]GET["'`])/),
    permitidos: [
      { onde: "teams/graph.ts", motivo: "o transporte do Graph" },
      { onde: "trackers/registry.ts", motivo: "os adaptadores dos trackers; a escrita é do handler, e a busca do Jira é leitura por POST" },
      { onde: "actions/generic.ts", motivo: "o handler http.request" },
      { onde: "sources/slack-inbox.ts", motivo: "leitura por POST: assistant.search.context" },
      { onde: "slack/channels.ts", motivo: "leitura por POST: auth.test e a lista de canais" },
      { onde: "services/deep-link-service.ts", motivo: "OAuth: exchangeCode troca o código por token, não escreve em app de terceiros" },
      { onde: "pacote/formato.ts", motivo: "só o esquema zod do que o pacote descreve" },
      { onde: "agent-chat/conversas.ts", motivo: "exceção nomeada: o chat do agent só escreve com cartão de confirmação humano" },
    ],
  },
];

/** Tira comentários, para a regra não acusar o que só é citado em texto. */
function semComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Os arquivos (relativos a `src/`) que usam função de escrita externa sem poder, por regra. */
export function violacoes(fontes: Record<string, string>): string[] {
  const achados: string[] = [];
  for (const [arquivo, bruto] of Object.entries(fontes)) {
    const codigo = semComentarios(bruto);
    for (const regra of REGRAS) {
      if (!regra.acha(codigo)) continue;
      if (regra.permitidos.some((p) => arquivo === p.onde)) continue;
      achados.push(`${arquivo}: ${regra.nome}`);
    }
  }
  return achados;
}

function lerFontes(dir: string, base = dir): Record<string, string> {
  const fontes: Record<string, string> = {};
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) Object.assign(fontes, lerFontes(caminho, base));
    else if (nome.endsWith(".ts")) fontes[relative(base, caminho)] = readFileSync(caminho, "utf8");
  }
  return fontes;
}

test("nenhum arquivo de src/ escreve fora da máquina fora da lista de arquivos da regra", () => {
  const achados = violacoes(lerFontes(srcDir));
  assert.deepEqual(achados, [], `${achados.join("\n")}\n\n${AJUDA}`);
});

test("toda permissão da lista aponta para um arquivo que existe", () => {
  const fontes = lerFontes(srcDir);
  for (const regra of REGRAS) {
    for (const p of regra.permitidos) assert.ok(p.onde in fontes, `${regra.nome}: ${p.onde} não existe`);
  }
});

test("a trava pega: reagirNoTeams fora do handler, em fonte sintética, é violação, inclusive em handler de outra ação", () => {
  const codigo = 'import { reagirNoTeams } from "../teams/reaction.js";\nawait reagirNoTeams(alvo, "set", "👀");';
  assert.deepEqual(violacoes({ "sources/teams-inbox.ts": codigo }), ["sources/teams-inbox.ts: reagirNoTeams"]);
  // Handler de outra ação não herda a permissão do handler de reação.
  assert.deepEqual(violacoes({ "sources/github.ts": codigo }), ["sources/github.ts: reagirNoTeams"]);
  assert.deepEqual(violacoes({ "teams/action.ts": codigo }), ["teams/action.ts: reagirNoTeams"]);
  // O handler certo passa, e citar em comentário não conta.
  assert.deepEqual(violacoes({ "teams/react-action.ts": codigo }), []);
  assert.deepEqual(violacoes({ "sources/x.ts": "// reagirNoTeams(alvo) era chamado aqui\n/* postSlackReply( */" }), []);
});

test("a trava pega cada função de escrita da lista, e o fetch não-GET", () => {
  const casos: [string, string][] = [
    ["postSlackReply(p, w)", "postSlackReply"],
    ["await teams.post(caminho, corpo, 'x')", "graphNativo.post (teams.post do Graph)"],
    ["await gh.rest.pulls.createReview({})", "pulls.createReview"],
    ["await gh.rest.issues.update({})", "octokit.rest.*.create/update/delete (fora de pulls.createReview)"],
    ["await service.createIssue(id, draft)", "createIssue dos trackers"],
    ['await reg.callTool("slack", "slack_add_reaction", a)', "ferramenta MCP de escrita pelo nome"],
    ['await call(s, "send-chat-message", a)', "ferramenta MCP de escrita pelo nome"],
    ['await fetch(u, { method: "DELETE" })', "fetch com método que não é GET literal"],
  ];
  for (const [codigo, regra] of casos) {
    assert.deepEqual(violacoes({ "sources/qualquer.ts": codigo }), [`sources/qualquer.ts: ${regra}`], codigo);
  }
  assert.deepEqual(violacoes({ "sources/qualquer.ts": 'await fetch(u, { method: "GET" })' }), []);
});

test("a trava pega os furos: import renomeado, .post de abrirTeams, .publish, *Handler(, callTool, request e fetch dinâmicos", () => {
  const casos: [string, string][] = [
    ['import { reagirNoTeams as r } from "../teams/reaction.js";\nawait r(a, "set", "x");', "reagirNoTeams"],
    ['import { postSlackReply as enviar } from "../slack/post.js";', "postSlackReply"],
    ['import * as m from "../teams/reaction.js";\nm.reagirNoTeams(a);', "reagirNoTeams"],
    ['const t = await abrirTeams(o);\nawait t.post("/chats/1/messages", corpo);', ".post( em objeto de abrirTeams"],
    ["await handler.publish(payload, id);", ".publish( fora de approval/gate.ts"],
    ["const h = githubReviewHandler();", "chamada de *Handler("],
    ["await registry.callTool(server, tool, args);", "callTool/chamarNoPool com nome de ferramenta não literal"],
    ["await chamarNoPool(\n  server,\n  tool,\n  args,\n);", "callTool/chamarNoPool com nome de ferramenta não literal"],
    ['await octokit.request("POST /repos/{o}/{r}/issues", p);', "octokit.request com método que não é GET literal"],
    ["await octokit.request(rota, p);", "octokit.request com método que não é GET literal"],
    ["await fetch(u, { method: verbo });", "fetch com método que não é GET literal"],
    ["await fetch(u, { method: p.method });", "fetch com método que não é GET literal"],
  ];
  for (const [codigo, regra] of casos) {
    assert.deepEqual(violacoes({ "sources/qualquer.ts": codigo }), [`sources/qualquer.ts: ${regra}`], codigo);
  }
  // Não acusa: leitura por GET, ferramenta de nome literal que não é de escrita, definição de handler.
  const limpos = ['await octokit.request("GET /repos/{o}/{r}", p);', 'await registry.callTool("jira", "search", a);', "export function umHandler() {}"];
  for (const codigo of limpos) assert.deepEqual(violacoes({ "sources/qualquer.ts": codigo }), [], codigo);
  // E a permissão é por arquivo: nem o prefixo da pasta vale.
  assert.deepEqual(violacoes({ "trackers/outro.ts": 'fetch(u, { method: "POST" })' }), ["trackers/outro.ts: fetch com método que não é GET literal"]);
  assert.deepEqual(violacoes({ "mcp/outro.ts": 'fetch(u, { method: "POST" })' }), ["mcp/outro.ts: fetch com método que não é GET literal"]);
});
