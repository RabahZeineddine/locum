import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { eq } from "drizzle-orm";
import { schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import type { TriggerConfig } from "../src/config/types.js";
import { readCodexEvents } from "../src/runtimes/codex.js";
import { lerRateLimitsDoCodex } from "../src/runtimes/limites-codex.js";
import { duracaoEmSegundos, lerCabecalhosDeTaxa } from "../src/runtimes/limites-cabecalhos.js";
import { aoGastar, aoLerLimites, type LimiteLido } from "../src/runtimes/limites-lidos.js";
import { NativeRuntime } from "../src/runtimes/native.js";
import { AutomationService } from "../src/services/automation-service.js";
import type { ExecutionService } from "../src/services/execution-service.js";
import type { McpService } from "../src/services/mcp-service.js";
import type { SlackService } from "../src/services/slack-service.js";
import { LimitesService, urlDoKeyInfo, estadoDoUso, INTERVALO_DO_GATEWAY_MS } from "../src/services/limites-service.js";
import { pausaDoAgent } from "../src/services/pausa-por-limite.js";
import { SettingsService } from "../src/services/settings-service.js";
import type { TriggerEntry, TriggerService } from "../src/services/trigger-service.js";
import { Scheduler } from "../src/triggers/scheduler.js";
import { bancoDeTeste } from "./helpers/db.js";

const MINUTO = 60_000;
const AGORA = new Date(2026, 9, 15, 12, 0, 0).getTime();

function servico(extra: ConstructorParameters<typeof LimitesService>[0] = {}) {
  const db = bancoDeTeste();
  const relogio = { agora: AGORA };
  const s = new LimitesService({ db, settings: new SettingsService(db), agora: () => relogio.agora, ...extra });
  return { s, db, relogio };
}

const janela = (chave: string, uso: number, resetaEm?: number, origem: LimiteLido["origem"] = "assinatura"): LimiteLido => ({
  chave,
  tipo: "janela",
  uso,
  unidade: "%",
  ...(resetaEm === undefined ? {} : { resetaEm }),
  origem,
});

test("Codex: rate_limits primary e secondary viram 5h e semana, com reset por epoch ou por segundos", () => {
  const lidos = lerRateLimitsDoCodex(
    { primary: { used_percent: 42.5, window_minutes: 300, resets_in_seconds: 600 }, secondary: { used_percent: 10, window_minutes: 10080, resets_at: 1792645200 } },
    AGORA,
  );
  assert.deepEqual(lidos, [
    { chave: "5h", tipo: "janela", uso: 0.425, unidade: "%", resetaEm: Math.floor(AGORA / 1000) + 600, origem: "assinatura" },
    { chave: "semana", tipo: "janela", uso: 0.1, unidade: "%", resetaEm: 1792645200, origem: "assinatura" },
  ]);
});

test("Codex: o stream com rate_limits entrega o retrato, e sem ele não entrega nada nem erro", () => {
  const com = [
    '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2},"rate_limits":{"primary":{"used_percent":97,"window_minutes":300,"resets_in_seconds":120}}}',
  ].join("\n");
  const lido = readCodexEvents(com);
  assert.equal(lido.promptTokens, 5);
  assert.equal(lido.limites[0]?.chave, "5h");
  assert.ok(lido.limites[0]!.uso > 0.96);

  const sem = readCodexEvents('{"type":"turn.completed","usage":{"input_tokens":1}}\n{"type":"item.completed","item":{"type":"agent_message","text":"oi"}}');
  assert.deepEqual(sem.limites, []);
  assert.deepEqual(lerRateLimitsDoCodex("lixo"), []);
  assert.deepEqual(lerRateLimitsDoCodex({ primary: { used_percent: "muito" } }), []);
});

test("cabeçalhos de taxa da OpenAI e do gateway viram rpm e tpm; sem cabeçalho, nada", () => {
  const lidos = lerCabecalhosDeTaxa(
    {
      "X-RateLimit-Limit-Requests": "100",
      "x-ratelimit-remaining-requests": "20",
      "x-ratelimit-reset-requests": "1m30s",
      "x-ratelimit-limit-tokens": "10000",
      "x-ratelimit-remaining-tokens": "9000",
      "x-ratelimit-reset-tokens": "6s",
    },
    AGORA,
  );
  assert.deepEqual(lidos, [
    { chave: "rpm", tipo: "taxa", uso: 0.8, usado: 80, teto: 100, unidade: "req", resetaEm: Math.ceil(AGORA / 1000 + 90), origem: "cabecalho-api" },
    { chave: "tpm", tipo: "taxa", uso: 0.1, usado: 1000, teto: 10000, unidade: "tokens", resetaEm: Math.ceil(AGORA / 1000 + 6), origem: "cabecalho-api" },
  ]);
  assert.deepEqual(lerCabecalhosDeTaxa({ "content-type": "json" }, AGORA), []);
  assert.deepEqual(lerCabecalhosDeTaxa(undefined), []);
  assert.equal(duracaoEmSegundos("20ms"), 0.02);
  assert.equal(duracaoEmSegundos("lixo"), null);
});

test("cabeçalhos da Anthropic também valem", () => {
  const lidos = lerCabecalhosDeTaxa({ "anthropic-ratelimit-requests-limit": "50", "anthropic-ratelimit-requests-remaining": "50" }, AGORA);
  assert.equal(lidos[0]?.chave, "rpm");
  assert.equal(lidos[0]?.uso, 0);
});

test("o runtime nativo contra um gateway compatível: captura cabeçalho de taxa e gasto, e sem cabeçalho não erra", async () => {
  const comCabecalho = { value: true };
  const servidor = createServer((req, res) => {
    req.resume();
    const cab: Record<string, string> = { "content-type": "application/json" };
    if (comCabecalho.value) {
      cab["x-ratelimit-limit-requests"] = "10";
      cab["x-ratelimit-remaining-requests"] = "9";
      cab["x-ratelimit-reset-requests"] = "6s";
    }
    res.writeHead(200, cab);
    res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "oi" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }));
  });
  await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", r));
  const { port } = servidor.address() as AddressInfo;
  const vistos: { provedor: string; limites: LimiteLido[] }[] = [];
  const gastos: unknown[] = [];
  const parar = [aoLerLimites((provedor, limites) => vistos.push({ provedor, limites })), aoGastar((p, g) => gastos.push([p, g]))];
  try {
    const gateway = { available: () => true, requires: [], model: (id: string) => createOpenAICompatible({ name: "gw", apiKey: "k", baseURL: `http://127.0.0.1:${port}/v1` }).chatModel(id) };
    const runtime = new NativeRuntime({ gw: gateway }, { priceFor: async () => ({ provider: "gw", model: "m", inputUsdPerMtok: 1, outputUsdPerMtok: 2 }) } as never);
    const r = await runtime.run({ provider: "gw", model: "m", prompt: "oi", tools: {}, maxSteps: 1 });
    assert.equal(r.text, "oi");
    assert.equal(vistos.length, 1);
    assert.equal(vistos[0]!.provedor, "gw");
    assert.equal(vistos[0]!.limites[0]?.chave, "rpm");
    assert.equal(vistos[0]!.limites[0]?.uso, 0.1);
    assert.equal((gastos[0] as [string, { tokens: number }])[1].tokens, 10);

    comCabecalho.value = false;
    await runtime.run({ provider: "gw", model: "m", prompt: "oi", tools: {}, maxSteps: 1 });
    assert.equal(vistos.length, 1, "sem cabeçalho não há limite de taxa");
  } finally {
    parar.forEach((p) => p());
    servidor.close();
  }
});

