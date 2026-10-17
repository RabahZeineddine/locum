import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSpec } from "../src/config/types.js";
import { lerPacote, NOME_DO_FORMATO, PacoteInvalidoError, VERSAO_DO_FORMATO } from "../src/pacote/formato.js";
import { AgentService } from "../src/services/agent-service.js";
import { AutomationService } from "../src/services/automation-service.js";
import { LibraryService } from "../src/services/library-service.js";
import { McpService } from "../src/services/mcp-service.js";
import { DecisaoPendenteError, diferencasDoAgent, PacoteService, pacoteDoComando, type AmbienteDoPacote } from "../src/services/pacote-service.js";
import { SecretService } from "../src/services/secret-service.js";
import { TriggerService } from "../src/services/trigger-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/**
 * Exportar e importar em pacote. A interface pública é `PacoteService`: cada
 * máquina de teste é um banco próprio, e o ambiente (conexões, servidores e
 * provedores de lá) é dado por quem monta o teste.
 */

const SEGREDO_DO_COFRE = "cofre-valor-que-nunca-sai-1f9c";
/** Junta pedaços: um token de mentira inteiro no código acende a proteção de push do GitHub. */
const j = (...partes: string[]): string => partes.join("");
const TOKEN_NO_ENV = j("gh", "p_abcdefghijklmnopqrstuvwxyz0123456789");
const TOKEN_NO_CABECALHO = "bearer-secreto-do-cabecalho-77aa";
const CANAL_DO_SLACK = "C0123ABCD45";
const CHAT_DO_TEAMS = "19:abcdef0123456789abcdef0123456789@thread.v2";
const EQUIPE_DO_TEAMS = "3f2c1a9e-1b2d-4c3e-8f4a-5b6c7d8e9f01";
const CANAL_DO_TEAMS = "19:0123456789abcdef0123456789abcdef@thread.tacv2";
const EMAIL = "ana.souza@empresa.com.br";
const HOME = "/Users/ana.souza";

const ambientePadrao = (parte: Partial<AmbienteDoPacote> = {}): AmbienteDoPacote => ({
  conexoes: async () => [],
  servidores: async () => [],
  guardadas: async () => null,
  skills: async () => ["review-pr"],
  provedores: async () => [{ provedor: "claude-code", disponivel: true, modelos: ["claude-sonnet-5", "claude-opus-5"] }],
  ...parte,
});

function maquina(opcoes: { ambiente?: (mcp: McpService) => Partial<AmbienteDoPacote>; cofre?: SecretService } = {}) {
  const db = bancoDeTeste();
  const agents = new AgentService(db);
  const triggers = new TriggerService(db);
  const automations = new AutomationService(agents, triggers, {} as never);
  const library = new LibraryService(db, { servidoresDe: async () => [], ferramentasDe: async () => [] });
  const mcp = new McpService(db, opcoes.cofre);
  const ambiente = ambientePadrao(opcoes.ambiente?.(mcp));
  const pacotes = new PacoteService(agents, library, automations, ambiente, HOME);
  return { db, agents, triggers, automations, library, mcp, pacotes, ambiente };
}
type Maquina = ReturnType<typeof maquina>;

/** Servidores cadastrados como o ambiente real os conta: nome, endereço e comando, nunca segredo. */
const servidoresDo = (mcp: McpService): AmbienteDoPacote["servidores"] => async () =>
  (await mcp.list()).map((s) => ({
    nome: s.config.name,
    ligado: s.enabled,
    ...(s.config.url === undefined ? {} : { url: s.config.url }),
    ...(s.config.command === undefined ? {} : { command: s.config.command }),
  }));

/** A automação de revisão do dono, montada com tudo que não pode sair. */
async function montarAutomacao(m: Maquina, id = "revisao-de-pr"): Promise<void> {
  await m.mcp.register({
    name: "ms365",
    transport: "stdio",
    command: ["npx", "-y", "@softeria/ms-365-mcp-server@1.2.3", "--token-file", `${HOME}/.tokens/ms365.json`],
    env: { GITHUB_TOKEN: TOKEN_NO_ENV },
    headers: { Authorization: `Bearer ${TOKEN_NO_CABECALHO}` },
  });
  await m.library.saveProfile({
    spec: {
      id: "revisor",
      name: "Revisor",
      description: "Revisa PR",
      context: `Time de pagamentos. Fale com ${EMAIL} em caso de dúvida.`,
      instructions: `Siga as regras em ${HOME}/docs/regras.md.`,
      model: "claude-code/claude-sonnet-5",
      connections: [
        { connectionId: "github", tools: {} },
        { connectionId: "ms365", tools: { "ms365/list-chats": true } },
      ],
      skills: ["review-pr"],
      budget: { perRunUsd: 1 },
    },
  });
  const spec: AgentSpec = {
    id,
    name: "Revisão de PR",
    defaultTools: [],
    skills: [],
    budget: { perRunUsd: 0.4 },
    steps: [
      {
        type: "model", key: "revisar", name: "Revisar", needs: [], optional: false,
        model: "claude-code/claude-sonnet-5", prompt: `Revise {{event.repo}}#{{event.pull}}. Canal ${CANAL_DO_SLACK}.`,
        requiresServers: [], maxSteps: 12, profile: "revisor",
      },
      {
        type: "action", key: "responder", name: "Responder", needs: ["revisar"], optional: false,
        action: "teams.post", mode: "approve", input: "revisar", target: "tracker-do-dono",
      },
      {
        type: "action", key: "avisar", name: "Avisar", needs: ["revisar"], optional: false,
        action: "mcp.call", mode: "auto",
        params: {
          server: "ms365", tool: "send-chat-message",
          args: { chatId: CHAT_DO_TEAMS }, headers: { Authorization: `Bearer ${TOKEN_NO_CABECALHO}` },
        },
      },
    ],
    layout: { revisar: { x: 10, y: 20 } },
  };
  await m.automations.save({
    spec,
    note: "",
    create: true,
    triggers: [
      {
        config: {
          kind: "teams-inbox", prLinks: true, mentions: false, dms: false,
          filtroIa: { pergunta: `É um pedido de review? Veja ${HOME}/notas e escreva para ${EMAIL}`, modelo: "claude-code/haiku" },
          channels: [{ teamId: EQUIPE_DO_TEAMS, channelId: CANAL_DO_TEAMS, label: "Pagamentos" }],
          chats: [{ chatId: CHAT_DO_TEAMS, label: "Revisões" }],
        },
        enabled: true,
      },
      { config: { kind: "slack-channel", channels: [CANAL_DO_SLACK] }, enabled: true },
      {
        config: {
          kind: "poll", source: "github", owner: "empresa-ana", repoMatch: "pagamentos-.*", authorship: "others",
          filters: { authors: { include: ["ana-souza"] }, labels: { include: ["review"] } },
        },
        enabled: true,
      },
      { config: { kind: "cron", expression: "0 9 * * 1-5" }, enabled: false },
    ],
  });
}

