import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regra 6 do ADR 0006: escrita fora da máquina só sai de um passo de ação, pelos
 * handlers registrados em `src/executor/build.ts` e pela `approval/`. Este teste
 * lê o código-fonte de `src/` e falha quando uma função de escrita externa é
 * chamada fora da lista de permitidos abaixo.
 */

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(appDir, "src");

const AJUDA =
  "Escrita fora da máquina só sai de um passo de ação, pelos handlers registrados em src/executor/build.ts " +
  "(ADR 0006, regra 1, e CLAUDE.md, \"Todo efeito fora da máquina é um nó\"). Mova a chamada para um handler de ação; " +
  "se for uma leitura que o serviço faz por POST, ou a exceção do chat do agent, nomeie o arquivo na lista de permitidos deste teste, com o motivo.";

/** Os arquivos dos handlers que `build.ts` registra: tudo que ele importa com nome `...Handler`. */
export function arquivosDosHandlers(build: string): string[] {
  const achados: string[] = [];
  for (const m of build.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\.\/([^"]+)\.js"/g)) {
    if (/Handler/.test(m[1]!)) achados.push(`${m[2]}.ts`);
  }
  return achados;
}

interface Regra {
  nome: string;
  padrao: RegExp;
  /** Arquivos (ou prefixos terminados em `/`) onde a chamada é permitida, além dos handlers e de `approval/`. */
  permitidos: { onde: string; motivo: string }[];
}

const REGRAS: Regra[] = [
  {
    nome: "reagirNoTeams",
    padrao: /\breagirNoTeams\s*\(/,
    permitidos: [
      { onde: "teams/reaction.ts", motivo: "a definição" },
      { onde: "teams/react-action.ts", motivo: "o handler teams.react" },
    ],
  },
  {
    nome: "postSlackReply",
    padrao: /\bpostSlackReply\s*\(/,
    permitidos: [
      { onde: "slack/post.ts", motivo: "a definição" },
      { onde: "slack/action.ts", motivo: "o handler slack.post" },
    ],
  },
  {
    nome: "graphNativo.post (teams.post do Graph)",
    padrao: /\bteams\.post\s*\(/,
    permitidos: [
      { onde: "teams/graph.ts", motivo: "o transporte do Graph, usado só pelos handlers" },
      { onde: "teams/reaction.ts", motivo: "a função de reação, chamada só pelo handler teams.react" },
    ],
  },
  {
    nome: "octokit.rest.*.create/update/delete",
    padrao: /\.rest\.\w+\.(create|update|delete|add|remove|merge|submit|dismiss)\w*\s*\(/,
    permitidos: [{ onde: "sources/github.ts", motivo: "githubReviewHandler" }],
  },
  {
    nome: "createIssue dos trackers",
    padrao: /\bcreateIssue\s*\(/,
    permitidos: [
      { onde: "trackers/", motivo: "os adaptadores e o handler tracker.create_issue" },
      { onde: "services/tracker-service.ts", motivo: "o serviço que o handler chama" },
    ],
  },
  {
    nome: "ferramenta MCP de escrita pelo nome",
    padrao:
      /\b(chat_postMessage|slack_add_reaction|slack_remove_reaction|slack_post_message|slack_reply_to_thread|send-chat-message|send-channel-message|reply-to-chat-message|reply-to-channel-message|(?:un)?set-(?:chat|channel)-message-reaction)\b/,
    permitidos: [
      { onde: "teams/graph.ts", motivo: "o transporte do Teams por MCP, usado só pelos handlers" },
      { onde: "slack/react-action.ts", motivo: "o handler slack.react" },
      { onde: "services/slack-service.ts", motivo: "só o nome padrão da ferramenta do cadastro; quem chama é o handler slack.post" },
    ],
  },
  {
    nome: "fetch com método que não é GET",
    padrao: /method\s*:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/,
    permitidos: [
      { onde: "teams/graph.ts", motivo: "o transporte do Graph, usado só pelos handlers" },
      { onde: "trackers/", motivo: "os adaptadores dos trackers; a escrita é do handler, e a busca do Jira é leitura por POST" },
      { onde: "sources/slack-inbox.ts", motivo: "leitura por POST: assistant.search.context" },
      { onde: "slack/channels.ts", motivo: "leitura por POST: auth.test e a lista de canais" },
      { onde: "services/deep-link-service.ts", motivo: "OAuth: exchangeCode troca o código por token, não escreve em app de terceiros" },
      { onde: "mcp/", motivo: "OAuth dos servidores MCP (registro e troca de token)" },
      { onde: "agent-chat/conversas.ts", motivo: "exceção nomeada: o chat do agent só escreve com cartão de confirmação humano" },
    ],
  },
];

/** Tira comentários, para a regra não acusar o que só é citado em texto. */
function semComentarios(codigo: string): string {
  return codigo.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** Os arquivos (relativos a `src/`) que chamam função de escrita externa sem poder. */
export function violacoes(fontes: Record<string, string>, handlers: string[]): string[] {
  const achados: string[] = [];
  for (const [arquivo, bruto] of Object.entries(fontes)) {
    if (arquivo.startsWith("approval/") || handlers.includes(arquivo)) continue;
    const codigo = semComentarios(bruto);
    for (const regra of REGRAS) {
      if (!regra.padrao.test(codigo)) continue;
      if (regra.permitidos.some((p) => (p.onde.endsWith("/") ? arquivo.startsWith(p.onde) : arquivo === p.onde))) continue;
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

const handlersReais = arquivosDosHandlers(readFileSync(join(srcDir, "executor/build.ts"), "utf8"));

test("os handlers de build.ts são lidos do próprio arquivo", () => {
  for (const esperado of ["teams/react-action.ts", "slack/react-action.ts", "sources/github.ts", "teams/action.ts"]) {
    assert.ok(handlersReais.includes(esperado), `${esperado} deveria estar entre ${handlersReais.join(", ")}`);
  }
});

test("nenhum arquivo de src/ escreve fora da máquina sem ser handler de ação", () => {
  const achados = violacoes(lerFontes(srcDir), handlersReais);
  assert.deepEqual(achados, [], `${achados.join("\n")}\n\n${AJUDA}`);
});

test("a trava pega: reagirNoTeams chamado fora de handler, em fonte sintética, é violação", () => {
  const sintetico = {
    "sources/teams-inbox.ts": 'import { reagirNoTeams } from "../teams/reaction.js";\nawait reagirNoTeams(alvo, "set", "👀");',
  };
  assert.deepEqual(violacoes(sintetico, handlersReais), ["sources/teams-inbox.ts: reagirNoTeams"]);
  // O mesmo código no handler registrado não é violação, e citar em comentário não conta.
  assert.deepEqual(violacoes({ "teams/react-action.ts": sintetico["sources/teams-inbox.ts"] }, handlersReais), []);
  assert.deepEqual(violacoes({ "sources/x.ts": "// reagirNoTeams(alvo) era chamado aqui\n/* postSlackReply( */" }, handlersReais), []);
});

test("a trava pega cada função de escrita da lista, e o fetch não-GET", () => {
  const casos: [string, string][] = [
    ["postSlackReply(p, w)", "postSlackReply"],
    ["await teams.post(caminho, corpo, 'x')", "graphNativo.post (teams.post do Graph)"],
    ["await gh.rest.pulls.createReview({})", "octokit.rest.*.create/update/delete"],
    ["await gh.rest.issues.update({})", "octokit.rest.*.create/update/delete"],
    ["await service.createIssue(id, draft)", "createIssue dos trackers"],
    ['await reg.callTool("slack", "slack_add_reaction", a)', "ferramenta MCP de escrita pelo nome"],
    ['await call(s, "send-chat-message", a)', "ferramenta MCP de escrita pelo nome"],
    ['await fetch(u, { method: "DELETE" })', "fetch com método que não é GET"],
  ];
  for (const [codigo, regra] of casos) {
    assert.deepEqual(violacoes({ "sources/qualquer.ts": codigo }, handlersReais), [`sources/qualquer.ts: ${regra}`], codigo);
  }
  assert.deepEqual(violacoes({ "sources/qualquer.ts": 'await fetch(u, { method: "GET" })' }, handlersReais), []);
});