test("o serviço guarda a leitura mais nova por provedor e chave, sem apagar as outras", async () => {
  const { s } = servico();
  await s.registrar("claude-code", [janela("5h", 0.5, 1792118400), janela("semana", 0.1, 1792645200)], AGORA);
  await s.registrar("claude-code", [janela("5h", 0.9, 1792118400)], AGORA + MINUTO);
  await s.registrar("codex", [janela("5h", 0.3, 1792118400)], AGORA);
  const todos = await s.listar(AGORA + MINUTO);
  const claude = todos.filter((l) => l.provedor === "claude-code");
  assert.deepEqual(claude.map((l) => [l.chave, l.uso]).sort(), [["5h", 0.9], ["semana", 0.1]]);
  assert.equal(claude[0]!.quando, Math.floor((AGORA + MINUTO) / 1000));
  assert.equal(todos.filter((l) => l.provedor === "codex").length, 1);
});

test("leitura cujo reset passou vale zero", async () => {
  const { s } = servico();
  const reset = Math.floor(AGORA / 1000) + 600;
  await s.registrar("claude-code", [janela("5h", 0.99, reset)], AGORA);
  assert.equal((await s.listar(AGORA))[0]!.uso, 0.99);
  const depois = (await s.listar(AGORA + 11 * MINUTO))[0]!;
  assert.equal(depois.uso, 0);
  assert.equal(depois.resetaEm, undefined);
});

