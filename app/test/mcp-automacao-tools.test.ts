import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { buildMcpServer } from "../src/mcp-server/server.js";
import type { LeituraDeFora } from "../src/mcp-server/connection-tools.js";
import { agentService } from "../src/services/agent-service.js";
import { ClaudeSessionsService } from "../src/services/claude-sessions-service.js";
import { escreverSessoesDeExemplo } from "../src/services/claude-sessions-sample.js";
import { libraryService } from "../src/services/library-service.js";
import { triggerService } from "../src/services/trigger-service.js";
import { registrarDescartes } from "../src/triggers/descartes.js";
import { registrarErro } from "../src/triggers/erros.js";
import { SettingsService } from "../src/services/settings-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/** Automação, gatilho, conexão, fila, sessão e pacote pelo servidor MCP do Locum. */

before(() => migrateDb());

/** Junta pedaços: um token de mentira inteiro no código acende a proteção de push do GitHub. */
const j = (...partes: string[]): string => partes.join("");
const TOKEN = j("gh", "p_abcdefghijklmnopqrstuvwxyz0123456789");

async function ligarCliente(fora: Partial<LeituraDeFora> = {}): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(fora).connect(serverTransport);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

type Resposta = Awaited<ReturnType<Client["callTool"]>>;
const texto = (res: Resposta): string => (res.content as { type: string; text: string }[])[0]?.text ?? "";

function ok<T = unknown>(res: Resposta): T {
  assert.equal(res.isError, undefined, `ferramenta devolveu erro: ${texto(res)}`);
  return JSON.parse(texto(res)) as T;
}

function recusa(res: Resposta, trecho: RegExp): void {
  assert.equal(res.isError, true, `esperava recusa, veio: ${texto(res)}`);
  assert.match(texto(res), trecho);
}

const id = (base: string): string => `${base}-${randomUUID().slice(0, 8)}`;

const spec = (agentId: string, acao: { mode?: string } = {}) => ({
  id: agentId,
  name: "Revisao",
  steps: [
    { type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt: "revise" },
    { type: "action", key: "publicar", name: "Publicar", action: "slack.post", needs: ["ler"], ...acao },
  ],
});

interface Salva {
  agentId: string;
  version: number;
  downgrades: { step: string }[];
  triggers: { id: string; enabled: boolean; kind: string }[];
}

async function salvar(client: Client, agentId: string, triggers: unknown[] = [{ config: { kind: "schedule", everyMinutes: 30 } }]) {
  return ok<Salva>(
    await client.callTool({
      name: "save_automation",
      arguments: { spec: spec(agentId), triggers, note: "primeira", create: true },
    }),
  );
}

const TEAMS_PR = { kind: "teams-inbox", mentions: false, dms: false, prLinks: true };

test("a lista de ferramentas traz as antigas e as novas", async () => {
  const client = await ligarCliente();
  const nomes = new Set((await client.listTools()).tools.map((t) => t.name));
  const antigas = ["locum_health", "list_agents", "get_agent", "list_runs", "get_run", "list_findings", "get_metrics", "list_mcp_servers", "list_providers", "get_machine_profile", "upsert_agent", "register_mcp_server", "test_mcp_server", "list_server_tools", "set_model_fallback", "set_budget", "set_trigger", "run_agent", "rerun_step", "describe_steps", "list_library_agents", "get_library_agent", "upsert_library_agent", "list_toolsets", "upsert_toolset"];
  const novas = ["list_automations", "get_automation", "list_triggers", "list_trigger_discards", "list_connections", "list_teams_chats", "list_teams_channels", "list_pending_approvals", "get_approval", "list_sessions", "preview_package", "save_automation", "set_automation_enabled", "set_trigger_enabled", "remove_trigger", "remove_library_agent", "remove_toolset", "export_package", "import_package", "run_automation_now"];
  for (const nome of [...antigas, ...novas]) assert.ok(nomes.has(nome), `falta ${nome}`);
  // Aprovar, conectar e segredo continuam fora.
  for (const fora of ["decide_approval", "approve", "connect_teams", "save_secret", "use_gh"]) assert.equal(nomes.has(fora), false);
});

