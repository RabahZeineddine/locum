import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
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
  const novas = ["list_automations", "get_automation", "list_triggers", "list_trigger_discards", "list_connections", "list_teams_chats", "list_teams_channels", "list_pending_approvals", "get_approval", "list_claude_sessions", "preview_package", "save_automation", "set_automation_enabled", "set_trigger_enabled", "remove_trigger", "remove_library_agent", "remove_toolset", "export_package", "import_package", "run_automation_now", "list_automation_events"];
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
    slackChannels: async () => ({ canais: [{ id: "C1", name: "geral", isPrivate: false }], truncado: false, total: 1, arquivados: [], naoEncontrados: [] }),
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

test("a fila devolve o texto como está, e decidir passa pela gate que o servidor recebeu", async () => {
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
    payload: { text: "Missing null check on token: it can be undefined", channel: "C1" },
  });

  const lista = await client.callTool({ name: "list_pending_approvals", arguments: {} });
  const pendentes = ok<{ id: string; status: string; agentId: string; hash: string }[]>(lista);
  assert.equal(pendentes.find((p) => p.id === aprovacao)?.agentId, agentId);

  const uma = ok<{ id: string; hash: string; payload: { text: string; channel: string } }>(await client.callTool({ name: "get_approval", arguments: { approvalId: aprovacao } }));
  assert.equal(uma.payload.channel, "C1");
  assert.equal(uma.payload.text, "Missing null check on token: it can be undefined");
  assert.equal(pendentes.find((p) => p.id === aprovacao)?.hash, uma.hash, "a fila e a leitura dão o mesmo hash");
  recusa(await client.callTool({ name: "get_approval", arguments: { approvalId: "nao-existe" } }), /nao encontrada/);

  // A confirmação fica amarrada ao que foi visto: sem hash, ou com o de outro conteúdo, nada é decidido.
  recusa(await client.callTool({ name: "decide_approval", arguments: { approvalId: aprovacao, decision: "approved" } }), /hash/);
  ok(await client.callTool({ name: "edit_approval_text", arguments: { approvalId: aprovacao, text: "outro texto, que o cliente não viu" } }));
  recusa(await client.callTool({ name: "decide_approval", arguments: { approvalId: aprovacao, decision: "approved", hash: uma.hash } }), /mudou|changed/);
  assert.deepEqual(decisoes, []);

  const nova = ok<{ hash: string }>(await client.callTool({ name: "get_approval", arguments: { approvalId: aprovacao } }));
  assert.notEqual(nova.hash, uma.hash);
  assert.deepEqual(ok(await client.callTool({ name: "decide_approval", arguments: { approvalId: aprovacao, decision: "rejected", hash: nova.hash } })), {
    approvalId: aprovacao,
    decision: "rejected",
    status: "rejected",
  });
  assert.deepEqual(decisoes, [[aprovacao, "rejected"]]);
  recusa(await client.callTool({ name: "decide_approval", arguments: { approvalId: aprovacao, decision: "talvez", hash: nova.hash } }), /./);
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
    assert.match(descricao, /never reacts/);
    assert.doesNotMatch(descricao, /👀/);
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
  // Sem ai-title, o título da tela é o começo do primeiro pedido: sem o texto, ele não sai.
  assert.doesNotMatch(texto(resposta), /Escrever a migração/);
  assert.ok(lista.every((x) => !("titleFromText" in x)));

  const comTexto = await client.callTool({ name: "list_claude_sessions", arguments: { includeText: true } });
  assert.match(texto(comTexto), /resposta privada/);
  assert.match(texto(comTexto), /Escrever a migração/);
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