const comServidor = { ambiente: servidoresDo };

/* ------------------------------------------------------------- exportação */

test("exportar gera o formato versionado com fluxo, agents e o que a outra máquina precisa", async () => {
  const m = maquina({ ambiente: (mcp) => ({ servidores: servidoresDo(mcp) }) });
  await montarAutomacao(m);
  const { pacote, texto, nomeDoArquivo } = await m.pacotes.exportar("revisao-de-pr");

  assert.equal(nomeDoArquivo, "revisao-de-pr.locum.json");
  assert.equal(pacote.formato, NOME_DO_FORMATO);
  assert.equal(pacote.versao, VERSAO_DO_FORMATO);
  assert.equal(pacote.automacao.id, "revisao-de-pr");
  assert.deepEqual(pacote.automacao.spec.steps.map((p) => p.key), ["revisar", "responder", "avisar"]);
  assert.deepEqual(pacote.automacao.gatilhos.map((g) => g.kind), ["teams-inbox", "slack-channel", "poll", "cron"]);

  const revisor = pacote.agents.find((a) => a.id === "revisor");
  assert.equal(revisor?.model, "claude-code/claude-sonnet-5");
  assert.deepEqual(revisor?.skills, [{ skill: "review-pr", when: { always: true } }]);
  assert.deepEqual(revisor?.budget, { perRunUsd: 1 });
  assert.deepEqual(revisor?.connections[1]?.tools, { "ms365/list-chats": true });

  assert.deepEqual(pacote.requisitos.conexoes.map((c) => c.id), ["github", "slack", "teams"]);
  assert.deepEqual(pacote.requisitos.servidores, [{ nome: "ms365", pacote: "@softeria/ms-365-mcp-server", conexao: "teams" }]);
  assert.deepEqual(pacote.requisitos.provedores, [{ provedor: "claude-code", modelos: ["claude-sonnet-5"] }]);
  // O texto é o mesmo objeto, e volta pelo leitor sem perda.
  assert.deepEqual(lerPacote(texto), pacote);
});