test("save_automation grava desligada, rebaixa a ação e aparece nas leituras", async () => {
  const client = await ligarCliente();
  const agentId = id("auto");
  const salva = await salvar(client, agentId, [{ config: { kind: "schedule", everyMinutes: 30 } }, { config: { kind: "manual" } }]);
  assert.equal(salva.version, 1);
  assert.equal(salva.triggers.length, 2);
  assert.ok(salva.triggers.every((t) => t.enabled === false));

  const rebaixada = ok<Salva>(
    await client.callTool({
      name: "save_automation",
      arguments: {
        spec: spec(agentId, { mode: "auto" }),
        triggers: salva.triggers.map((t) => ({ id: t.id, config: { kind: t.kind === "manual" ? "manual" : "schedule", ...(t.kind === "schedule" ? { everyMinutes: 30 } : {}) } })),
        note: "ação em auto",
      },
    }),
  );
  assert.deepEqual(rebaixada.downgrades.map((d) => d.step), ["publicar"]);

  const lida = ok<{ spec: { steps: { key: string; mode?: string }[] }; enabled: boolean; triggers: { id: string }[] }>(
    await client.callTool({ name: "get_automation", arguments: { agentId } }),
  );
  assert.equal(lida.spec.steps.find((s) => s.key === "publicar")?.mode, "approve");
  assert.equal(lida.enabled, false);
  assert.equal(lida.triggers.length, 2);

  const lista = ok<{ id: string; triggers: unknown[]; enabled: boolean }[]>(await client.callTool({ name: "list_automations", arguments: {} }));
  const linha = lista.find((a) => a.id === agentId);
  assert.equal(linha?.triggers.length, 2);
  assert.equal(linha?.enabled, false);

  recusa(await client.callTool({ name: "get_automation", arguments: { agentId: "nao-existe-aqui" } }), /nao cadastrada/);
});

test("save_automation recusa ligar o gatilho, id repetido e gatilho inválido sem gravar nada", async () => {
  const client = await ligarCliente();
  const agentId = id("auto");
  const ligado = await client.callTool({
    name: "save_automation",
    arguments: { spec: spec(agentId), triggers: [{ config: { kind: "manual" }, enabled: true }], note: "x", create: true },
  });
  assert.equal(ligado.isError, true);
  assert.equal(await agentService.get(agentId), undefined);

  recusa(
    await client.callTool({ name: "save_automation", arguments: { spec: spec(agentId), triggers: [{ config: { kind: "inexistente" } }], note: "x", create: true } }),
    /./,
  );
  assert.equal(await agentService.get(agentId), undefined);

  await salvar(client, agentId);
  recusa(
    await client.callTool({ name: "save_automation", arguments: { spec: spec(agentId), triggers: [], note: "x", create: true } }),
    /já existe/,
  );
});

test("save_automation tira o gatilho que ficou fora da lista", async () => {
  const client = await ligarCliente();
  const agentId = id("auto");
  const salva = await salvar(client, agentId, [{ config: { kind: "schedule", everyMinutes: 30 } }, { config: { kind: "manual" } }]);
  const manual = salva.triggers.find((t) => t.kind === "manual")!;
  const depois = ok<Salva>(
    await client.callTool({
      name: "save_automation",
      arguments: { spec: spec(agentId), triggers: [{ id: manual.id, config: { kind: "manual" } }], note: "só manual" },
    }),
  );
  assert.deepEqual(depois.triggers.map((t) => t.id), [manual.id]);
});