test("a fila esconde o literal dos headers e deixa o texto livre e os templates como estão", async () => {
  const client = await ligarCliente();
  const agentId = id("fila");
  const versao = await agentService.upsert({ id: agentId, name: "Fila", steps: [ler, { type: "action", key: "publicar", name: "P", action: "slack.post", needs: ["ler"] }] } as never, undefined, "human");
  const run = id("run");
  const passo = id("passo");
  const aprovacao = id("apr");
  await db.insert(schema.runs).values({ id: run, agentVersionId: versao.id, status: "paused" });
  await db.insert(schema.steps).values({ id: passo, runId: run, idx: 1, stepKey: "publicar", name: "P", status: "awaiting_approval" });
  const segredo = "valor-um-9f8e7d";
  const livre = "Missing null check on token: it can be undefined\nconst apiKey = process.env.API_KEY";
  await db.insert(schema.approvals).values({
    id: aprovacao,
    runId: run,
    stepId: passo,
    kind: "http.request",
    payload: { text: livre, headers: { "X-Api-Key": segredo, Authorization: "Bearer {{steps.auth.token}}" }, credentialRef: "nome-no-cofre" },
  });
  const res = await client.callTool({ name: "get_approval", arguments: { approvalId: aprovacao } });
  assert.doesNotMatch(texto(res), new RegExp(segredo));
  const { payload } = ok<{ payload: { text: string; headers: Record<string, string>; credentialRef: string } }>(res);
  assert.equal(payload.text, livre);
  assert.deepEqual(payload.headers, { "X-Api-Key": "<oculto>", Authorization: "Bearer {{steps.auth.token}}" });
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
    await assert.rejects(ambientePadrao.slackChannels(), /abra o Locum para renovar o Slack/);
    assert.equal(renovou, 0);
  } finally {
    mcpOAuthService.lerSemRenovar = original;
    mcpOAuthService.refreshIfNeeded = renovar;
  }
});


test("run_automation_now ganha eventId e prUrl, e list_automation_events é leitura que diz se a automação precisa de evento", async () => {
  const client = await ligarCliente();
  const ferramentas = (await client.listTools()).tools;
  const rodar = ferramentas.find((t) => t.name === "run_automation_now")!;
  assert.deepEqual(Object.keys((rodar.inputSchema as { properties: object }).properties).sort(), ["agentId", "eventId", "prUrl"]);
  assert.equal(rodar.annotations?.destructiveHint, true);
  const eventos = ferramentas.find((t) => t.name === "list_automation_events")!;
  assert.equal(eventos.annotations?.readOnlyHint, true);

  const agentId = id("revisar");
  await client.callTool({
    name: "save_automation",
    arguments: {
      spec: {
        id: agentId,
        name: "Revisar PRs",
        steps: [{ type: "model", key: "revisar", name: "revisar", model: "anthropic/modelo", prompt: "Revise {{event.repo}}" }],
      },
      triggers: [],
      note: "x",
      create: true,
    },
  });
  const lista = ok<{ precisaDeEvento: string | null; recentes: unknown[] }>(await client.callTool({ name: "list_automation_events", arguments: { agentId } }));
  assert.deepEqual(lista.precisaDeEvento, { codigo: "marcador", marcador: "{{event.repo}}" });
  assert.deepEqual(lista.recentes, []);
  recusa(await client.callTool({ name: "run_automation_now", arguments: { agentId } }), /precisa de um evento \(usa \{\{event\.repo\}\}\); escolha um evento recente ou cole um link/);
  recusa(await client.callTool({ name: "run_automation_now", arguments: { agentId, prUrl: "https://example.com/x" } }), /link de um pull request do GitHub/);
});