test("orçamento local por dia e por mês, com virada de período", async () => {
  const { s, relogio } = servico();
  await s.definirOrcamento("anthropic", { diaUsd: 10, mesUsd: 100 });
  await s.gastar("anthropic", { usd: 4, tokens: 100 }, "2026-10-14");
  await s.gastar("anthropic", { usd: 3, tokens: 100 });
  await s.gastar("anthropic", { usd: 2, tokens: 100 });
  await s.gastar("openai", { usd: 99, tokens: 1 });

  const por = async () => Object.fromEntries((await s.doProvedor("anthropic", relogio.agora)).map((l) => [l.chave, l]));
  let l = await por();
  assert.equal(l.dia!.usado, 5);
  assert.equal(l.dia!.uso, 0.5);
  assert.equal(l.mes!.usado, 9);
  assert.equal(l.mes!.uso, 0.09);
  assert.equal(l.dia!.origem, "orcamento-local");
  assert.equal(l.dia!.resetaEm, Math.floor(new Date(2026, 9, 16).getTime() / 1000));
  assert.equal(l.mes!.resetaEm, Math.floor(new Date(2026, 10, 1).getTime() / 1000));

  // O dia vira: o do dia zera, o do mês continua.
  relogio.agora = new Date(2026, 9, 16, 0, 5).getTime();
  l = await por();
  assert.equal(l.dia!.usado, 0);
  assert.equal(l.mes!.usado, 9);
  // O mês vira.
  relogio.agora = new Date(2026, 10, 1, 0, 5).getTime();
  l = await por();
  assert.equal(l.mes!.usado, 0);

  await s.definirOrcamento("anthropic", {});
  assert.deepEqual(await s.doProvedor("anthropic", relogio.agora), []);
});

test("bloqueio: acima do limiar com reset futuro; abaixo, vencido, taxa ou proteção desligada não seguram", async () => {
  const { s } = servico();
  const reset = Math.floor(AGORA / 1000) + 3600;
  await s.registrar("claude-code", [janela("5h", 0.96, reset)], AGORA);
  assert.equal((await s.bloqueio("claude-code", AGORA))?.ate, reset * 1000);
  assert.equal(await s.bloqueio("claude-code", AGORA + 2 * 3600_000), null, "depois do reset libera");

  await s.registrar("claude-code", [janela("5h", 0.9, reset)], AGORA);
  assert.equal(await s.bloqueio("claude-code", AGORA), null);

  await s.registrar("gw", [{ chave: "rpm", tipo: "taxa", uso: 1, resetaEm: reset, origem: "cabecalho-api" }], AGORA);
  assert.equal(await s.bloqueio("gw", AGORA), null);

  await s.registrar("claude-code", [janela("5h", 1, reset)], AGORA);
  await s.gravarConfig({ protecao: false });
  assert.equal(await s.bloqueio("claude-code", AGORA), null);
  await s.gravarConfig({ protecao: true, limiarJanela: 0.5 });
  await s.registrar("claude-code", [janela("5h", 0.6, reset)], AGORA);
  assert.ok(await s.bloqueio("claude-code", AGORA), "limiar configurável");
});

test("orçamento estoura no teto, e janela sem reset conhecido não segura", async () => {
  const { s } = servico();
  await s.definirOrcamento("openai", { diaUsd: 5 });
  await s.gastar("openai", { usd: 4.9, tokens: 1 });
  assert.equal(await s.bloqueio("openai", AGORA), null);
  await s.gastar("openai", { usd: 0.1, tokens: 1 });
  assert.ok(await s.bloqueio("openai", AGORA));
  await s.registrar("codex", [janela("5h", 1)], AGORA);
  assert.equal(await s.bloqueio("codex", AGORA), null);
  assert.equal(estadoDoUso(0.5, 0.95), "ok");
  assert.equal(estadoDoUso(0.8, 0.95), "aviso");
  assert.equal(estadoDoUso(0.95, 0.95), "erro");
});

const SEM_FALLBACK: { fromModel: string; toModel: string; order: number }[] = [];
const todosDisponiveis = () => true;