test("ligar gatilho pela ferramenta, e a confirmação de reação em nome da pessoa", async () => {
  const client = await ligarCliente();
  const agentId = id("auto");
  const salva = await salvar(client, agentId, [{ config: { kind: "schedule", everyMinutes: 30 } }, { config: TEAMS_PR }]);
  const relogio = salva.triggers.find((t) => t.kind === "schedule")!;
  const teams = salva.triggers.find((t) => t.kind === "teams-inbox")!;

  const ligado = ok<{ enabled: boolean }>(await client.callTool({ name: "set_trigger_enabled", arguments: { triggerId: relogio.id, enabled: true } }));
  assert.equal(ligado.enabled, true);

  recusa(await client.callTool({ name: "set_trigger_enabled", arguments: { triggerId: teams.id, enabled: true } }), /confirmo_reacoes_em_meu_nome/);
  recusa(
    await client.callTool({ name: "set_trigger_enabled", arguments: { triggerId: teams.id, enabled: true, confirmo_reacoes_em_meu_nome: false } }),
    /confirmo_reacoes_em_meu_nome/,
  );
  assert.equal((await triggerService.get(teams.id))?.enabled, false);

  const confirmado = ok<{ enabled: boolean }>(
    await client.callTool({ name: "set_trigger_enabled", arguments: { triggerId: teams.id, enabled: true, confirmo_reacoes_em_meu_nome: true } }),
  );
  assert.equal(confirmado.enabled, true);

  // Desligar nunca pede confirmação.
  const desligado = ok<{ enabled: boolean }>(await client.callTool({ name: "set_trigger_enabled", arguments: { triggerId: teams.id, enabled: false } }));
  assert.equal(desligado.enabled, false);

  const descricao = (await client.listTools()).tools.find((t) => t.name === "set_trigger_enabled")?.description ?? "";
  assert.match(descricao, /in the name of the person/);
});

test("o gatilho que o pacote deixou esperando chats não liga, nem com a confirmação", async () => {
  const client = await ligarCliente();
  const agentId = id("auto");
  const salva = await salvar(client, agentId, [{ config: { ...TEAMS_PR, chatsPendentes: 2 } }]);
  const gatilho = salva.triggers[0]!;
  recusa(
    await client.callTool({ name: "set_trigger_enabled", arguments: { triggerId: gatilho.id, enabled: true, confirmo_reacoes_em_meu_nome: true } }),
    /escolha os chats/,
  );
  recusa(
    await client.callTool({ name: "set_automation_enabled", arguments: { agentId, enabled: true, confirmo_reacoes_em_meu_nome: true } }),
    /escolha os chats/,
  );
  const lido = ok<{ blockedUntil?: string }[]>(await client.callTool({ name: "list_triggers", arguments: { agentId } }));
  assert.ok(lido[0]?.blockedUntil);

  // set_trigger não serve de atalho: zerar a pendência sem escolher chats é recusado.
  recusa(
    await client.callTool({ name: "set_trigger", arguments: { agentId, triggerId: gatilho.id, config: { ...TEAMS_PR, chatsPendentes: 0 } } }),
    /escolha os chats/,
  );
  // Escolhendo os chats a pendência sai e o gatilho liga, com a confirmação.
  ok(
    await client.callTool({
      name: "set_trigger",
      arguments: { agentId, triggerId: gatilho.id, config: { ...TEAMS_PR, chatsPendentes: 0, chats: [{ chatId: "19:chat@thread.v2", label: "Time" }] } },
    }),
  );
  ok(await client.callTool({ name: "set_trigger_enabled", arguments: { triggerId: gatilho.id, enabled: true, confirmo_reacoes_em_meu_nome: true } }));
});

test("set_automation_enabled liga e desliga todos, e a confirmação vale para o conjunto", async () => {
  const client = await ligarCliente();
  const agentId = id("auto");
  await salvar(client, agentId, [{ config: { kind: "schedule", everyMinutes: 30 } }, { config: TEAMS_PR }]);

  recusa(await client.callTool({ name: "set_automation_enabled", arguments: { agentId, enabled: true } }), /confirmo_reacoes_em_meu_nome/);
  assert.ok((await triggerService.list(agentId)).every((g) => !g.enabled));

  const ligada = ok<{ enabled: boolean }[]>(
    await client.callTool({ name: "set_automation_enabled", arguments: { agentId, enabled: true, confirmo_reacoes_em_meu_nome: true } }),
  );
  assert.ok(ligada.every((g) => g.enabled));
  const lista = ok<{ id: string; enabled: boolean }[]>(await client.callTool({ name: "list_automations", arguments: {} }));
  assert.equal(lista.find((a) => a.id === agentId)?.enabled, true);

  const desligada = ok<{ enabled: boolean }[]>(await client.callTool({ name: "set_automation_enabled", arguments: { agentId, enabled: false } }));
  assert.ok(desligada.every((g) => !g.enabled));

  recusa(await client.callTool({ name: "set_automation_enabled", arguments: { agentId: "nao-existe-aqui", enabled: true } }), /nao cadastrada/);
});