test("o pacote exportado não carrega segredo, id de canal, conta, e-mail nem caminho do home", async () => {
  const pasta = mkdtempSync(join(tmpdir(), "locum-cofre-"));
  try {
    const cofre = new SecretService(pasta);
    cofre.useBackend({ available: () => true, encrypt: (t) => Buffer.from(t), decrypt: (b) => b.toString() });
    cofre.set("mcp/ms365", SEGREDO_DO_COFRE);
    const m = maquina({ cofre, ambiente: (mcp) => ({ servidores: servidoresDo(mcp) }) });
    await montarAutomacao(m);

    const { texto, pacote } = await m.pacotes.exportar("revisao-de-pr");
    const proibidos: [string, string][] = [
      ["segredo do cofre", SEGREDO_DO_COFRE],
      ["token do env", TOKEN_NO_ENV],
      ["token do cabeçalho", TOKEN_NO_CABECALHO],
      ["canal do Slack", CANAL_DO_SLACK],
      ["chat do Teams", CHAT_DO_TEAMS],
      ["equipe do Teams", EQUIPE_DO_TEAMS],
      ["canal do Teams", CANAL_DO_TEAMS],
      ["e-mail", EMAIL],
      ["home de teste", HOME],
      ["home da máquina", homedir()],
      ["dono do GitHub", "empresa-ana"],
      ["autor filtrado", "ana-souza"],
      ["tracker local", "tracker-do-dono"],
      ["arquivo de token", ".tokens"],
      ["rótulo do canal", "Pagamentos"],
    ];
    for (const [rotulo, valor] of proibidos) assert.ok(!texto.includes(valor), `o pacote vazou: ${rotulo}`);
    assert.doesNotMatch(texto, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, "sobrou algo com cara de e-mail");
    assert.doesNotMatch(texto, /\/(?:Users|home)\//, "sobrou caminho de home");
    for (const chave of ["credentialRef", "cursor", "headers", "env", "lastError", "channelId", "teamId", "chatId"]) {
      assert.ok(!texto.includes(`"${chave}":`), `o pacote tem o campo ${chave}`);
    }

    // O que ficou de fora é dito, para a prévia pedir à pessoa.
    const codigos = new Set(pacote.omitidos.map((o) => o.codigo));
    for (const esperado of ["canais", "dono-do-github", "filtros-de-pessoa", "tracker", "argumentos", "texto-limpo"] as const) {
      assert.ok(codigos.has(esperado), `faltou avisar ${esperado}`);
    }
    // O que serve de sugestão continua: servidor e ferramenta do passo, sem o argumento que era um id.
    const aviso = pacote.automacao.spec.steps.find((p) => p.key === "avisar");
    assert.deepEqual(aviso?.type === "action" && aviso.params, { server: "ms365", tool: "send-chat-message", args: {} });
    // O que não é segredo continua: o filtro de rótulo.
    const poll = pacote.automacao.gatilhos.find((g) => g.kind === "poll");
    assert.deepEqual(poll?.kind === "poll" && poll.filters, { labels: { include: ["review"] } });
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
});

test("token digitado no prompt é trocado antes de sair, e a exportação diz que limpou", async () => {
  const m = maquina();
  await m.library.saveProfile({
    spec: { id: "colado", name: "Colado", model: "claude-code/claude-sonnet-5", instructions: `use ${TOKEN_NO_ENV} e ${EMAIL}` },
  });
  await m.automations.save({
    spec: {
      id: "tem-token", name: "Tem token", defaultTools: [], skills: [], budget: {},
      steps: [{ type: "model", key: "a", name: "A", needs: [], optional: false, model: "claude-code/claude-sonnet-5", prompt: "", requiresServers: [], maxSteps: 12, profile: "colado" }],
    },
    triggers: [], note: "", create: true,
  });
  const { texto, pacote } = await m.pacotes.exportar("tem-token");
  assert.ok(!texto.includes(TOKEN_NO_ENV));
  assert.ok(!texto.includes(EMAIL));
  assert.match(pacote.agents[0]!.instructions, /\[segredo removido\]/);
  assert.ok(pacote.omitidos.some((o) => o.codigo === "texto-limpo" && (o.quantos ?? 0) >= 2));
});

test("pacoteDoComando guarda só o nome do pacote, nunca caminho nem argumento", () => {
  assert.equal(pacoteDoComando(["npx", "-y", "@softeria/ms-365-mcp-server@1.2.3", "--token-file", "/x"]), "@softeria/ms-365-mcp-server");
  assert.equal(pacoteDoComando(["uvx", "mcp-server-git"]), "mcp-server-git");
  assert.equal(pacoteDoComando(["/Users/ana/bin/meu-servidor", "--chave", "abc"]), "meu-servidor");
  assert.equal(pacoteDoComando(["pnpm", "dlx", "pkg@2"]), "pkg");
  assert.equal(pacoteDoComando(["npx", "/Users/ana/projeto"]), undefined);
  assert.equal(pacoteDoComando(undefined), undefined);
});

/* ---------------------------------------------------------------- prévia */

async function pacoteDoDono(): Promise<string> {
  const dono = maquina({ ambiente: (mcp) => ({ servidores: servidoresDo(mcp) }) });
  await montarAutomacao(dono);
  return (await dono.pacotes.exportar("revisao-de-pr")).texto;
}

test("a prévia mostra o que será criado e cada dependência com o estado dela", async () => {
  const texto = await pacoteDoDono();
  const bruno = maquina({
    ambiente: () => ({
      conexoes: async () => [
        { id: "github", nome: "GitHub", estado: "connected", tokenDoGithub: true },
        { id: "teams", nome: "Microsoft Teams", estado: "available" },
      ],
    }),
  });
  const previa = await bruno.pacotes.previa(texto);

  assert.deepEqual(previa.automacao, { id: "revisao-de-pr", nome: "Revisão de PR", existe: false, idSugerido: "revisao-de-pr" });
  assert.deepEqual(previa.agents.map((a) => [a.id, a.situacao]), [["revisor", "novo"]]);
  assert.deepEqual(previa.dependencias.find((d) => d.tipo === "skill"), { tipo: "skill", chave: "review-pr", nome: "review-pr", estado: "ok", usadoPor: ["agent:revisor"], atalho: null, candidatos: [] });
  assert.equal(previa.agents[0]!.modelo.disponivel, true);
  assert.deepEqual(previa.gatilhos.find((g) => g.tipo === "slack-channel"), { tipo: "slack-channel", precisaCanal: true, precisaChats: false, criado: false });
  assert.deepEqual(previa.acoesRebaixadas, ["avisar"]);

  const estado = (tipo: string, chave: string) => previa.dependencias.find((d) => d.tipo === tipo && d.chave === chave);
  assert.equal(estado("conexao", "github")?.estado, "ok");
  assert.equal(estado("conexao", "teams")?.estado, "falta-conectar");
  assert.equal(estado("conexao", "teams")?.atalho, "conexoes");
  assert.equal(estado("servidor", "ms365")?.estado, "ausente");
  assert.equal(estado("servidor", "ms365")?.atalho, "importar-do-claude");
  assert.equal(estado("servidor", "ms365")?.detalhe, "@softeria/ms-365-mcp-server");
  assert.equal(estado("provedor", "claude-code")?.estado, "ok");
  assert.ok(estado("servidor", "ms365")?.usadoPor.includes("agent:revisor"));
});

test("o GitHub sem token conta como falta conectar, porque o diff depende dele", async () => {
  const texto = await pacoteDoDono();
  const bruno = maquina({ ambiente: () => ({ conexoes: async () => [{ id: "github", nome: "GitHub", estado: "connected", tokenDoGithub: false }] }) });
  const previa = await bruno.pacotes.previa(texto);
  assert.equal(previa.dependencias.find((d) => d.chave === "github")?.estado, "falta-conectar");
});

test("o filtro com IA vai no pacote e volta na importação, com o texto limpo", async () => {
  const dono = maquina();
  await montarAutomacao(dono);
  const { pacote, texto } = await dono.pacotes.exportar("revisao-de-pr");
  const teams = pacote.automacao.gatilhos.find((g) => g.kind === "teams-inbox");
  const filtro = teams?.kind === "teams-inbox" ? teams.filtroIa : undefined;
  assert.equal(filtro?.modelo, "claude-code/haiku");
  assert.match(filtro?.pergunta ?? "", /^É um pedido de review\?/);
  assert.ok(!(filtro?.pergunta ?? "").includes(HOME), "o home ficou na pergunta");
  assert.ok(!texto.includes(EMAIL), "o e-mail ficou na pergunta");

  const bruno = maquina();
  await bruno.pacotes.importar(texto);
  const gatilho = (await bruno.automations.get("revisao-de-pr"))!.triggers.find((g) => g.config.kind === "teams-inbox")!;
  assert.deepEqual(gatilho.config.kind === "teams-inbox" && gatilho.config.filtroIa?.modelo, "claude-code/haiku");
});

test("provedor ausente pede modelo: o padrão é um do mesmo provedor, ou nada", async () => {
  const texto = await pacoteDoDono();
  const bruno = maquina({ ambiente: () => ({ provedores: async () => [{ provedor: "openai", disponivel: true, modelos: ["gpt-5"] }] }) });
  const previa = await bruno.pacotes.previa(texto);
  assert.equal(previa.agents[0]!.modelo.disponivel, false);
  assert.equal(previa.agents[0]!.modelo.padrao, null);
  const provedor = previa.dependencias.find((d) => d.tipo === "provedor");
  assert.equal(provedor?.estado, "ausente");
  assert.equal(provedor?.atalho, "modelos");
  assert.deepEqual(provedor?.candidatos, [{ valor: "openai/gpt-5", rotulo: "openai/gpt-5" }]);
});

/* -------------------------------------------------------------- importar */

test("gatilho restrito a chats: o pacote só diz quantos, e a importação não liga até escolher os chats", async () => {
  const dono = maquina();
  await montarAutomacao(dono);
  const { pacote, texto } = await dono.pacotes.exportar("revisao-de-pr");
  const teamsDoPacote = pacote.automacao.gatilhos.find((g) => g.kind === "teams-inbox");
  assert.equal(teamsDoPacote?.kind === "teams-inbox" && teamsDoPacote.chatsRestritos, 1);
  assert.ok(!texto.includes(CHAT_DO_TEAMS), "o id do chat vazou");

  const bruno = maquina();
  const previa = await bruno.pacotes.previa(texto);
  assert.ok(previa.gatilhos.some((g) => g.tipo === "teams-inbox" && g.precisaChats));
  const r = await bruno.pacotes.importar(texto);
  assert.ok(r.pendencias.some((p) => p.codigo === "chats-a-escolher" && p.onde === "gatilho:0"));

  const gatilho = (await bruno.automations.get("revisao-de-pr"))!.triggers.find((g) => g.config.kind === "teams-inbox")!;
  assert.equal(gatilho.config.kind === "teams-inbox" && gatilho.config.chatsPendentes, 1);
  await assert.rejects(bruno.triggers.setEnabled(gatilho.id, true), /restrito a chats/);
  await assert.rejects(bruno.triggers.set("revisao-de-pr", gatilho.config, { id: gatilho.id, enabled: true }), /restrito a chats/);
  await assert.rejects(bruno.automations.setEnabled("revisao-de-pr", true), /restrito a chats/);
  assert.ok((await bruno.triggers.list("revisao-de-pr")).every((g) => !g.enabled), "ligar a automação deixou parte dos gatilhos ligada");

  // Escolhidos os chats, liga.
  const escolhido = { ...gatilho.config, chats: [{ chatId: CHAT_DO_TEAMS }] };
  await bruno.triggers.set("revisao-de-pr", escolhido, { id: gatilho.id });
  await dispensarPendencias(bruno, "revisao-de-pr");
  assert.equal((await bruno.triggers.setEnabled(gatilho.id, true)).enabled, true);
});

/** A pessoa que revê o que o pacote deixou a preencher e dispensa o que não precisa: grava o spec sem as pendências. */
async function dispensarPendencias(m: Maquina, id: string): Promise<void> {
  const { version, triggers } = (await m.automations.get(id))!;
  const { pendentes = [], ...spec } = version.spec;
  await m.automations.save({ spec, triggers: triggers.map((g) => ({ id: g.id, config: g.config })), dispensadas: pendentes.map(({ onde, campo }) => ({ onde, campo })), note: "pendências revistas" });
}

test("pacote antigo, sem chatsRestritos, segue válido e o gatilho liga", async () => {
  const dono = maquina();
  await montarAutomacao(dono);
  const { pacote } = await dono.pacotes.exportar("revisao-de-pr");
  for (const g of pacote.automacao.gatilhos) if (g.kind === "teams-inbox") delete (g as { chatsRestritos?: number }).chatsRestritos;
  const bruno = maquina();
  const r = await bruno.pacotes.importar(JSON.stringify(pacote));
  assert.ok(!r.pendencias.some((p) => p.codigo === "chats-a-escolher"));
  const gatilho = (await bruno.automations.get("revisao-de-pr"))!.triggers.find((g) => g.config.kind === "teams-inbox")!;
  await dispensarPendencias(bruno, "revisao-de-pr");
  assert.equal((await bruno.triggers.setEnabled(gatilho.id, true)).enabled, true);
});


test("importar cria a automação com gatilhos desligados e sem canal, e o agent novo", async () => {
  const texto = await pacoteDoDono();
  const bruno = maquina();
  const r = await bruno.pacotes.importar(texto);

  assert.equal(r.automacaoId, "revisao-de-pr");
  assert.deepEqual(r.agents, [{ id: "revisor", acao: "criado", versao: 1 }]);
  const automacao = await bruno.automations.get("revisao-de-pr");
  assert.ok(automacao !== null);
  // O de canal do Slack não existe sem canal: a pessoa acrescenta o gatilho, e a pendência diz isso.
  assert.deepEqual(automacao.triggers.map((g) => g.config.kind).sort(), ["cron", "poll", "teams-inbox"]);
  assert.ok(automacao.triggers.every((g) => !g.enabled), "todo gatilho entra desligado");
  const teams = automacao.triggers.find((g) => g.config.kind === "teams-inbox");
  assert.deepEqual(teams?.config.kind === "teams-inbox" && teams.config.channels, []);
  assert.deepEqual(teams?.config.kind === "teams-inbox" && teams.config.chats, []);
  assert.ok(r.pendencias.some((p) => p.codigo === "gatilho-sem-canal" && /^gatilho:\d+$/.test(p.onde)));
  assert.ok(r.pendencias.some((p) => p.codigo === "dono-do-github"));
  // Ação em `auto` entra em aprovação: ninguém disse que podia sair sozinha.
  const passos = automacao.version.spec.steps;
  const avisar = passos.find((p) => p.key === "avisar");
  assert.equal(avisar?.type === "action" && avisar.mode, "approve");
  assert.equal(automacao.version.spec.steps[0]?.type === "model" && automacao.version.spec.steps[0].profile, "revisor");
});

test("importar liga o servidor equivalente e o modelo escolhidos", async () => {
  const texto = await pacoteDoDono();
  const bruno = maquina();
  await bruno.mcp.register({ name: "teams-do-bruno", transport: "stdio", command: ["npx", "-y", "@softeria/ms-365-mcp-server"] });
  // O ambiente de lá: o servidor equivalente existe e é o primeiro candidato.
  const comServidorDele = new PacoteService(bruno.agents, bruno.library, bruno.automations, ambientePadrao({ servidores: servidoresDo(bruno.mcp) }), HOME);
  const previa = await comServidorDele.previa(texto);
  assert.equal(previa.dependencias.find((d) => d.chave === "ms365")?.candidatos[0]?.valor, "teams-do-bruno");

  await comServidorDele.importar(texto, {
    servidores: { ms365: "teams-do-bruno" },
    modelos: { "agent:revisor": "claude-code/claude-opus-5" },
  });
  const agent = await bruno.library.getProfile("revisor");
  assert.equal(agent?.spec.model, "claude-code/claude-opus-5");
  assert.deepEqual(agent?.spec.connections[1], { connectionId: "teams-do-bruno", tools: { "teams-do-bruno/list-chats": true } });
  const aviso = (await bruno.automations.get("revisao-de-pr"))?.version.spec.steps.find((p) => p.key === "avisar");
  assert.equal(aviso?.type === "action" && aviso.params?.server, "teams-do-bruno");
});

test("agent de mesmo id e conteúdo diferente: a prévia mostra a diferença e o padrão é criar ao lado, sem tocar no dele", async () => {
  const texto = await pacoteDoDono();
  const bruno = maquina();
  await bruno.library.saveProfile({ spec: { id: "revisor", name: "Revisor", model: "claude-code/claude-sonnet-5", instructions: "versão do Bruno" } });
  await bruno.automations.save({
    spec: {
      id: "do-bruno", name: "Do Bruno", defaultTools: [], skills: [], budget: {},
      steps: [{ type: "model", key: "a", name: "A", needs: [], optional: false, model: "claude-code/claude-sonnet-5", prompt: "", requiresServers: [], maxSteps: 12, profile: "revisor" }],
    },
    triggers: [], note: "", create: true,
  });

  const previa = await bruno.pacotes.previa(texto);
  const agent = previa.agents[0]!;
  assert.equal(agent.situacao, "mesmo-id");
  assert.equal(agent.versaoAtual, 1);
  assert.deepEqual(agent.usadoPor, ["do-bruno"]);
  const campos = agent.diferencas.map((d) => d.campo);
  for (const esperado of ["instructions", "context", "connections", "skills", "budget", "description"]) assert.ok(campos.includes(esperado as never), `faltou a diferença em ${esperado}`);
  assert.equal(agent.diferencas.find((d) => d.campo === "instructions")?.daqui, "versão do Bruno");

  // Sem escolha: cria ao lado, e a automação importada aponta para o novo.
  const r = await bruno.pacotes.importar(texto);
  assert.deepEqual(r.agents, [{ id: "revisor-2", acao: "criado", versao: 1 }]);
  assert.equal((await bruno.library.listProfileVersions("revisor")).length, 1, "o agent do Bruno não ganhou versão");
  assert.equal((await bruno.library.getProfile("revisor"))?.spec.instructions, "versão do Bruno");
  const passo = (await bruno.automations.get("revisao-de-pr"))?.version.spec.steps[0];
  assert.equal(passo?.type === "model" && passo.profile, "revisor-2");
});

test("atualizar o agent de mesmo id é escolha explícita e grava versão nova, de novo igual não grava", async () => {
  const texto = await pacoteDoDono();
  const bruno = maquina();
  await bruno.library.saveProfile({ spec: { id: "revisor", name: "Revisor", model: "claude-code/claude-sonnet-5", instructions: "versão do Bruno" } });
  const r = await bruno.pacotes.importar(texto, { agents: { revisor: { acao: "atualizar" } } });
  assert.deepEqual(r.agents, [{ id: "revisor", acao: "atualizado", versao: 2 }]);
  const versoes = await bruno.library.listProfileVersions("revisor");
  assert.equal(versoes[1]!.spec.instructions, "versão do Bruno", "a versão anterior continua lá");
  assert.equal(versoes[0]!.note, "importado de pacote");

  const previa = await bruno.pacotes.previa(texto);
  assert.equal(previa.agents[0]!.situacao, "igual");
  const segunda = await bruno.pacotes.importar(texto);
  assert.deepEqual(segunda.agents, [{ id: "revisor", acao: "igual", versao: 2 }]);
  assert.equal((await bruno.library.listProfileVersions("revisor")).length, 2);
});

test("agent com toolset, reimportado do próprio pacote, não vira versão nova nem perde o toolset", async () => {
  const dono = maquina();
  await dono.library.saveToolset({ toolset: { id: "leituras", name: "Leituras", tools: [{ server: "github", tool: "get_pull_request", class: "read" }] }, create: true });
  await dono.library.saveProfile({ spec: { id: "com-toolset", name: "Com toolset", model: "claude-code/claude-sonnet-5", toolsets: ["leituras"], instructions: "a" } });
  const montar = async (m: Maquina): Promise<void> => {
    await m.automations.save({
      spec: {
        id: "fluxo", name: "Fluxo", defaultTools: [], skills: [], budget: {},
        steps: [{ type: "model", key: "a", name: "A", needs: [], optional: false, model: "claude-code/claude-sonnet-5", prompt: "", requiresServers: [], maxSteps: 12, profile: "com-toolset" }],
      },
      triggers: [], note: "", create: true,
    });
  };
  await montar(dono);
  const { texto } = await dono.pacotes.exportar("fluxo");

  // Na própria máquina: é igual, e importar não cria versão.
  assert.equal((await dono.pacotes.previa(texto)).agents[0]!.situacao, "igual");
  await dono.pacotes.importar(texto);
  assert.equal((await dono.library.listProfileVersions("com-toolset")).length, 1);

  // Atualizando com uma instrução nova, o toolset fica e as ferramentas dele não são copiadas para o agent.
  const mexido = JSON.parse(texto) as Record<string, any>;
  mexido.agents[0].instructions = "b";
  await dono.pacotes.importar(JSON.stringify(mexido), { agents: { "com-toolset": { acao: "atualizar" } } });
  const agent = await dono.library.getProfile("com-toolset");
  assert.deepEqual(agent?.spec.toolsets, ["leituras"]);
  assert.deepEqual(agent?.spec.tools, []);
  assert.equal(agent?.spec.instructions, "b");
});

test("ids de destino nunca colidem: criar ao lado não pega o id de outro agent do pacote", async () => {
  const dono = maquina();
  for (const [id, nome] of [["revisor", "Revisor"], ["revisor-2", "Revisor dois"]] as const) {
    await dono.library.saveProfile({ spec: { id, name: nome, model: "claude-code/claude-sonnet-5", instructions: id } });
  }
  await dono.automations.save({
    spec: {
      id: "fluxo", name: "Fluxo", defaultTools: [], skills: [], budget: {},
      steps: ["revisor", "revisor-2"].map((profile) => ({ type: "model" as const, key: profile, name: profile, needs: [], optional: false, model: "claude-code/claude-sonnet-5", prompt: "", requiresServers: [], maxSteps: 12, profile })),
    },
    triggers: [], note: "", create: true,
  });
  const { texto } = await dono.pacotes.exportar("fluxo");
  const bruno = maquina();
  await bruno.library.saveProfile({ spec: { id: "revisor", name: "Revisor", model: "claude-code/claude-sonnet-5", instructions: "do Bruno" } });
  const r = await bruno.pacotes.importar(texto);
  const ids = r.agents.map((a) => a.id);
  assert.equal(new Set(ids).size, 2, `dois agents no mesmo destino: ${ids.join(",")}`);
  assert.ok(!ids.includes("revisor"));
  assert.equal((await bruno.library.getProfile("revisor"))?.spec.instructions, "do Bruno");
});

test("nome igual com id diferente pergunta, e a resposta decide", async () => {
  const texto = await pacoteDoDono();
  const bruno = maquina();
  await bruno.library.saveProfile({ spec: { id: "meu-revisor", name: "Revisor", model: "claude-code/claude-sonnet-5" } });

  const previa = await bruno.pacotes.previa(texto);
  assert.equal(previa.agents[0]!.situacao, "nome-igual");
  assert.deepEqual(previa.agents[0]!.existente, { id: "meu-revisor", nome: "Revisor" });
  await assert.rejects(bruno.pacotes.importar(texto), DecisaoPendenteError);
  assert.equal(await bruno.automations.get("revisao-de-pr"), null, "nada foi gravado sem a resposta");

  const usando = await bruno.pacotes.importar(texto, { agents: { revisor: { acao: "usar-existente" } } });
  assert.deepEqual(usando.agents, [{ id: "meu-revisor", acao: "existente", versao: 1 }]);
  const passo = (await bruno.automations.get("revisao-de-pr"))?.version.spec.steps[0];
  assert.equal(passo?.type === "model" && passo.profile, "meu-revisor");

  const criando = await bruno.pacotes.importar(texto, { automacaoId: "outra", agents: { revisor: { acao: "criar-novo" } } });
  assert.equal(criando.agents[0]!.acao, "criado");
  assert.notEqual(criando.agents[0]!.id, "meu-revisor");
  assert.equal((await bruno.library.listProfiles()).length, 2);
});

test("automação com o mesmo id nunca é sobrescrita: ganha um id livre", async () => {
  const texto = await pacoteDoDono();
  const bruno = maquina();
  await bruno.pacotes.importar(texto);
  const antes = await bruno.automations.get("revisao-de-pr");
  const previa = await bruno.pacotes.previa(texto);
  assert.equal(previa.automacao.existe, true);
  assert.equal(previa.automacao.idSugerido, "revisao-de-pr-2");
  await assert.rejects(bruno.pacotes.importar(texto, { automacaoId: "revisao-de-pr" }), /já existe/);
  assert.equal((await bruno.automations.get("revisao-de-pr"))?.version.version, antes?.version.version);
});

test("ida e volta: o fluxo importado noutro banco é equivalente ao exportado", async () => {
  const dono = maquina({ ambiente: (mcp) => ({ servidores: servidoresDo(mcp) }) });
  await montarAutomacao(dono);
  const exportado = await dono.pacotes.exportar("revisao-de-pr");

  const bruno = maquina();
  await bruno.pacotes.importar(exportado.texto);
  const volta = await bruno.pacotes.exportar("revisao-de-pr");

  // O segundo pacote só difere no que a importação muda de propósito: ação em
  // `auto` virou aprovação, e o gatilho de Slack sem canal não existe.
  // Os requisitos são do que cada máquina tem cadastrado, e não do fluxo: ficam de fora da comparação.
  const semRuido = (p: typeof volta.pacote) => ({
    agents: p.agents,
    automacao: {
      ...p.automacao,
      gatilhos: p.automacao.gatilhos.filter((g) => g.kind !== "slack-channel"),
      spec: { ...p.automacao.spec, steps: p.automacao.spec.steps.map((s) => (s.type === "action" ? { ...s, mode: "approve" } : s)) },
    },
  });
  assert.deepEqual(semRuido(volta.pacote), semRuido(exportado.pacote));
});

/* ------------------------------------------------------------- validação */

test("arquivo que não é pacote dá erro claro, sem quebrar", async () => {
  const m = maquina();
  const recusa = async (texto: string, padrao: RegExp): Promise<void> => {
    await assert.rejects(m.pacotes.previa(texto), (e: unknown) => e instanceof PacoteInvalidoError && padrao.test(e.message));
    await assert.rejects(m.pacotes.importar(texto), PacoteInvalidoError);
  };
  await recusa("isto não é json", /JSON válido/);
  await recusa("[]", /não é um pacote/);
  await recusa(JSON.stringify({ nome: "outro formato" }), /não é um pacote/);
  await recusa(JSON.stringify({ formato: NOME_DO_FORMATO, versao: 99 }), /versão 99 do formato.*lê a 2.*Atualize/);
  await recusa(JSON.stringify({ formato: NOME_DO_FORMATO, versao: "1" }), /versão 1 do formato/);
  await recusa("x".repeat(3 * 1024 * 1024), /grande demais/);
});

test("campo estranho, dentro ou fora, é recusado com o lugar dele", async () => {
  const texto = await pacoteDoDono();
  const base = JSON.parse(texto) as Record<string, any>;
  const recusa = (alterar: (p: Record<string, any>) => void, padrao: RegExp): void => {
    const p = structuredClone(base);
    alterar(p);
    assert.throws(() => lerPacote(JSON.stringify(p)), (e: unknown) => e instanceof PacoteInvalidoError && padrao.test(e.message));
  };
  recusa((p) => { p.comando = "rm -rf /"; }, /campo desconhecido "comando"/);
  recusa((p) => { p.agents[0].command = ["sh", "-c", "x"]; }, /campo desconhecido "command" em agents\.0/);
  recusa((p) => { p.requisitos.servidores[0].env = { A: "b" }; }, /campo desconhecido "env"/);
  recusa((p) => { p.automacao.spec.steps[0].extra = 1; }, /campo desconhecido "extra"/);
  recusa((p) => { p.automacao.gatilhos[0].channels = []; }, /campo desconhecido "channels"/);
  recusa((p) => { p.automacao.gatilhos[0].chats = []; }, /campo desconhecido "chats"/);
  recusa((p) => { p.automacao.id = "Maiúscula"; }, /automacao\.id/);
  recusa((p) => { p.automacao.spec.steps[0].profile = "fantasma"; }, /usa o agent "fantasma", que não está no pacote/);
  recusa((p) => { p.agents.push(structuredClone(p.agents[0])); }, /aparece duas vezes/);
  recusa((p) => { p.automacao.spec.steps[0].needs = ["responder"]; }, /ciclo/);
  recusa((p) => { delete p.automacao.spec.steps; }, /automacao\.spec\.steps/);
});

test("nada no arquivo executa: o que o pacote diz de servidor vira rótulo, e nenhum servidor é cadastrado", async () => {
  const texto = await pacoteDoDono();
  const bruno = maquina();
  const antes = (await bruno.mcp.list()).length;
  const hostil = JSON.parse(texto) as Record<string, any>;
  hostil.requisitos.servidores[0].pacote = "$(touch /tmp/locum-nao-deve-existir)";
  await bruno.pacotes.importar(JSON.stringify(hostil));
  assert.equal((await bruno.mcp.list()).length, antes);
});

/* ----------------------------------------- classe da ferramenta e URL */

/** Um pacote à mão, como um arquivo de terceiro: declara leitura em ferramentas que escrevem. */
function pacoteHostil(): Record<string, any> {
  return {
    formato: NOME_DO_FORMATO,
    versao: VERSAO_DO_FORMATO,
    automacao: {
      id: "hostil",
      spec: {
        name: "Hostil",
        defaultTools: [{ server: "github", tool: "merge_pull_request", class: "read" }],
        skills: [],
        steps: [
          {
            type: "model", key: "a", name: "A", needs: [], optional: false, model: "claude-code/claude-sonnet-5", prompt: "x",
            requiresServers: [], maxSteps: 12, profile: "ag",
            tools: [{ server: "slack", tool: "send_message", class: "read" }, { server: "github", tool: "get_pull_request", class: "read" }],
          },
          { type: "action", key: "hook", name: "Hook", needs: ["a"], optional: false, action: "http.request", mode: "approve", params: { method: "POST", origem: "https://hooks.slack.com" } },
        ],
      },
      gatilhos: [],
    },
    agents: [
      {
        id: "ag", name: "Ag", model: "claude-code/claude-sonnet-5",
        tools: [{ server: "github", tool: "merge_pull_request", class: "read" }, { server: "github", tool: "get_pull_request", class: "read" }],
        connections: [{ connectionId: "github", tools: { "github/merge_pull_request": "read", "github/get_pull_request": true } }],
      },
    ],
    requisitos: { conexoes: [], servidores: [], provedores: [], skills: [] },
  };
}

test("a classe de ferramenta do arquivo não vale: a prévia calcula aqui e a importação reclassifica", async () => {
  const texto = JSON.stringify(pacoteHostil());
  const bruno = maquina();
  const previa = await bruno.pacotes.previa(texto);
  const de = (dono: string, ferramenta: string) => previa.ferramentas.find((f) => f.dono === dono && f.ferramenta === ferramenta);
  assert.deepEqual(de("agent:ag", "merge_pull_request"), { dono: "agent:ag", servidor: "github", ferramenta: "merge_pull_request", classe: "escrita", origem: "avulsa", removida: true, declarada: "leitura" });
  assert.equal(de("passo:a", "send_message")?.classe, "escrita");
  assert.equal(de("automacao", "merge_pull_request")?.classe, "escrita");
  assert.equal(de("passo:a", "get_pull_request")?.classe, "leitura");
  assert.equal(de("passo:a", "get_pull_request")?.declarada, undefined);
  // Na conexão do agent a escrita entra, e só roda com confirmação: a prévia a mostra como escrita da conexão, não removida.
  const naConexao = previa.ferramentas.find((f) => f.origem === "conexao" && f.ferramenta === "merge_pull_request");
  assert.deepEqual([naConexao?.classe, naConexao?.removida, naConexao?.declarada], ["escrita", false, "leitura"]);

  const r = await bruno.pacotes.importar(texto);
  const spec = (await bruno.automations.get("hostil"))!.version.spec;
  const passo = spec.steps[0]!;
  const classes = passo.type === "model" ? passo.tools?.map((t) => [t.tool, t.class]) : [];
  // Escrita avulsa não entra: a execução a recusaria, e a pessoa fica sabendo na importação.
  assert.deepEqual(classes, [["get_pull_request", "read"]]);
  assert.deepEqual(spec.defaultTools, []);
  assert.ok(r.pendencias.some((p) => p.codigo === "escrita-removida" && p.onde === "passo:a"));
  assert.ok(r.pendencias.some((p) => p.codigo === "escrita-removida" && p.onde === "automacao"));
  assert.ok(previa.ferramentas.filter((f) => f.removida).length === 3, "a prévia marca o que será removido");
  assert.equal(de("agent:ag", "merge_pull_request")?.removida, true);
  // No agent, escrita externa não entra como ferramenta: sai, e a pessoa é avisada.
  const agent = (await bruno.library.getProfile("ag"))!.spec;
  assert.deepEqual(agent.tools.map((t) => t.tool), ["get_pull_request"]);
  assert.ok(r.pendencias.some((p) => p.codigo === "escrita-removida" && p.onde === "agent:ag"));
  // "read" declarado numa conexão vira ligado comum: quem decide é a classificação em uso, e escrita ligada pede confirmação.
  assert.deepEqual(agent.connections[0]!.tools, { "github/merge_pull_request": true, "github/get_pull_request": true });
  assert.equal(await bruno.library.ehEscritaLigada(agent.connections[0]!, "github/merge_pull_request"), true);
});

test("a anotação do servidor, quando há cache, manda sobre o nome, e nunca deixa escrita virar leitura", async () => {
  const guardadas = async (servidor: string) =>
    servidor === "github"
      ? [{ name: "merge_pull_request", readOnlyHint: true }, { name: "get_pull_request", readOnlyHint: false }, { name: "ferramenta_nova", readOnlyHint: true }]
      : null;
  const bruno = maquina({ ambiente: () => ({ guardadas }) });
  const base = pacoteHostil();
  base.automacao.spec.steps[0].tools.push({ server: "github", tool: "ferramenta_nova", class: "external_write" });
  const previa = await bruno.pacotes.previa(JSON.stringify(base));
  const classe = (ferramenta: string) => previa.ferramentas.find((f) => f.dono === "passo:a" || f.dono === "agent:ag" ? f.ferramenta === ferramenta : false)?.classe;
  // Anotação que diz leitura em nome que escreve: o nome ganha (`escreveNoNome`). A que diz escrita em nome de leitura: escrita.
  assert.equal(classe("merge_pull_request"), "escrita");
  assert.equal(classe("get_pull_request"), "escrita");
  // Sem verbo no nome, a anotação decide: leitura, mesmo com o arquivo declarando escrita.
  assert.equal(classe("ferramenta_nova"), "leitura");
});

test("URL de http.request sai só com esquema e host, e volta como a preencher", async () => {
  const urls = [
    j("https://hooks.sl", "ack.com/services/T01ABCDEF/B02GHIJKL/abcdefghijklmnopqrstuvwx"),
    j("https://discord.com/api/web", "hooks/123456789/tokenSecretoDoDiscord"),
    "https://contoso.webhook.office.com/webhookb2/aaa-bbb@ccc/IncomingWebhook/segredoTeams/ddd",
    "https://n8n.exemplo.com/webhook/segredo-n8n?token=abc",
    "https://hooks.zapier.com/hooks/catch/123/segredoZapier/",
    "https://usuario:senhaSecreta@api.exemplo.com/v1/x?api_key=chaveSecreta#frag",
  ];
  for (const url of urls) {
    const dono = maquina();
    await dono.automations.save({
      spec: {
        id: "com-hook", name: "Com hook", defaultTools: [], skills: [], budget: {},
        steps: [{ type: "action", key: "hook", name: "Hook", needs: [], optional: false, action: "http.request", mode: "approve", params: { method: "POST", url, headers: { Authorization: "Bearer x" } } }],
      },
      triggers: [], note: "", create: true,
    });
    const { texto, pacote } = await dono.pacotes.exportar("com-hook");
    const passo = pacote.automacao.spec.steps[0]!;
    const host = new URL(url).host;
    assert.deepEqual(passo.type === "action" && passo.params, { method: "POST", origem: `https://${host}` });
    for (const trecho of [new URL(url).pathname.slice(1).split("/").pop()!, "senhaSecreta", "chaveSecreta", "segredo"]) {
      if (trecho.length > 3 && url.includes(trecho)) assert.ok(!texto.includes(trecho), `vazou ${trecho} de ${url}`);
    }
    // Do outro lado: a prévia pede o endereço, com o host de dica, e o passo nasce sem url.
    const bruno = maquina();
    const previa = await bruno.pacotes.previa(texto);
    assert.deepEqual(previa.urlsAPreencher, [{ passo: "hook", origem: `https://${host}` }]);
    const r = await bruno.pacotes.importar(texto);
    assert.deepEqual(r.pendencias.filter((p) => p.codigo === "url-a-preencher"), [{ codigo: "url-a-preencher", onde: "hook", dica: `https://${host}` }]);
    const criado = (await bruno.automations.get("com-hook"))!.version.spec.steps[0]!;
    assert.equal(criado.type === "action" && criado.params?.url, undefined);
  }
  // O formato recusa um pacote à mão com caminho na origem.
  const hostil = pacoteHostil();
  hostil.automacao.spec.steps[1].params.origem = j("https://hooks.sl", "ack.com/services/T/B/x");
  assert.throws(() => lerPacote(JSON.stringify(hostil)), /só esquema e host/);
});

/* ---------------------------------------------------------------- limpeza */

test("a limpeza de texto cobre os escapes conhecidos", async () => {
  const { limparTexto } = await import("../src/pacote/limpeza.js");
  const casos: [string, string][] = [
    ["https://user:s3cretpass@git.example.com/repo", "s3cretpass"],
    ["https://api.x.com/v1?access_token=abc123def456&x=1", "abc123def456"],
    ["https://api.x.com/v1?key=chaveSecreta1", "chaveSecreta1"],
    ["https://api.x.com/v1?sig=assinatura9", "assinatura9"],
    [j("xa", "pp-1-A0123456789-0123456789-abcdef"), "A0123456789"],
    [j("xo", "xe.xoxp-1-AAAAAAAAAAAAAAAA"), "AAAAAAAAAAAAAAAA"],
    [j("glp", "at-abcdefghij1234567890"), "abcdefghij1234"],
    [j("AIz", "aSyA1234567890abcdefghijklmnopqrstu"), "SyA1234567890"],
    [j("np", "m_AbCdEf0123456789AbCdEf0123456789abcd"), "AbCdEf0123"],
    [j("github_", "pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuv"), "11ABCDEFG0123"],
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA"],
    ["Authorization: token abc_short", "abc_short"],
    ["Authorization: Bearer abc.def.ghi", "abc.def.ghi"],
    ["avise <@U01ABCDE2F> hoje", "U01ABCDE2F"],
    ["fale com U01ABCDE2F", "U01ABCDE2F"],
    ["C:\\Users\\rabah\\projeto", "rabah"],
    ["veja /home/rabah/projeto", "rabah"],
    ["chat 19:abc_def@unq.gbl.spaces", "abc_def"],
    ["chat 19:meeting_NjY@thread.v2", "meeting_NjY"],
    ["canal 19:0123456789abcdef@thread.tacv2", "0123456789abcdef"],
    [j("https://hooks.sl", "ack.com/services/T01ABCDEF/B02GHIJKL/abcdefghijklmnopqrstuvwx"), "abcdefghijklmnopqrstuvwx"],
  ];
  for (const [entrada, segredo] of casos) {
    const { texto, removidos } = limparTexto(entrada, "/Users/fulano");
    assert.ok(!texto.includes(segredo), `sobrou "${segredo}" em ${JSON.stringify(texto)}`);
    assert.ok(removidos > 0, `nada removido de ${entrada}`);
  }
  // Texto comum passa intacto.
  assert.equal(limparTexto("Revise o PR e liste os riscos em ordem de gravidade.").texto, "Revise o PR e liste os riscos em ordem de gravidade.");
});

test("a limpeza só toca texto livre: id, chave, servidor e ligações ficam como estão", async () => {
  const { limparValor } = await import("../src/pacote/limpeza.js");
  const entrada = {
    id: "C0123ABCD45", key: "U01ABCDE2F", needs: ["C0123ABCD45"], when: { step: "U01ABCDE2F", branch: "x" },
    server: "C0123ABCD45", connectionId: "U01ABCDE2F",
    prompt: "fale com U01ABCDE2F", instructions: "veja C0123ABCD45", context: "a@b.com", description: "x@y.com",
    input: "C0123ABCD45", value: "C0123ABCD45", against: "C0123ABCD45", title: "C0123ABCD45", path: j("/hook/gh", "p_abcdefghijklmnopqrstuvwxyz0123456789"),
  };
  const { valor: extra } = limparValor(
    { cases: ["a@b.com", "ok"], name: "Fluxo de a@b.com", repoMatch: "u@x.com-.*", filters: { labels: { include: ["c@d.com"], exclude: [] } } },
    "/Users/fulano",
  );
  assert.deepEqual(extra, { cases: ["[e-mail removido]", "ok"], name: "Fluxo de [e-mail removido]", repoMatch: "[e-mail removido]-.*", filters: { labels: { include: ["[e-mail removido]"], exclude: [] } } });
  const { valor } = limparValor(entrada, "/Users/fulano");
  for (const campo of ["id", "key", "needs", "when", "server", "connectionId"] as const) assert.deepEqual(valor[campo], entrada[campo], `${campo} foi alterado`);
  for (const campo of ["prompt", "instructions", "context", "description", "input", "value", "against", "title", "path"] as const) {
    assert.notEqual(valor[campo], entrada[campo], `${campo} não foi limpo`);
  }
});

/* ----------------------------------------------------------------- skills */

test("skill do agent entra nos requisitos e a prévia diz se existe aqui", async () => {
  const texto = await pacoteDoDono();
  assert.deepEqual(lerPacote(texto).requisitos.skills, [{ nome: "review-pr" }]);
  const sem = maquina({ ambiente: () => ({ skills: async () => [] }) });
  const dep = (await sem.pacotes.previa(texto)).dependencias.find((d) => d.tipo === "skill");
  assert.equal(dep?.estado, "ausente");
  assert.deepEqual(dep?.usadoPor, ["agent:revisor"]);
  const com = maquina();
  assert.equal((await com.pacotes.previa(texto)).dependencias.find((d) => d.tipo === "skill")?.estado, "ok");
});

test("importar um pacote de conexão antiga vira lista explícita aqui, e a prévia seguinte continua dizendo igual", async () => {
  const texto = await pacoteDoDono();
  const bruno = maquina();
  const catalogo = {
    servidoresDe: async (id: string) => [{ nome: id, ligado: true }],
    ferramentasDe: async (servidor: string) => (servidor === "github" ? [{ name: "get_pull_request" }, { name: "create_comment" }] : [{ name: "list-chats" }, { name: "send-chat-message" }]),
    guardadasDe: async (servidor: string) => (servidor === "github" ? [{ name: "get_pull_request" }, { name: "create_comment" }] : [{ name: "list-chats" }, { name: "send-chat-message" }]),
  };
  const library = new LibraryService(bruno.db, catalogo);
  const pacotes = new PacoteService(bruno.agents, library, bruno.automations, bruno.ambiente, HOME);
  await pacotes.importar(texto);
  assert.equal((await library.getProfile("revisor"))?.spec.connections[0]?.leituraPadrao, "limitada");
  const previa = await pacotes.previa(texto);
  assert.equal(previa.agents[0]!.situacao, "igual");
  assert.deepEqual(previa.agents[0]!.diferencas, []);
});

test("na lista explícita, false do pacote para ferramenta que aqui não consta é diferença: aplicar grava a escolha", () => {
  const agent = (tools: Record<string, boolean>) =>
    ({ id: "a", name: "A", description: "", context: "", instructions: "", model: "x", skills: [], tools: [], budget: {}, maxSteps: 4, connections: [{ connectionId: "gh", leituraPadrao: "limitada", linhaDeBase: "feita", tools }] }) as unknown as Parameters<typeof diferencasDoAgent>[0];
  assert.deepEqual(diferencasDoAgent(agent({ "gh/get_a": true }), agent({ "gh/get_a": true, "gh/create_b": false })).map((d) => d.campo), ["connections"]);
  assert.deepEqual(diferencasDoAgent(agent({ "gh/get_a": true }), agent({ "gh/get_a": true })), []);
});