test("proteção com substituto: troca o modelo e diz por quê; sem substituto, pausa; substituto também no limite, pausa", async () => {
  const { s } = servico();
  const reset = Math.floor(AGORA / 1000) + 3600;
  await s.registrar("claude-code", [janela("5h", 0.99, reset)], AGORA);

  const livre = await s.decidir("anthropic/x", { fallbacks: SEM_FALLBACK, disponivel: todosDisponiveis }, AGORA);
  assert.deepEqual(livre, { tipo: "livre", modelo: "anthropic/x" });

  const sem = await s.decidir("claude-code/sonnet", { fallbacks: SEM_FALLBACK, disponivel: todosDisponiveis }, AGORA);
  assert.equal(sem.tipo, "pausa");

  const cadeia = [{ fromModel: "claude-code/sonnet", toModel: "anthropic/claude-sonnet", order: 0 }];
  // Padrão: a troca está desligada, e a pausa diz por quê.
  const desligada = await s.decidir("claude-code/sonnet", { fallbacks: cadeia, disponivel: todosDisponiveis }, AGORA);
  assert.equal(desligada.tipo, "pausa");
  if (desligada.tipo === "pausa") assert.match(desligada.bloqueio.nota ?? "", /desligada/);
  // Ligada, mas o substituto não tem orçamento local: pausa e diz por quê.
  await s.gravarConfig({ usarSubstituto: true });
  const semOrcamento = await s.decidir("claude-code/sonnet", { fallbacks: cadeia, disponivel: todosDisponiveis }, AGORA);
  assert.equal(semOrcamento.tipo, "pausa");
  if (semOrcamento.tipo === "pausa") assert.match(semOrcamento.bloqueio.nota ?? "", /sem orçamento|não tem orçamento/);
  // Ligada e com orçamento: troca e diz por quê.
  await s.definirOrcamento("anthropic", { diaUsd: 5 });
  const com = await s.decidir("claude-code/sonnet", { fallbacks: cadeia, disponivel: todosDisponiveis }, AGORA);
  assert.equal(com.tipo, "substitui");
  if (com.tipo === "substitui") {
    assert.equal(com.modelo, "anthropic/claude-sonnet");
    assert.equal(com.motivo, "feito com anthropic/claude-sonnet por limite do claude-code");
  }

  await s.definirOrcamento("anthropic", { diaUsd: 1 });
  await s.gastar("anthropic", { usd: 2, tokens: 1 });
  const ambos = await s.decidir("claude-code/sonnet", { fallbacks: [{ fromModel: "claude-code/sonnet", toModel: "anthropic/claude-sonnet", order: 0 }], disponivel: todosDisponiveis }, AGORA);
  assert.equal(ambos.tipo, "pausa");
});

test("gateway LiteLLM: key/info vira orçamento com origem gateway, no máximo a cada 10 min; 404 e lixo são ignorados", async () => {
  let pedidos = 0;
  let autorizacao = "";
  const modo = { valor: "ok" as "ok" | "404" | "lixo" };
  const servidor = createServer((req, res) => {
    pedidos += 1;
    autorizacao = req.headers.authorization ?? "";
    if (req.url !== "/key/info" || modo.valor === "404") {
      res.writeHead(404).end();
    } else if (modo.valor === "lixo") {
      res.writeHead(200).end("não é json");
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ info: { spend: 42, max_budget: 100, budget_reset_at: "2026-11-01T00:00:00Z" } }));
    }
  });
  await new Promise<void>((r) => servidor.listen(0, "127.0.0.1", r));
  const { port } = servidor.address() as AddressInfo;
  try {
    const url = urlDoKeyInfo(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(url, `http://127.0.0.1:${port}/key/info`);
    const { s, relogio } = servico({ gateway: (p) => (p === "gw" ? { url, headers: { Authorization: "Bearer segredo-falso" } } : null) });

    assert.equal(await s.consultarGateway("gw"), false, "provedor não marcado como LiteLLM não recebe a pergunta");
    assert.equal(pedidos, 0);
    await s.gravarConfig({ gateways: ["gw"] });
    assert.equal(await s.consultarGateway("gw"), true);
    assert.equal(autorizacao, "Bearer segredo-falso");
    const [l] = await s.doProvedor("gw", AGORA);
    assert.equal(l!.origem, "gateway");
    assert.equal(l!.tipo, "orcamento");
    assert.equal(l!.uso, 0.42);
    assert.equal(l!.usado, 42);
    assert.equal(l!.teto, 100);
    assert.equal(l!.resetaEm, Date.parse("2026-11-01T00:00:00Z") / 1000);

    assert.equal(await s.consultarGateway("gw"), false, "dentro de 10 min não pergunta de novo");
    assert.equal(pedidos, 1);
    relogio.agora += INTERVALO_DO_GATEWAY_MS + 1;
    modo.valor = "404";
    assert.equal(await s.consultarGateway("gw"), false);
    relogio.agora += INTERVALO_DO_GATEWAY_MS + 1;
    modo.valor = "lixo";
    assert.equal(await s.consultarGateway("gw"), false);
    assert.equal(await s.consultarGateway("outro"), false);
    assert.equal(pedidos, 3);
  } finally {
    servidor.close();
  }
});

test("gateway fora do ar não levanta erro", async () => {
  const { s } = servico({ gateway: () => ({ url: "http://127.0.0.1:1/key/info", headers: {} }) });
  await s.gravarConfig({ gateways: ["gw"] });
  assert.equal(await s.consultarGateway("gw"), false);
});

// ---- agendador