test("set_trigger segue recusando ligar, e trocar a configuração de gatilho ligado desliga", async () => {
  const client = await ligarCliente();
  const agentId = id("auto");
  const salva = await salvar(client, agentId);
  const gatilho = salva.triggers[0]!;
  recusa(await client.callTool({ name: "set_trigger", arguments: { agentId, triggerId: gatilho.id, config: { kind: "schedule", everyMinutes: 30 }, enabled: true } }), /so e ligado por uma pessoa/);

  ok(await client.callTool({ name: "set_trigger_enabled", arguments: { triggerId: gatilho.id, enabled: true } }));
  const trocado = ok<{ enabled: boolean }>(
    await client.callTool({ name: "set_trigger", arguments: { agentId, triggerId: gatilho.id, config: { kind: "schedule", everyMinutes: 60 } } }),
  );
  assert.equal(trocado.enabled, false);
});

test("list_triggers e list_trigger_discards trazem o último erro e os descartes, sem segredo", async () => {
  const client = await ligarCliente();
  const agentId = id("auto");
  const salva = await salvar(client, agentId);
  const gatilho = salva.triggers[0]!;
  await registrarErro(db, gatilho.id, { em: Date.now(), tipo: "batida", texto: `falhou com ${TOKEN}` });
  await registrarDescartes(db, gatilho.id, [{ pr: "acme/api#7", motivo: "autor excluído" }], Date.now());

  const lidos = ok<{ id: string; kind: string; enabled: boolean; lastError: { tipo: string; texto: string } | null }[]>(
    await client.callTool({ name: "list_triggers", arguments: { agentId } }),
  );
  assert.equal(lidos.length, 1);
  assert.equal(lidos[0]?.lastError?.tipo, "batida");
  assert.doesNotMatch(texto(await client.callTool({ name: "list_triggers", arguments: {} })), new RegExp(TOKEN));

  const descartes = ok<{ pr: string; motivo: string }[]>(await client.callTool({ name: "list_trigger_discards", arguments: { triggerId: gatilho.id } }));
  assert.deepEqual(descartes.map((d) => [d.pr, d.motivo]), [["acme/api#7", "autor excluído"]]);
  recusa(await client.callTool({ name: "list_trigger_discards", arguments: { triggerId: "nao-existe" } }), /nao cadastrado/);
});

test("remove_trigger apaga o gatilho e o que ele guardava", async () => {
  const client = await ligarCliente();
  const agentId = id("auto");
  const gatilho = (await salvar(client, agentId)).triggers[0]!;
  await registrarErro(db, gatilho.id, { em: Date.now(), tipo: "configuracao", texto: "x" });
  assert.deepEqual(ok(await client.callTool({ name: "remove_trigger", arguments: { triggerId: gatilho.id } })), { triggerId: gatilho.id, removed: true });
  assert.equal(await triggerService.get(gatilho.id), undefined);
  recusa(await client.callTool({ name: "remove_trigger", arguments: { triggerId: gatilho.id } }), /nao cadastrado/);
});

test("run_automation_now recusa agent do sistema e automação que não existe", async () => {
  const client = await ligarCliente();
  recusa(await client.callTool({ name: "run_automation_now", arguments: { agentId: "locum-chat" } }), /./);
  recusa(await client.callTool({ name: "run_automation_now", arguments: { agentId: "nao-existe-aqui" } }), /./);
});

test("list_connections devolve o estado sem nenhum segredo", async () => {
  const client = await ligarCliente();
  const nome = id("custom");
  ok(
    await client.callTool({
      name: "register_mcp_server",
      arguments: { name: nome, transport: "stdio", command: ["node", "x.js"], env: { API_TOKEN: TOKEN } },
    }),
  );
  const resposta = await client.callTool({ name: "list_connections", arguments: {} });
  const corpo = ok<{ connections: { id: string; state: string; custom: boolean }[]; github: { ref: string; stored: boolean } }>(resposta);
  assert.ok(corpo.connections.some((c) => c.id === "github"));
  assert.ok(corpo.connections.some((c) => c.custom));
  assert.equal(typeof corpo.github.stored, "boolean");
  assert.doesNotMatch(texto(resposta), new RegExp(TOKEN));
});