test("automação com campo a preencher: get e list mostram, ligar recusa com o motivo, e salvar com o campo preenchido limpa", async () => {
  const client = await ligarCliente();
  const agentId = `pendente-${randomUUID().slice(0, 8)}`;
  const poll = { kind: "poll", source: "github", repoMatch: "x-.*", authorship: "others" };
  const criada = ok<Salva>(await client.callTool({ name: "save_automation", arguments: { spec: spec(agentId), triggers: [{ config: poll }], note: "importada", create: true } }));
  // A pendência de gatilho aponta para o id do gatilho cadastrado.
  const esperado = [{ onde: `gatilho:${criada.triggers[0]!.id}`, campo: "owner", motivo: "dono-do-github" }];
  const comPendencia = { ...spec(agentId), pendentes: esperado };
  const salva = ok<Salva>(await client.callTool({ name: "save_automation", arguments: { spec: comPendencia, triggers: [{ id: criada.triggers[0]!.id, config: poll }], note: "com pendência" } }));

  assert.deepEqual(ok<{ pending: unknown }>(await client.callTool({ name: "get_automation", arguments: { agentId } })).pending, esperado);
  const lista = ok<{ id: string; pending: unknown }[]>(await client.callTool({ name: "list_automations", arguments: {} }));
  assert.deepEqual(lista.find((a) => a.id === agentId)?.pending, esperado);
  recusa(await client.callTool({ name: "set_trigger_enabled", arguments: { triggerId: salva.triggers[0]!.id, enabled: true } }), /gatilho incompleto.*owner/);
  recusa(await client.callTool({ name: "set_automation_enabled", arguments: { agentId, enabled: true } }), /gatilho incompleto/);

  const limpa = ok<{ pending: unknown[] }>(
    await client.callTool({ name: "save_automation", arguments: { spec: comPendencia, triggers: [{ id: salva.triggers[0]!.id, config: { ...poll, owner: "empresa" } }], note: "dono escolhido" } }),
  );
  assert.deepEqual(limpa.pending, []);
  ok(await client.callTool({ name: "set_trigger_enabled", arguments: { triggerId: salva.triggers[0]!.id, enabled: true } }));
});

test("save_automation mantém a pendência de uma versão a outra e só dismissPending, por nome, a tira sem preencher", async () => {
  const client = await ligarCliente();
  const agentId = `dispensa-${randomUUID().slice(0, 8)}`;
  const pendentes = [{ onde: "publicar", campo: "params.destino", motivo: "destino-a-escolher" }];
  const base = spec(agentId);
  ok(await client.callTool({ name: "save_automation", arguments: { spec: { ...base, pendentes }, triggers: [], note: "importada", create: true } }));

  // O spec remontado sem pendentes não a apaga.
  const mantida = ok<{ pending: unknown[] }>(await client.callTool({ name: "save_automation", arguments: { spec: base, triggers: [], note: "remontado" } }));
  assert.deepEqual(mantida.pending, pendentes);

  recusa(await client.callTool({ name: "save_automation", arguments: { spec: base, triggers: [], note: "x", dismissPending: [{ onde: "publicar", campo: "nao-existe" }] } }), /não há pendência/);
  const dispensada = ok<{ pending: unknown[] }>(await client.callTool({ name: "save_automation", arguments: { spec: base, triggers: [], note: "dispensei", dismissPending: [{ onde: "publicar", campo: "params.destino" }] } }));
  assert.deepEqual(dispensada.pending, []);
});

test("archive_automation arquiva, aparece como destrutiva, diz o bloqueio pela contagem e a arquivada só aparece com archived", async () => {
  const client = await ligarCliente();
  const ferramenta = (await client.listTools()).tools.find((t) => t.name === "archive_automation");
  assert.equal(ferramenta?.annotations?.destructiveHint, true);

  const agentId = id("auto");
  const { gatilhos } = await comoPessoa(agentId, [ler], [{ kind: "manual" }, { kind: "schedule", everyMinutes: 30 }]);
  const versao = (await agentService.getLatestVersion(agentId))!;
  const runId = `run-${agentId}`;
  db.insert(schema.runs).values({ id: runId, agentVersionId: versao.id, status: "running" }).run();
  recusa(await client.callTool({ name: "archive_automation", arguments: { agentId } }), /1 run\(s\) queued or running: open the app/);
  assert.equal((await agentService.get(agentId))?.archivedAt, null);

  db.update(schema.runs).set({ status: "done" }).where(eq(schema.runs.id, runId)).run();
  assert.deepEqual(ok(await client.callTool({ name: "archive_automation", arguments: { agentId } })), { agentId, archived: true, triggers: gatilhos.length });
  assert.equal(ok<{ id: string }[]>(await client.callTool({ name: "list_automations", arguments: {} })).some((a) => a.id === agentId), false);
  assert.equal(ok<{ id: string }[]>(await client.callTool({ name: "list_automations", arguments: { archived: true } })).some((a) => a.id === agentId), true);
  assert.equal(db.select().from(schema.runs).where(eq(schema.runs.id, runId)).all().length, 1);

  assert.deepEqual(ok(await client.callTool({ name: "unarchive_automation", arguments: { agentId } })), { agentId, archived: false });
  assert.equal(ok<{ id: string }[]>(await client.callTool({ name: "list_automations", arguments: {} })).some((a) => a.id === agentId), true);
  recusa(await client.callTool({ name: "archive_automation", arguments: { agentId: "nao-existe-x" } }), /nao cadastrada/);
});