function agendador(pausa: ConstructorParameters<typeof Scheduler>[11]) {
  const db = bancoDeTeste();
  const iniciados: (string | null)[] = [];
  const triggers = { enabled: async () => gatilhos, list: async () => gatilhos, get: async (id: string) => gatilhos.find((g) => g.id === id), pendencias: async () => [] } as unknown as TriggerService;
  const executions = {
    startForEvent: async (input: { eventId: string | null }) => {
      iniciados.push(input.eventId);
      return { runId: `run-${iniciados.length}` };
    },
  } as unknown as ExecutionService;
  const gatilhos: TriggerEntry[] = [
    { id: "g", agentId: "a", enabled: true, config: { kind: "poll", source: "github", owner: "org", repoMatch: ".", authorship: "any", includeDrafts: false, everyMinutes: 15 } as TriggerConfig },
  ];
  const poll = async () => {
    await db.insert(schema.events).values({ id: "e1", source: "github", externalId: "pr-1", payload: {} }).onConflictDoNothing();
    return { eventIds: ["e1"], created: ["e1"] };
  };
  const scheduler = new Scheduler(
    db, triggers, executions, {} as McpService, {} as SlackService, poll as never,
    (async () => ({ checked: 0, settled: [], stillOpen: 0, unreadable: 0, failed: [] })) as never,
    async () => "eu", undefined, undefined, undefined, pausa,
  );
  return { scheduler, iniciados, gatilhos };
}

test("gatilho automático com o provedor no limite não dispara, guarda o evento e roda depois do reset", async () => {
  const T0 = Date.UTC(2026, 9, 2, 3, 0, 0);
  const reset = T0 + 60 * MINUTO;
  const { scheduler, iniciados } = agendador(async (_agent, at) => (at < reset ? { provedor: "claude-code", ate: reset, limite: {} as never } : null));

  const preso = await scheduler.tick({ at: T0 });
  assert.deepEqual(iniciados, []);
  assert.match(preso.outcomes[0]!.detail ?? "", /automações em pausa até .*\d\d:\d\d \(limite do claude-code\), 1 evento\(s\) guardado\(s\)/);

  // Dias depois, ainda no limite: o evento não envelhece até sumir do retry de 24h.
  await scheduler.tick({ at: T0 + 20 * MINUTO });
  assert.deepEqual(iniciados, []);

  const solto = await scheduler.tick({ at: reset + 20 * MINUTO });
  assert.deepEqual(iniciados, ["e1"]);
  assert.equal(solto.outcomes[0]!.runs.length, 1);
});

test("gatilho de relógio no limite não toma a batida e dispara na primeira depois do reset", async () => {
  const T0 = Date.UTC(2026, 9, 2, 3, 0, 0);
  const reset = T0 + 60 * MINUTO;
  const db = bancoDeTeste();
  const iniciados: unknown[] = [];
  const gatilhos: TriggerEntry[] = [{ id: "g", agentId: "a", enabled: true, config: { kind: "schedule", everyMinutes: 30 } as TriggerConfig }];
  const scheduler = new Scheduler(
    db, { enabled: async () => gatilhos, list: async () => gatilhos, get: async (id: string) => gatilhos.find((g) => g.id === id), pendencias: async () => [] } as unknown as TriggerService,
    { startForEvent: async () => (iniciados.push(1), { runId: "r" }) } as unknown as ExecutionService,
    {} as McpService, {} as SlackService, undefined, (async () => ({ checked: 0, settled: [], stillOpen: 0, unreadable: 0, failed: [] })) as never,
    undefined, undefined, undefined, undefined,
    async (_a, at) => (at < reset ? { provedor: "claude-code", ate: reset, limite: {} as never } : null),
  );
  const preso = await scheduler.tick({ at: T0 });
  assert.equal(preso.outcomes[0]!.status, "waiting");
  assert.equal(preso.outcomes[0]!.nextDueAt, reset);
  assert.equal(iniciados.length, 0);
  const solto = await scheduler.tick({ at: reset + MINUTO });
  assert.equal(solto.outcomes[0]!.status, "fired");
  assert.equal(iniciados.length, 1);
});

test("a pausa do agent olha o modelo de cada passo e respeita o substituto", async () => {
  const { s } = servico();
  const reset = Math.floor(AGORA / 1000) + 3600;
  await s.registrar("claude-code", [janela("5h", 1, reset)], AGORA);
  const versao = { spec: { steps: [{ type: "model", key: "a", model: "claude-code/sonnet" }, { type: "action", key: "b" }] } } as never;
  const base = { limites: s, versao: async () => versao, disponivel: todosDisponiveis };
  assert.equal((await pausaDoAgent("x", { ...base, fallbacks: async () => [] }, AGORA))?.provedor, "claude-code");
  await s.gravarConfig({ usarSubstituto: true });
  await s.definirOrcamento("anthropic", { diaUsd: 5 });
  assert.equal(await pausaDoAgent("x", { ...base, fallbacks: async () => [{ fromModel: "claude-code/sonnet", toModel: "anthropic/s", order: 0 }] }, AGORA), null);
  assert.equal(await pausaDoAgent("x", { ...base, versao: async () => undefined, fallbacks: async () => [] }, AGORA), null);
});