test("chats e canais do Teams saem do leitor que o servidor recebeu", async () => {
  const chamadas: unknown[] = [];
  const client = await ligarCliente({
    teamsChats: async (opcoes) => {
      chamadas.push(opcoes);
      return [{ chatId: "19:a@thread.v2", label: "Time", chatType: "group" }];
    },
    teamsChannels: async () => [{ teamId: "t1", channelId: "c1", label: "Geral" } as never],
  });
  assert.deepEqual(ok(await client.callTool({ name: "list_teams_chats", arguments: { triggerId: "g1" } })), [{ chatId: "19:a@thread.v2", label: "Time", chatType: "group" }]);
  assert.deepEqual(chamadas, [{ triggerId: "g1" }]);
  assert.equal(ok<unknown[]>(await client.callTool({ name: "list_teams_channels", arguments: {} })).length, 1);
});

test("falha ao ler o Teams volta como resultado com a mensagem", async () => {
  const client = await ligarCliente({
    teamsChats: async () => {
      throw new Error("Teams não conectado");
    },
  });
  recusa(await client.callTool({ name: "list_teams_chats", arguments: {} }), /Teams não conectado/);
});

test("list_sessions lê o leitor recebido e esconde credencial do texto", async () => {
  const dir = mkdtempSync(join(tmpdir(), "locum-claude-"));
  escreverSessoesDeExemplo(dir, "/projetos/exemplo", 4242);
  const servico = new ClaudeSessionsService({
    claudeDir: dir,
    settings: new SettingsService(bancoDeTeste()),
    sessions: { terminal: async () => "terminal" },
    isAlive: () => false,
    gitChanges: async () => null,
    opencodeDb: join(dir, "sem-opencode.db"),
    scriptDir: join(dir, "scripts"),
  });
  const client = await ligarCliente({ sessions: async () => (await servico.list()).map((s, i) => (i === 0 ? { ...s, lastPrompt: `use ${TOKEN}` } : s)) });
  const resposta = await client.callTool({ name: "list_sessions", arguments: {} });
  const lista = ok<{ id: string; title: string }[]>(resposta);
  assert.ok(lista.length >= 2);
  assert.ok(lista.every((s) => typeof s.title === "string"));
  assert.doesNotMatch(texto(resposta), new RegExp(TOKEN));
});

test("a fila sai só para leitura e com a credencial do payload escondida", async () => {
  const client = await ligarCliente();
  const agentId = id("fila");
  const versao = await agentService.upsert(
    { id: agentId, name: "Fila", steps: [{ type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt: "x" }, { type: "action", key: "publicar", name: "Publicar", action: "slack.post", needs: ["ler"] }] } as never,
    undefined,
    "human",
  );
  const run = id("run");
  const passo = id("passo");
  const aprovacao = id("apr");
  await db.insert(schema.runs).values({ id: run, agentVersionId: versao.id, status: "paused" });
  await db.insert(schema.steps).values({ id: passo, runId: run, idx: 1, stepKey: "publicar", name: "Publicar", status: "awaiting_approval" });
  await db.insert(schema.approvals).values({
    id: aprovacao,
    runId: run,
    stepId: passo,
    kind: "slack.post",
    payload: { text: `o token é ${TOKEN}`, channel: "C1", apiToken: "valor-solto-123" },
  });

  const lista = await client.callTool({ name: "list_pending_approvals", arguments: {} });
  const pendentes = ok<{ id: string; status: string; agentId: string }[]>(lista);
  assert.equal(pendentes.find((p) => p.id === aprovacao)?.agentId, agentId);
  assert.doesNotMatch(texto(lista), new RegExp(TOKEN));
  assert.doesNotMatch(texto(lista), /valor-solto-123/);

  const uma = ok<{ id: string; payload: { text: string; channel: string } }>(await client.callTool({ name: "get_approval", arguments: { approvalId: aprovacao } }));
  assert.equal(uma.payload.channel, "C1");
  assert.match(uma.payload.text, /segredo removido/);
  recusa(await client.callTool({ name: "get_approval", arguments: { approvalId: "nao-existe" } }), /nao encontrada/);

  // Decidir continua só da pessoa: a pendência segue pendente.
  const nomes = (await client.listTools()).tools.map((t) => t.name);
  assert.equal(nomes.some((n) => /approve|reject|decide/.test(n)), false);
});