test("delete_automation é destrutiva, recusa a ativa e a que tem run em curso, e deleta a arquivada com o que pende dela", async () => {
  const client = await ligarCliente();
  const ferramenta = (await client.listTools()).tools.find((t) => t.name === "delete_automation");
  assert.equal(ferramenta?.annotations?.destructiveHint, true);

  const agentId = id("auto");
  const { gatilhos } = await comoPessoa(agentId, [ler], [{ kind: "manual" }]);
  const versao = (await agentService.getLatestVersion(agentId))!;
  const runId = `run-${agentId}`;
  db.insert(schema.runs).values({ id: runId, agentVersionId: versao.id, triggerId: gatilhos[0]!.id, status: "done" }).run();
  recusa(await client.callTool({ name: "delete_automation", arguments: { agentId } }), /archive it first/);
  assert.notEqual(await agentService.get(agentId), undefined);

  ok(await client.callTool({ name: "archive_automation", arguments: { agentId } }));
  db.update(schema.runs).set({ status: "running" }).where(eq(schema.runs.id, runId)).run();
  recusa(await client.callTool({ name: "delete_automation", arguments: { agentId } }), /1 run\(s\) queued or running: open the app.*then delete/);
  assert.notEqual(await agentService.get(agentId), undefined);

  db.update(schema.runs).set({ status: "done" }).where(eq(schema.runs.id, runId)).run();
  assert.deepEqual(ok(await client.callTool({ name: "delete_automation", arguments: { agentId } })), { agentId, deleted: true, runs: 1, versions: 1 });
  assert.equal(await agentService.get(agentId), undefined);
  assert.equal(db.select().from(schema.runs).where(eq(schema.runs.id, runId)).all().length, 0);
  recusa(await client.callTool({ name: "delete_automation", arguments: { agentId } }), /nao cadastrada/);
});

test("delete_automation recusa a automação ligada a uma iniciativa: é decisão de uma pessoa, na tela", async () => {
  const client = await ligarCliente();
  const agentId = id("auto");
  await comoPessoa(agentId, [ler]);
  const slug = `ini-${agentId}`;
  db.insert(schema.initiatives).values({ id: slug, slug, title: "Plano", objective: "o", doneCriteria: "c", contextPath: "/tmp/ctx" }).run();
  db.update(schema.agents).set({ initiativeId: slug }).where(eq(schema.agents.id, agentId)).run();
  db.update(schema.agents).set({ archivedAt: 1 }).where(eq(schema.agents.id, agentId)).run();
  recusa(await client.callTool({ name: "delete_automation", arguments: { agentId } }), /decisão de uma pessoa, na tela/);
  assert.notEqual(await agentService.get(agentId), undefined);
});

test("archive_automation recusa a automação ligada a uma iniciativa: é decisão de uma pessoa, na tela", async () => {
  const client = await ligarCliente();
  const agentId = id("auto");
  await comoPessoa(agentId, [ler], [{ kind: "manual" }]);
  db.insert(schema.initiatives).values({ id: `ini-${agentId}`, slug: `ini-${agentId}`, title: "T", objective: "o", doneCriteria: "c", contextPath: "/tmp/ctx" }).run();
  db.update(schema.agents).set({ initiativeId: `ini-${agentId}` }).where(eq(schema.agents.id, agentId)).run();
  recusa(await client.callTool({ name: "archive_automation", arguments: { agentId } }), /decisão de uma pessoa, na tela/);
  assert.equal((await agentService.get(agentId))?.archivedAt, null);
});