test("execução manual roda mesmo com o provedor do agent estourado, e avisa até quando", async () => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
  const { limitesService } = await import("../src/services/limites-service.js");
  const { AgentService } = await import("../src/services/agent-service.js");
  const { TriggerService } = await import("../src/services/trigger-service.js");
  const { AgentSpec } = await import("../src/config/types.js");
  // O banco do processo: a pausa lê o agent pelo serviço de verdade.
  const iniciados: unknown[] = [];
  const executions = { startForEvent: async (i: unknown) => (iniciados.push(i), { runId: "r1", status: "queued" }) } as unknown as ExecutionService;
  const agents = new AgentService();
  await agents.upsert(AgentSpec.parse({ id: "manual-no-limite", name: "M", steps: [{ type: "model", key: "t", name: "t", model: "ollama/x", prompt: "oi" }] }), undefined, "human");
  const reset = Math.floor(Date.now() / 1000) + 3600;
  await limitesService.registrar("ollama", [janela("5h", 1, reset)]);
  try {
    assert.ok(await limitesService.bloqueio("ollama"), "o limite está mesmo estourado");
    const r = await new AutomationService(agents, new TriggerService(), executions).runNow("manual-no-limite");
    assert.equal(r.runId, "r1");
    assert.equal(iniciados.length, 1, "o manual roda");
    assert.equal(r.aviso?.provedor, "ollama");
    assert.equal(r.aviso?.ate, reset * 1000);
  } finally {
    await limitesService.esquecer("ollama");
  }
});

test("o runtime do Claude Code publica a leitura do stream, e a do filtro com IA espera o reset em vez de falhar", async () => {
  const { mkdtempSync, writeFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ClaudeCodeRuntime } = await import("../src/runtimes/claude-code.js");
  const { criarJulgador, ErroDeLimiteDoFiltro } = await import("../src/services/filtro-ia.js");
  const pasta = mkdtempSync(join(tmpdir(), "locum-claude-"));
  const falso = join(pasta, "claude");
  const linha = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.89,"resetsAt":1792118400},"seven_day":{"utilization":0.15,"resetsAt":1792645200}}}}';
  writeFileSync(falso, `#!/bin/sh\necho '${linha}'\necho '{"type":"result","result":"ok"}'\n`);
  chmodSync(falso, 0o755);
  const vistos: LimiteLido[][] = [];
  const parar = aoLerLimites((_p, l) => vistos.push(l));
  try {
    await new ClaudeCodeRuntime(new Map(), async () => falso).run({ prompt: "ok", model: "haiku", tools: {}, maxSteps: 1 } as never);
  } finally {
    parar();
  }
  assert.deepEqual(vistos[0]!.map((l) => [l.chave, l.uso]), [["5h", 0.89], ["semana", 0.15]]);

  const julgar = criarJulgador({
    disponivel: () => true,
    resolver: async (m) => m,
    runtime: () => {
      throw new Error("não devia chamar o modelo");
    },
    limite: async () => ({ ate: AGORA + MINUTO, provedor: "claude-code" }),
  });
  await assert.rejects(() => julgar({ filtro: { modelo: "claude-code/haiku" } as never, mensagem: { texto: "oi" } as never }), ErroDeLimiteDoFiltro);
});

function agendadorComEventos(quantos: number, pausa: ConstructorParameters<typeof Scheduler>[11], reavaliar: ConstructorParameters<typeof Scheduler>[12]) {
  const db = bancoDeTeste();
  const iniciados: (string | null)[] = [];
  const gatilhos: TriggerEntry[] = [
    { id: "g", agentId: "a", enabled: true, config: { kind: "poll", source: "github", owner: "org", repoMatch: ".", authorship: "any", includeDrafts: false, everyMinutes: 15 } as TriggerConfig },
  ];
  const ids = Array.from({ length: quantos }, (_, i) => `e${String(i).padStart(3, "0")}`);
  let primeira = true;
  // A janela da varredura só traz os eventos na primeira batida: depois deles, o que vale é a lista guardada.
  const poll = async () => {
    if (!primeira) return { eventIds: [], created: [] };
    primeira = false;
    for (const id of ids) await db.insert(schema.events).values({ id, source: "github", externalId: id, payload: {} });
    return { eventIds: ids, created: ids };
  };
  const scheduler = new Scheduler(
    db,
    { enabled: async () => gatilhos, list: async () => gatilhos, get: async (id: string) => gatilhos.find((g) => g.id === id), pendencias: async () => [] } as unknown as TriggerService,
    { startForEvent: async (i: { eventId: string | null }) => (iniciados.push(i.eventId), { runId: `r${iniciados.length}` }) } as unknown as ExecutionService,
    {} as McpService, {} as SlackService, poll as never,
    (async () => ({ checked: 0, settled: [], stillOpen: 0, unreadable: 0, failed: [] })) as never,
    async () => "eu", undefined, undefined, undefined, pausa, reavaliar,
  );
  return { db, scheduler, iniciados };
}