test("remover agent e toolset da biblioteca recusa o que está em uso", async () => {
  const client = await ligarCliente();
  const sufixo = randomUUID().slice(0, 8);
  const toolset = `ts-${sufixo}`;
  const agent = `ag-${sufixo}`;
  ok(await client.callTool({ name: "upsert_toolset", arguments: { toolset: { id: toolset, name: "T", tools: [{ server: "x", tool: "ler" }] }, create: true } }));
  ok(await client.callTool({ name: "upsert_library_agent", arguments: { spec: { id: agent, name: "Ag", model: "anthropic/claude-sonnet-5", toolsets: [toolset] } } }));

  recusa(await client.callTool({ name: "remove_toolset", arguments: { id: toolset } }), /em uso/);
  ok(await client.callTool({ name: "remove_library_agent", arguments: { id: agent } }));
  assert.equal(await libraryService.getProfile(agent), null);
  ok(await client.callTool({ name: "remove_toolset", arguments: { id: toolset } }));
  assert.equal(await libraryService.getToolset(toolset), null);

  recusa(await client.callTool({ name: "remove_library_agent", arguments: { id: agent } }), /não existe/);
  recusa(await client.callTool({ name: "remove_toolset", arguments: { id: toolset } }), /não existe/);
});

test("exportar e importar: sem segredo no texto, copia ao lado e gatilho sempre desligado", async () => {
  const client = await ligarCliente();
  const origem = id("origem");
  const salva = await salvar(client, origem, [{ config: { kind: "schedule", everyMinutes: 30 } }]);
  // Uma pessoa ligou o gatilho da origem: o pacote não pode levar isso.
  await triggerService.setEnabled(salva.triggers[0]!.id, true);

  const exportado = ok<{ fileName: string; text: string }>(await client.callTool({ name: "export_package", arguments: { agentId: origem } }));
  assert.match(exportado.fileName, /\.locum\.json$/);
  assert.doesNotMatch(exportado.text, new RegExp(TOKEN));

  const previa = ok<{ automacao: { id: string; existe: boolean; idSugerido: string } }>(
    await client.callTool({ name: "preview_package", arguments: { text: exportado.text } }),
  );
  assert.equal(previa.automacao.existe, true);

  const novo = id("copia");
  const feito = ok<{ automacaoId: string; gatilhos: number }>(
    await client.callTool({ name: "import_package", arguments: { text: exportado.text, automationId: novo } }),
  );
  assert.equal(feito.automacaoId, novo);
  assert.equal(feito.gatilhos, 1);
  const copia = await triggerService.list(novo);
  assert.equal(copia.length, 1);
  assert.equal(copia[0]?.enabled, false);
  // A origem segue como estava.
  assert.equal((await triggerService.list(origem))[0]?.enabled, true);

  // Mesmo id de automação: recusa em vez de sobrescrever.
  recusa(await client.callTool({ name: "import_package", arguments: { text: exportado.text, automationId: origem } }), /já existe/);
  recusa(await client.callTool({ name: "import_package", arguments: { text: "isto não é um pacote" } }), /./);
  recusa(await client.callTool({ name: "export_package", arguments: { agentId: "nao-existe-aqui" } }), /não existe/);
});

test("entrada fora do formato volta como erro de validação", async () => {
  const client = await ligarCliente();
  for (const [name, args] of [
    ["set_trigger_enabled", { triggerId: "x", enabled: "sim" }],
    ["save_automation", { spec: {}, triggers: "nenhum", note: "x" }],
    ["import_package", { text: "x", agents: { a: { acao: "apagar" } } }],
    ["remove_trigger", {}],
  ] as const) {
    const res = await client.callTool({ name, arguments: args as Record<string, unknown> });
    assert.equal(res.isError, true, name);
  }
});

