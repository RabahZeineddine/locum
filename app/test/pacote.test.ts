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
import { DecisaoPendenteError, PacoteService, pacoteDoComando, type AmbienteDoPacote } from "../src/services/pacote-service.js";
import { SecretService } from "../src/services/secret-service.js";
import { TriggerService } from "../src/services/trigger-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/**
 * Exportar e importar em pacote. A interface pública é `PacoteService`: cada
 * máquina de teste é um banco próprio, e o ambiente (conexões, servidores e
 * provedores de lá) é dado por quem monta o teste.
 */

const SEGREDO_DO_COFRE = "cofre-valor-que-nunca-sai-1f9c";
const TOKEN_NO_ENV = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
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
          channels: [{ teamId: EQUIPE_DO_TEAMS, channelId: CANAL_DO_TEAMS, label: "Pagamentos" }],
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
    for (const chave of ["credentialRef", "cursor", "headers", "env", "lastError", "channelId", "teamId"]) {
      assert.ok(!texto.includes(`"${chave}"`), `o pacote tem o campo ${chave}`);
    }

    // O que ficou de fora é dito, para a prévia pedir à pessoa.
    const codigos = new Set(pacote.omitidos.map((o) => o.codigo));
    for (const esperado of ["canais", "dono-do-github", "filtros-de-pessoa", "tracker", "argumentos", "texto-limpo"] as const) {
      assert.ok(codigos.has(esperado), `faltou avisar ${esperado}`);
    }
    // O que serve de sugestão continua: servidor e ferramenta do passo, sem argumento.
    const aviso = pacote.automacao.spec.steps.find((p) => p.key === "avisar");
    assert.deepEqual(aviso?.type === "action" && aviso.params, { server: "ms365", tool: "send-chat-message" });
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
  assert.equal(previa.agents[0]!.modelo.disponivel, true);
  assert.deepEqual(previa.gatilhos.find((g) => g.tipo === "slack-channel"), { tipo: "slack-channel", precisaCanal: true });
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
  assert.ok(r.pendencias.some((p) => p.codigo === "gatilho-sem-canal" && p.onde === "slack-channel"));
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

test("agent com o mesmo id vira versão nova, e igual não cria versão", async () => {
  const texto = await pacoteDoDono();
  const bruno = maquina();
  await bruno.library.saveProfile({ spec: { id: "revisor", name: "Revisor", model: "claude-code/claude-sonnet-5", instructions: "versão do Bruno" } });
  await bruno.library.saveProfile({ spec: { id: "outro", name: "Outro", model: "claude-code/claude-sonnet-5" } });

  const previa = await bruno.pacotes.previa(texto);
  assert.equal(previa.agents[0]!.situacao, "versao-nova");
  assert.equal(previa.agents[0]!.versaoAtual, 1);

  const r = await bruno.pacotes.importar(texto);
  assert.deepEqual(r.agents, [{ id: "revisor", acao: "versao-nova", versao: 2 }]);
  const versoes = await bruno.library.listProfileVersions("revisor");
  assert.equal(versoes.length, 2);
  assert.equal(versoes[1]!.spec.instructions, "versão do Bruno", "a versão anterior continua lá");
  assert.equal(versoes[0]!.note, "importado de pacote");

  // De novo, noutra automação: o agent já é o do pacote.
  const segunda = await bruno.pacotes.importar(texto);
  assert.equal(segunda.automacaoId, "revisao-de-pr-2");
  assert.deepEqual(segunda.agents, [{ id: "revisor", acao: "igual", versao: 2 }]);
  assert.equal((await bruno.library.listProfileVersions("revisor")).length, 2);
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
  await recusa(JSON.stringify({ formato: NOME_DO_FORMATO, versao: 2 }), /versão 2 do formato.*lê a 1.*Atualize/);
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