test("pausa de 5 dias com 40 eventos: nada se perde, o fechado sai, e o resto solta em lotes do mais velho", async () => {
  const T0 = Date.UTC(2026, 9, 2, 3, 0, 0);
  const DIA = 24 * 60 * MINUTO;
  const reset = T0 + 5 * DIA;
  const { scheduler, iniciados } = agendadorComEventos(
    40,
    async (_a, at) => (at < reset ? { provedor: "claude-code", ate: reset, limite: {} as never } : null),
    async (id) => (Number(id.slice(1)) % 10 === 0 ? "fechado" : null),
  );

  await scheduler.tick({ at: T0 });
  for (let d = 1; d < 5; d++) await scheduler.tick({ at: T0 + d * DIA });
  assert.deepEqual(iniciados, [], "a pausa longa não abre run nem deixa o evento envelhecer até sumir");

  const primeiro = await scheduler.tick({ at: reset + MINUTO });
  assert.deepEqual(iniciados, ["e001", "e002", "e003", "e004", "e005"], "o lote de cinco, do mais velho, sem o fechado");
  assert.match(primeiro.outcomes[0]!.detail ?? "", /depois da pausa: 5 run\(s\) aberto\(s\)/);

  for (let i = 1; i <= 10; i++) await scheduler.tick({ at: reset + MINUTO + i * 20 * MINUTO });
  const esperados = Array.from({ length: 40 }, (_, i) => `e${String(i).padStart(3, "0")}`).filter((id) => Number(id.slice(1)) % 10 !== 0);
  assert.deepEqual(iniciados, esperados, "36 eventos rodaram, cada um uma vez, em ordem; os 4 fechados foram descartados");
});

test("a lista de espera do limite tem teto, e o mais velho sai com descarte registrado", async () => {
  const T0 = Date.UTC(2026, 9, 2, 3, 0, 0);
  const { db, scheduler } = agendadorComEventos(210, async () => ({ provedor: "claude-code", ate: T0 + 9e9, limite: {} as never }), async () => null);
  await scheduler.tick({ at: T0 });
  const [linha] = await db.select().from(schema.cursors).where(eq(schema.cursors.source, "scheduler-retry"));
  const guardados = JSON.parse(linha!.value) as { eventId: string }[];
  assert.equal(guardados.length, 200);
  assert.equal(guardados[0]!.eventId, "e010", "saíram os dez mais velhos");
  const { lerDescartes } = await import("../src/triggers/descartes.js");
  assert.equal((await lerDescartes(db, "g")).length, 10);
});

test("dois processos sobre o mesmo banco registram ao mesmo tempo sem apagar um ao outro", async () => {
  const db = bancoDeTeste();
  const app = new LimitesService({ db, settings: new SettingsService(db), agora: () => AGORA });
  const mcp = new LimitesService({ db, settings: new SettingsService(db), agora: () => AGORA });
  await Promise.all([
    app.registrar("claude-code", [janela("5h", 0.5, 1792118400)]),
    mcp.registrar("codex", [janela("5h", 0.4, 1792118400)]),
    app.registrar("claude-code", [janela("semana", 0.1, 1792645200)]),
    mcp.registrar("openai", [{ chave: "rpm", tipo: "taxa", uso: 0.1, origem: "cabecalho-api" }]),
  ]);
  const todos = await app.listar(AGORA);
  assert.deepEqual(todos.map((l) => `${l.provedor}:${l.chave}`).sort(), ["claude-code:5h", "claude-code:semana", "codex:5h", "openai:rpm"]);
});

test("remover a chave do provedor leva o orçamento, o limiar e a leitura dele", async () => {
  const { s } = servico();
  await s.definirOrcamento("anthropic", { diaUsd: 5 });
  await s.gravarConfig({ limiares: { anthropic: { orcamento: 0.8 }, openai: { orcamento: 0.9 } }, gateways: ["anthropic"] });
  await s.registrar("anthropic", [{ chave: "rpm", tipo: "taxa", uso: 0.1, origem: "cabecalho-api" }], AGORA);
  await s.esquecer("anthropic");
  assert.deepEqual(await s.doProvedor("anthropic", AGORA), []);
  const c = await s.config();
  assert.deepEqual(c.limiares, { openai: { orcamento: 0.9 } });
  assert.deepEqual(c.gateways, []);
});

