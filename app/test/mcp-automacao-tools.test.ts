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
import type { Ambiente } from "../src/mcp-server/ambiente.js";
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

async function ligarCliente(fora: Partial<Ambiente> = {}): Promise<Client> {
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

test("a lista de ferramentas traz as antigas e as novas, inclusive decidir, conectar e segredo", async () => {
  const client = await ligarCliente();
  const nomes = new Set((await client.listTools()).tools.map((t) => t.name));
  const antigas = ["locum_health", "list_agents", "get_agent", "list_runs", "get_run", "list_findings", "get_metrics", "list_mcp_servers", "list_providers", "get_machine_profile", "upsert_agent", "register_mcp_server", "test_mcp_server", "list_server_tools", "set_model_fallback", "set_budget", "set_trigger", "run_agent", "rerun_step", "describe_steps", "list_library_agents", "get_library_agent", "upsert_library_agent", "list_toolsets", "upsert_toolset"];
  const novas = ["list_automations", "get_automation", "list_triggers", "list_trigger_discards", "list_connections", "list_teams_chats", "list_teams_channels", "list_pending_approvals", "get_approval", "list_claude_sessions", "preview_package", "save_automation", "set_automation_enabled", "set_trigger_enabled", "remove_trigger", "remove_library_agent", "remove_toolset", "export_package", "import_package", "run_automation_now"];
  // Paridade com a tela: decidir, conectar e guardar segredo também passam pelo MCP, e o cliente confirma.
  const daTela = ["decide_approval", "connect_teams", "save_github_token", "use_gh_account", "set_mcp_server_enabled", "save_provider_secret", "agent_chat_send"];
  for (const nome of [...antigas, ...novas, ...daTela]) assert.ok(nomes.has(nome), `falta ${nome}`);
});

test("save_automation grava como a tela: ação em auto fica, gatilho novo desligado, e aparece nas leituras", async () => {
  const client = await ligarCliente();
  const agentId = id("auto");
  const salva = await salvar(client, agentId, [{ config: { kind: "schedule", everyMinutes: 30 } }, { config: { kind: "manual" } }]);
  assert.equal(salva.version, 1);
  assert.equal(salva.triggers.length, 2);
  assert.ok(salva.triggers.every((t) => t.enabled === false));

  const emAuto = ok<{ version: number }>(
    await client.callTool({
      name: "save_automation",
      arguments: {
        spec: spec(agentId, { mode: "auto" }),
        triggers: salva.triggers.map((t) => ({ id: t.id, config: { kind: t.kind === "manual" ? "manual" : "schedule", ...(t.kind === "schedule" ? { everyMinutes: 30 } : {}) } })),
        note: "ação em auto",
      },
    }),
  );
  assert.equal(emAuto.version, 2);

  const lida = ok<{ spec: { steps: { key: string; mode?: string }[] }; enabled: boolean; triggers: { id: string }[] }>(
    await client.callTool({ name: "get_automation", arguments: { agentId } }),
  );
  assert.equal(lida.spec.steps.find((s) => s.key === "publicar")?.mode, "auto");
  assert.equal(lida.enabled, false);
  assert.equal(lida.triggers.length, 2);

  const lista = ok<{ id: string; triggers: unknown[]; enabled: boolean }[]>(await client.callTool({ name: "list_automations", arguments: {} }));
  const linha = lista.find((a) => a.id === agentId);
  assert.equal(linha?.triggers.length, 2);
  assert.equal(linha?.enabled, false);

  recusa(await client.callTool({ name: "get_automation", arguments: { agentId: "nao-existe-aqui" } }), /nao cadastrada/);
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

test("a fila sai com a credencial do payload escondida, e decidir passa pela gate que o servidor recebeu", async () => {
  const decisoes: [string, string][] = [];
  const client = await ligarCliente({
    decidir: async (approvalId, decision) => {
      decisoes.push([approvalId, decision]);
      return { status: decision };
    },
  });
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

  assert.deepEqual(ok(await client.callTool({ name: "decide_approval", arguments: { approvalId: aprovacao, decision: "rejected" } })), {
    approvalId: aprovacao,
    decision: "rejected",
    status: "rejected",
  });
  assert.deepEqual(decisoes, [[aprovacao, "rejected"]]);
  recusa(await client.callTool({ name: "decide_approval", arguments: { approvalId: aprovacao, decision: "talvez" } }), /./);
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


/** O que só uma pessoa faz, pela tela: grava o spec como pessoa e liga o gatilho. */
async function comoPessoa(agentId: string, steps: unknown[], triggers: unknown[] = [{ kind: "manual" }]) {
  const versao = await agentService.upsert({ id: agentId, name: "Pessoa", steps } as never, "da pessoa", "human");
  const gatilhos = [];
  for (const config of triggers) gatilhos.push(await triggerService.set(agentId, config as never));
  return { versao, gatilhos };
}

const ler = { type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt: "revise" };
const http = (extra: Record<string, unknown> = {}) => ({
  type: "action",
  key: "enviar",
  name: "Enviar",
  action: "http.request",
  mode: "auto",
  needs: ["ler"],
  params: { method: "POST", url: "https://exemplo.com/a" },
  ...extra,
});

test("save_automation liga gatilho só com enabled true, e recusa id repetido e gatilho inválido sem gravar nada", async () => {
  const client = await ligarCliente();
  const agentId = id("auto");
  recusa(
    await client.callTool({ name: "save_automation", arguments: { spec: spec(agentId), triggers: [{ config: { kind: "inexistente" } }], note: "x", create: true } }),
    /./,
  );
  assert.equal(await agentService.get(agentId), undefined);
  const salva = ok<Salva>(
    await client.callTool({
      name: "save_automation",
      arguments: { spec: spec(agentId), triggers: [{ config: { kind: "manual" }, enabled: true }, { config: { kind: "schedule", everyMinutes: 30 } }], note: "x", create: true },
    }),
  );
  assert.deepEqual(salva.triggers.map((t) => [t.kind, t.enabled]).sort(), [["manual", true], ["schedule", false]]);
  recusa(await client.callTool({ name: "save_automation", arguments: { spec: spec(agentId), triggers: [], note: "x", create: true } }), /já existe/);
});

test("ligar e desligar pela ferramenta, um gatilho ou a automação inteira, e a descrição diz o efeito", async () => {
  const client = await ligarCliente();
  const agentId = id("auto");
  const salva = await salvar(client, agentId, [{ config: { kind: "schedule", everyMinutes: 30 } }, { config: TEAMS_PR }]);
  const [relogio, teams] = [salva.triggers[0]!, salva.triggers[1]!];

  assert.equal(ok<{ enabled: boolean }>(await client.callTool({ name: "set_trigger_enabled", arguments: { triggerId: relogio.id, enabled: true } })).enabled, true);
  assert.equal((await triggerService.get(teams.id))?.enabled, false);

  const todos = ok<{ enabled: boolean }[]>(await client.callTool({ name: "set_automation_enabled", arguments: { agentId, enabled: true } }));
  assert.ok(todos.every((g) => g.enabled));
  const nenhum = ok<{ enabled: boolean }[]>(await client.callTool({ name: "set_automation_enabled", arguments: { agentId, enabled: false } }));
  assert.ok(nenhum.every((g) => !g.enabled));
  recusa(await client.callTool({ name: "set_automation_enabled", arguments: { agentId: "nao-existe-aqui", enabled: false } }), /nao cadastrada/);

  const ferramentas = (await client.listTools()).tools;
  for (const nome of ["set_trigger_enabled", "set_automation_enabled"]) {
    const descricao = ferramentas.find((t) => t.name === nome)?.description ?? "";
    assert.match(descricao, /act by itself with your accounts/);
    assert.match(descricao, /👀/);
  }
});

test("set_trigger segue recusando ligar, e trocar a configuração de gatilho ligado desliga", async () => {
  const client = await ligarCliente();
  const agentId = id("auto");
  const { gatilhos } = await comoPessoa(agentId, [ler], [{ kind: "schedule", everyMinutes: 30 }]);
  const gatilho = gatilhos[0]!;
  recusa(await client.callTool({ name: "set_trigger", arguments: { agentId, triggerId: gatilho.id, config: { kind: "schedule", everyMinutes: 30 }, enabled: true } }), /so e ligado por uma pessoa/);
  await triggerService.setEnabled(gatilho.id, true);
  const trocado = ok<{ enabled: boolean }>(
    await client.callTool({ name: "set_trigger", arguments: { agentId, triggerId: gatilho.id, config: { kind: "schedule", everyMinutes: 60 } } }),
  );
  assert.equal(trocado.enabled, false);
});

/** `upsert_agent` grava como agent: o passo auto que mudou volta para aprovação, e a pessoa (save_automation) não rebaixa. */
async function comoAgent(client: Client, agentId: string, steps: unknown[]) {
  return ok<{ downgrades: { step: string }[] }>(await client.callTool({ name: "upsert_agent", arguments: { spec: { id: agentId, name: "Pessoa", steps }, note: "de fora" } }));
}

test("upsert_agent rebaixa o passo auto que mudou: params, when, optional", async () => {
  const client = await ligarCliente();
  const logica = { type: "logic", key: "decidir", name: "Decidir", op: "if", needs: ["ler"], input: "x", compare: "equals", against: "y" };
  const comWhen = (extra: Record<string, unknown> = {}) => http({ needs: ["decidir"], when: { step: "decidir", branch: "true" }, ...extra });
  const topo = async (agentId: string) => (await agentService.getLatestVersion(agentId))!.spec.steps.find((s) => s.key === "enviar") as { mode: string };

  const igual = id("auto");
  await comoPessoa(igual, [ler, logica, comWhen()]);
  assert.deepEqual((await comoAgent(client, igual, [ler, logica, comWhen()])).downgrades, []);
  assert.equal((await topo(igual)).mode, "auto");

  for (const [nome, passos] of [
    ["url", [ler, logica, comWhen({ params: { method: "POST", url: "https://outro.exemplo/x" } })]],
    ["sem when", [ler, logica, http({ needs: ["decidir"] })]],
    ["opcional", [ler, logica, comWhen({ optional: true })]],
  ] as const) {
    const agentId = id("auto");
    await comoPessoa(agentId, [ler, logica, comWhen()]);
    assert.deepEqual((await comoAgent(client, agentId, [...passos])).downgrades.map((d) => d.step), ["enviar"], nome);
    assert.equal((await topo(agentId)).mode, "approve", nome);
  }

  // Pela save_automation, que grava como a tela, a URL nova fica em auto.
  const agentId = id("auto");
  await comoPessoa(agentId, [ler, http()]);
  const salvo = ok<Salva>(
    await client.callTool({
      name: "save_automation",
      arguments: { spec: { id: agentId, name: "Pessoa", steps: [ler, http({ params: { method: "POST", url: "https://outro.exemplo/y" } })] }, triggers: [{ config: { kind: "manual" } }], note: "troquei a url" },
    }),
  );
  assert.ok(salvo.version > 1);
  assert.equal((await topo(agentId)).mode, "auto");
});

test("remove_trigger tira o gatilho, ligado ou não, e save_automation tira o que ficou de fora", async () => {
  const client = await ligarCliente();
  const agentId = id("auto");
  const { gatilhos } = await comoPessoa(agentId, [ler], [{ kind: "manual" }, { kind: "schedule", everyMinutes: 30 }]);
  const [manual, relogio] = [gatilhos[0]!, gatilhos[1]!];
  await triggerService.setEnabled(relogio.id, true);

  assert.deepEqual(ok(await client.callTool({ name: "remove_trigger", arguments: { triggerId: relogio.id } })), { triggerId: relogio.id, removed: true });
  assert.equal(await triggerService.get(relogio.id), undefined);
  await registrarErro(db, manual.id, { em: Date.now(), tipo: "configuracao", texto: "x" });
  const depois = ok<Salva>(
    await client.callTool({ name: "save_automation", arguments: { spec: { id: agentId, name: "Pessoa", steps: [ler] }, triggers: [], note: "sem gatilhos" } }),
  );
  assert.deepEqual(depois.triggers, []);
  recusa(await client.callTool({ name: "remove_trigger", arguments: { triggerId: manual.id } }), /nao cadastrado/);
});

test("save_automation sem id mantém o gatilho ligado quando a config é a mesma", async () => {
  const client = await ligarCliente();
  const agentId = id("auto");
  const { gatilhos } = await comoPessoa(agentId, [ler], [{ kind: "schedule", everyMinutes: 30 }]);
  await triggerService.setEnabled(gatilhos[0]!.id, true);
  const res = ok<Salva>(
    await client.callTool({ name: "save_automation", arguments: { spec: { id: agentId, name: "Pessoa", steps: [ler] }, triggers: [{ config: { kind: "schedule", everyMinutes: 30 } }], note: "igual" } }),
  );
  assert.deepEqual(res.triggers.map((g) => [g.id, g.enabled]), [[gatilhos[0]!.id, true]]);
});

test("o gatilho que o pacote deixou esperando chats só vale para todos com a confirmação explícita", async () => {
  const client = await ligarCliente();
  const agentId = id("auto");
  const salva = await salvar(client, agentId, [{ config: { ...TEAMS_PR, chatsPendentes: 2 } }]);
  const gatilho = salva.triggers[0]!;
  const lido = ok<{ blockedUntil?: string }[]>(await client.callTool({ name: "list_triggers", arguments: { agentId } }));
  assert.ok(lido[0]?.blockedUntil);
  recusa(await client.callTool({ name: "set_trigger_enabled", arguments: { triggerId: gatilho.id, enabled: true } }), /escolha os chats/);

  // Zerar a pendência com a lista vazia, sem confirmar, é recusado no serviço, por qualquer ferramenta.
  recusa(await client.callTool({ name: "set_trigger", arguments: { agentId, triggerId: gatilho.id, config: { ...TEAMS_PR, chatsPendentes: 0 } } }), /escolha os chats/);
  const refaz = (triggers: unknown[]) => client.callTool({ name: "save_automation", arguments: { spec: spec(agentId), triggers, note: "chats" } });
  recusa(await refaz([{ id: gatilho.id, config: { ...TEAMS_PR, chatsPendentes: 0 } }]), /escolha os chats/);
  assert.equal(((await triggerService.get(gatilho.id))?.config as { chatsPendentes: number }).chatsPendentes, 2);

  // Com a confirmação, vale para todos os chats.
  const todos = ok<{ config: { chatsPendentes: number; chats: unknown[] } }>(await client.callTool({ name: "allow_all_chats_for_trigger", arguments: { triggerId: gatilho.id } }));
  assert.equal(todos.config.chatsPendentes, 0);
  assert.deepEqual(todos.config.chats, []);

  // Outro gatilho de pacote: escolhendo os chats a pendência sai.
  const outro = id("auto");
  const g2 = (await salvar(client, outro, [{ config: { ...TEAMS_PR, chatsPendentes: 1 } }])).triggers[0]!;
  ok(await client.callTool({ name: "save_automation", arguments: { spec: spec(outro), triggers: [{ id: g2.id, config: { ...TEAMS_PR, chatsPendentes: 0, chats: [{ chatId: "19:chat@thread.v2", label: "Time" }] } }], note: "chats" } }));
  assert.equal(((await triggerService.get(g2.id))?.config as { chatsPendentes: number }).chatsPendentes, 0);
});

test("trocar o gatilho de pacote por um sem id não escapa da pendência de chats", async () => {
  const client = await ligarCliente();
  const agentId = id("auto");
  const antigo = (await salvar(client, agentId, [{ config: { ...TEAMS_PR, chatsPendentes: 2 } }])).triggers[0]!;
  const refaz = (triggers: unknown[]) => client.callTool({ name: "save_automation", arguments: { spec: spec(agentId), triggers, note: "troca" } });

  // Sem id, pendência zerada e ligado: o novo herda a pendência e a ligação é recusada.
  recusa(await refaz([{ config: { ...TEAMS_PR, chatsPendentes: 0 }, enabled: true }]), /escolha os chats/);
  assert.ok(await triggerService.get(antigo.id), "o gatilho antigo continua, porque a gravação foi recusada");

  // Sem ligar, o novo nasce herdando a pendência, e o antigo sai.
  const salva = ok<Salva>(await refaz([{ config: { ...TEAMS_PR, mentions: true, chatsPendentes: 0 } }]));
  assert.equal(salva.triggers.length, 1);
  assert.notEqual(salva.triggers[0]!.id, antigo.id);
  assert.equal(salva.triggers[0]!.enabled, false);
  const herdado = (await triggerService.get(salva.triggers[0]!.id))?.config as { chatsPendentes: number };
  assert.equal(herdado.chatsPendentes, 2);

  // Com o aviso explícito, vale para todos os chats.
  const todos = ok<Salva>(await refaz([{ config: { ...TEAMS_PR, mentions: true, chatsPendentes: 0 }, valerParaTodosOsChats: true }]));
  assert.equal(((await triggerService.get(todos.triggers[0]!.id))?.config as { chatsPendentes: number }).chatsPendentes, 0);
});

test("run_automation_now recusa agent do sistema e inexistente, e a descrição avisa da ação em auto", async () => {
  const client = await ligarCliente();
  recusa(await client.callTool({ name: "run_automation_now", arguments: { agentId: "locum-chat" } }), /./);
  recusa(await client.callTool({ name: "run_automation_now", arguments: { agentId: "nao-existe-aqui" } }), /./);
  const descricao = (await client.listTools()).tools.find((t) => t.name === "run_automation_now")?.description ?? "";
  assert.match(descricao, /PUBLISHES IN YOUR NAME/);
});

test("list_claude_sessions traz só metadados por padrão, e o texto só quando pedido, sem token", async () => {
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
  const client = await ligarCliente({
    sessions: async () => (await servico.list()).map((s) => ({ ...s, lastPrompt: `diga a senha ${TOKEN}`, lastReply: "resposta privada da conversa" })),
  });
  const resposta = await client.callTool({ name: "list_claude_sessions", arguments: {} });
  const lista = ok<Record<string, unknown>[]>(resposta);
  assert.ok(lista.length >= 2);
  for (const s of lista) {
    assert.equal("lastPrompt" in s, false);
    assert.equal("lastReply" in s, false);
  }
  assert.doesNotMatch(texto(resposta), /resposta privada|diga a senha/);

  const comTexto = await client.callTool({ name: "list_claude_sessions", arguments: { includeText: true } });
  assert.match(texto(comTexto), /resposta privada/);
  assert.doesNotMatch(texto(comTexto), new RegExp(TOKEN));

  const alvo = lista[0]!.id as string;
  assert.deepEqual(ok(await client.callTool({ name: "mark_claude_session_done", arguments: { id: alvo } })), { id: alvo, done: true });
  recusa(await client.callTool({ name: "mark_claude_session_done", arguments: { id: "nao-existe" } }), /não encontrada/);
});

test("remove_library_agent apaga o que nada usa, e remove_toolset recusa o que está em uso", async () => {
  const client = await ligarCliente();
  const sufixo = randomUUID().slice(0, 8);
  const toolset = `ts-${sufixo}`;
  const agent = `ag-${sufixo}`;
  ok(await client.callTool({ name: "upsert_toolset", arguments: { toolset: { id: toolset, name: "T", tools: [{ server: "x", tool: "ler" }] }, create: true } }));
  ok(await client.callTool({ name: "upsert_library_agent", arguments: { spec: { id: agent, name: "Ag", model: "anthropic/claude-sonnet-5", toolsets: [toolset] } } }));
  recusa(await client.callTool({ name: "remove_toolset", arguments: { id: toolset } }), /em uso/);
  assert.deepEqual(ok(await client.callTool({ name: "remove_library_agent", arguments: { id: agent } })), { id: agent, removed: true });
  assert.equal(await libraryService.getProfile(agent), null);
  ok(await client.callTool({ name: "remove_toolset", arguments: { id: toolset } }));
  assert.equal(await libraryService.getToolset(toolset), null);
  recusa(await client.callTool({ name: "remove_toolset", arguments: { id: toolset } }), /não existe/);
  recusa(await client.callTool({ name: "remove_library_agent", arguments: { id: agent } }), /não existe/);
});

test("perfil da biblioteca que alimenta ação auto muda pelo MCP como pela tela, também no import_package", async () => {
  const client = await ligarCliente();
  const perfil = id("perfil");
  const modelo = { id: perfil, name: "Perfil", model: "anthropic/claude-sonnet-5", instructions: "original" };
  ok(await client.callTool({ name: "upsert_library_agent", arguments: { spec: modelo, create: true } }));
  const origem = id("origem");
  await comoPessoa(origem, [{ ...ler, profile: perfil }, http()]);

  ok(await client.callTool({ name: "upsert_library_agent", arguments: { spec: { ...modelo, instructions: "nova instrução" } } }));
  assert.equal((await libraryService.getProfile(perfil))?.spec.instructions, "nova instrução");

  const exportado = ok<{ text: string }>(await client.callTool({ name: "export_package", arguments: { agentId: origem } }));
  await libraryService.saveProfile({ spec: { ...modelo, instructions: "editado pela pessoa" } as never, note: "pessoa" });
  ok(await client.callTool({ name: "import_package", arguments: { text: exportado.text, automationId: id("copia"), agents: { [perfil]: { acao: "atualizar" } } } }));
  assert.equal((await libraryService.getProfile(perfil))?.spec.instructions, "nova instrução");
});

test("a redação cobre token solto, linha de ambiente, JSON serializado e cookie", async () => {
  const client = await ligarCliente();
  const agentId = id("fila");
  const versao = await agentService.upsert({ id: agentId, name: "Fila", steps: [ler, { type: "action", key: "publicar", name: "P", action: "slack.post", needs: ["ler"] }] } as never, undefined, "human");
  const run = id("run");
  const passo = id("passo");
  const aprovacao = id("apr");
  await db.insert(schema.runs).values({ id: run, agentVersionId: versao.id, status: "paused" });
  await db.insert(schema.steps).values({ id: passo, runId: run, idx: 1, stepKey: "publicar", name: "P", status: "awaiting_approval" });
  const segredos = ["valor-um-9f8e7d", "valor-dois-1a2b3c", "valor-tres-4d5e6f", "valor-quatro-7a8b9c", "valor-cinco-0a1b2c", "valor-seis-3c4d5e", "valor-sete-6f7a8b", "valor-oito-9c0d1e"];
  await db.insert(schema.approvals).values({
    id: aprovacao,
    runId: run,
    stepId: passo,
    kind: "slack.post",
    payload: {
      text: [
        `token: ${segredos[0]}`,
        `GITHUB_TOKEN=${segredos[1]}`,
        `API_KEY=${segredos[2]}`,
        `{"access_token":"${segredos[3]}"}`,
        `Cookie: sessao=${segredos[4]}; outra=1`,
        `Set-Cookie: sid=${segredos[5]}`,
      ].join("\n"),
      clientSecret: segredos[6],
      privateKey: segredos[7],
      credential: "abc",
      refresh_token: "r",
      id_token: "i",
      credentialRef: "nome-no-cofre",
    },
  });
  const res = await client.callTool({ name: "get_approval", arguments: { approvalId: aprovacao } });
  const corpo = texto(res);
  for (const segredo of segredos) assert.doesNotMatch(corpo, new RegExp(segredo), segredo);
  const { payload } = ok<{ payload: Record<string, string> }>(res);
  for (const chave of ["clientSecret", "privateKey", "credential", "refresh_token", "id_token"]) assert.equal(payload[chave], "<oculto>", chave);
  assert.equal(payload.credentialRef, "nome-no-cofre");
});

test("Teams com o acesso nativo vencido pede para abrir o Locum, sem renovar", async () => {
  const { ambientePadrao, RENOVAR_TEAMS } = await import("../src/mcp-server/ambiente.js");
  const { mcpOAuthService } = await import("../src/services/mcp-oauth-service.js");
  const original = mcpOAuthService.lerSemRenovar.bind(mcpOAuthService);
  let renovou = 0;
  const renovar = mcpOAuthService.refreshIfNeeded.bind(mcpOAuthService);
  mcpOAuthService.refreshIfNeeded = async () => {
    renovou += 1;
  };
  mcpOAuthService.lerSemRenovar = () => ({ token: "qualquer", vencido: true });
  try {
    await assert.rejects(ambientePadrao.teamsChats({}), new RegExp(RENOVAR_TEAMS));
    await assert.rejects(ambientePadrao.teamsChannels(), /abra o Locum para renovar o Teams/);
    assert.equal(renovou, 0);
  } finally {
    mcpOAuthService.lerSemRenovar = original;
    mcpOAuthService.refreshIfNeeded = renovar;
  }
});