test("limiar zero ou fora da faixa é recusado em vez de gravado, e o limiar de um provedor não apaga o dos outros", async () => {
  const { s } = servico();
  await assert.rejects(() => s.gravarConfig({ limiarJanela: 0 }), /entre 1% e 100%/);
  await assert.rejects(() => s.gravarConfig({ limiares: { x: { orcamento: 0 } } }), /limiar do orçamento de x/);
  await s.gravarConfig({ limiares: { a: { janela: 0.9 } } });
  await s.gravarConfig({ limiares: { b: { orcamento: 1.2 } } });
  assert.deepEqual((await s.config()).limiares, { a: { janela: 0.9 }, b: { orcamento: 1.2 } });
  await s.gravarConfig({ limiares: { a: {} } });
  assert.deepEqual((await s.config()).limiares, { b: { orcamento: 1.2 } });
});

test("toda entrada de processo liga a contagem de limite e gasto", async () => {
  migrateDb();
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const raiz = join(import.meta.dirname, "..");
  for (const arquivo of ["electron/bridge.ts", "electron/main.ts", "src/cli.ts", "src/mcp-server/index.ts"]) {
    assert.match(await readFile(join(raiz, arquivo), "utf8"), /ligarLimites\(\)/, arquivo);
  }
  // E o gasto publicado entra mesmo no banco do processo.
  const { ligarLimites } = await import("../src/services/limites-padrao.js");
  const { limitesService } = await import("../src/services/limites-service.js");
  const { contarGastoDoProvedor } = await import("../src/runtimes/limites-lidos.js");
  const parar = ligarLimites();
  try {
    await limitesService.definirOrcamento("provedor-do-teste", { diaUsd: 10 });
    contarGastoDoProvedor("provedor-do-teste", { usd: 2.5, tokens: 10 });
    contarGastoDoProvedor("provedor-do-teste", { usd: 99, tokens: 10, billable: false });
    await new Promise((r) => setTimeout(r, 100));
    const [dia] = await limitesService.doProvedor("provedor-do-teste");
    assert.equal(dia?.usado, 2.5);
  } finally {
    parar();
    await limitesService.esquecer("provedor-do-teste");
  }
});

test("pelo cliente MCP: refresh, orçamento e configuração, com as anotações certas", async () => {
  migrateDb();
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { buildMcpServer } = await import("../src/mcp-server/server.js");
  const { limitesService } = await import("../src/services/limites-service.js");
  const [c, sv] = InMemoryTransport.createLinkedPair();
  await buildMcpServer().connect(sv);
  const client = new Client({ name: "teste", version: "0" });
  await client.connect(c);
  const json = (r: Awaited<ReturnType<typeof client.callTool>>) => JSON.parse((r.content as { text: string }[])[0]!.text);
  try {
    const { tools } = await client.listTools();
    const nota = (n: string) => tools.find((t) => t.name === n)?.annotations;
    assert.equal(nota("get_provider_limits")?.readOnlyHint, true);
    assert.equal(nota("refresh_provider_limits")?.readOnlyHint, false);
    assert.equal(nota("refresh_provider_limits")?.openWorldHint, true);
    assert.equal(nota("set_provider_budget")?.openWorldHint, false);
    assert.equal(nota("set_limits_config")?.readOnlyHint, false);

    const orc = json(await client.callTool({ name: "set_provider_budget", arguments: { provider: "anthropic", dayUsd: 7, monthUsd: 70 } }));
    assert.deepEqual(orc.provedores.find((p: { provedor: string }) => p.provedor === "anthropic").orcamento, { diaUsd: 7, mesUsd: 70 });

    const cfg = json(await client.callTool({ name: "set_limits_config", arguments: { pauseNearLimit: false, windowThreshold: 0.9, useFallbackModel: true, providerThresholds: { anthropic: { budget: 0.8 } } } }));
    assert.equal(cfg.protecao, false);
    assert.equal(cfg.limiarJanela, 0.9);
    assert.equal(cfg.usarSubstituto, true);
    const zero = await client.callTool({ name: "set_limits_config", arguments: { windowThreshold: 0 } });
    assert.equal(zero.isError, true);

    // Provedor sem fonte para perguntar: não chama, e responde com a leitura que há.
    const ref = json(await client.callTool({ name: "refresh_provider_limits", arguments: { provider: "anthropic" } }));
    assert.equal(ref.chamou, false);
    assert.equal(ref.provedor.provedor, "anthropic");
    assert.equal(json(await client.callTool({ name: "get_provider_limits", arguments: {} })).usarSubstituto, true);
  } finally {
    await limitesService.esquecer("anthropic");
    await limitesService.gravarConfig({ protecao: true, limiarJanela: 0.95, usarSubstituto: false });
    await client.close();
  }
});
