import { before, test } from "node:test";
import assert from "node:assert/strict";
import type { AgentProfileInput, TriggerConfigInput } from "../src/config/types.js";
import { migrateDb } from "../src/db/migrate.js";
import { acoesRegistradas, idaEVolta, kindsDeGatilho, type Fluxo } from "./helpers/ida-e-volta.js";

/**
 * Ida e volta do pacote: o que sai de uma máquina e entra noutra volta igual, menos o que é
 * local (pela marcação e pela declaração das ações), e isso fica a preencher em `pendentes`.
 */

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

const base = { needs: [] as string[], optional: false };

/** Um fluxo mínimo, para o gatilho ser o que se prova. */
const fluxoDoGatilho = (gatilhos: TriggerConfigInput[]): Fluxo => ({
  spec: {
    id: "so-gatilho",
    name: "Só o gatilho",
    steps: [{ ...base, type: "model", key: "ler", name: "Ler", prompt: "olhe o evento", model: "claude-code/claude-sonnet-5" }],
  },
  gatilhos,
});

/**
 * Um gatilho de cada kind, com nomes genéricos. Cada config é distinta das outras do mesmo kind:
 * o cadastro deduplica config idêntica, e um fixture repetido sumiria da comparação.
 */
const GATILHOS: Record<string, TriggerConfigInput[]> = {
  schedule: [{ kind: "schedule", everyMinutes: 30, workingHours: { enabled: true, start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5], offHoursBehavior: "pause", slowCadenceMinutes: 60 } }],
  webhook: [{ kind: "webhook", path: "/hook/revisao-exemplo" }],
  cron: [{ kind: "cron", expression: "0 9 * * 1-5" }],
  manual: [{ kind: "manual" }],
  "slack-inbox": [{ kind: "slack-inbox", mentions: true, dms: false, everyMinutes: 7 }],
  "slack-channel": [{ kind: "slack-channel", channels: ["C0123ABCD45"], everyMinutes: 5 }],
  "teams-inbox": [
    { kind: "teams-inbox", mentions: true, dms: false, prLinks: true, agruparPrs: true, maxPrs: 3, filtroIa: { pergunta: "É um pedido de review de pull request?" }, channels: [{ teamId: "3f2c1a9e-1b2d-4c3e-8f4a-5b6c7d8e9f01", channelId: "19:0123456789abcdef0123456789abcdef@thread.tacv2", label: "Equipe exemplo" }], chats: [{ chatId: "19:abcdef0123456789abcdef0123456789@thread.v2", label: "Chat exemplo" }], everyMinutes: 5 },
    { kind: "teams-inbox", mentions: false, dms: true, prLinks: false, agruparPrs: false, maxPrs: 5, channels: [], chats: [], everyMinutes: 10 },
  ],
  poll: [
    { kind: "poll", source: "github", owner: "empresa-exemplo", repoMatch: "servico-.*", authorship: "others", includeDrafts: false, filters: { authors: { include: ["ana-exemplo"] }, reviewRequested: { users: ["bruno-exemplo"] }, teamMembers: ["empresa-exemplo/pagamentos"], labels: { include: ["revisar"], exclude: [] }, baseBranches: ["main"], paths: { include: ["src/**"] }, maxChangedLines: 800 }, everyMinutes: 15 },
    { kind: "poll", source: "github", repoMatch: "biblioteca-.*", authorship: "mine", includeDrafts: true, everyMinutes: 20 },
  ],
  "mcp-poll": [{ kind: "mcp-poll", server: "feed", tool: "listar", args: { consulta: "{{event.termo}}", limite: 5 }, everyMinutes: 15 }],
} as never;

test("todo kind de gatilho do registro tem fixture, e só os dele", () => {
  assert.deepEqual(Object.keys(GATILHOS).sort(), kindsDeGatilho().sort());
});

for (const kind of kindsDeGatilho()) {
  test(`gatilho ${kind}: ida e volta`, async () => {
    const configs = GATILHOS[kind];
    assert.ok(configs !== undefined && configs.length > 0, `falta fixture de gatilho para ${kind}`);
    await idaEVolta(fluxoDoGatilho(configs));
  });
}

test("gatilho sem canal não é criado, e a pendência fica no lugar dele", async () => {
  const v = await idaEVolta(fluxoDoGatilho(GATILHOS["slack-channel"]!));
  assert.equal(v.gatilhos.length, 0);
  assert.ok(v.pendentes.some((p) => p.onde.startsWith("gatilho:") && p.campo === "channels"));
});

test("dois gatilhos do mesmo kind têm pendências separadas, cada uma no id do seu", async () => {
  const v = await idaEVolta(fluxoDoGatilho([
    ...GATILHOS.poll!,
    { kind: "poll", source: "github", owner: "outra-empresa", repoMatch: "api-.*", authorship: "any", includeDrafts: false, everyMinutes: 30 },
  ]));
  const donos = v.pendentes.filter((p) => p.campo === "owner").map((p) => p.onde);
  assert.equal(new Set(donos).size, 2);
  for (const onde of donos) assert.ok(v.gatilhos.some((g) => onde === `gatilho:${g.id}`));
});

/* ------------------------------------------------------------------- ações */

const passoDeIA = { ...base, type: "model", key: "revisar", name: "Revisar", model: "claude-code/claude-sonnet-5", prompt: "Revise o PR {{event.prNumber}} de {{event.prRepo}}.", profile: "revisor-exemplo", maxSteps: 8 };

/** O agent da biblioteca: conexões com mapa de ferramentas, toolset e skills. */
const REVISOR: AgentProfileInput = {
  id: "revisor-exemplo",
  name: "Revisor de exemplo",
  description: "Revisa pull requests",
  context: "Time de pagamentos de uma empresa de exemplo.",
  instructions: "Leia o diff, aponte o que quebra e proponha a correção.",
  model: "claude-code/claude-sonnet-5",
  temperature: 0.2,
  toolsets: ["leitura-basica"],
  tools: [{ server: "ms365", tool: "buscar", class: "read" as const }],
  connections: [
    { connectionId: "github", tools: { get_pull_request: true, list_commits: "read", create_issue: false }, leituraPadrao: "limitada", linhaDeBase: "feita" },
    { connectionId: "ms365", tools: {} },
  ],
  skills: [{ skill: "estilo-de-codigo", when: { filesMatch: ["src/**"] } }, "boas-praticas"],
  maxSteps: 10,
};
const TOOLSET = { id: "leitura-basica", name: "Leitura básica", description: "O que só lê", tools: [{ server: "ms365", tool: "listar", class: "read" as const }, { server: "ms365", tool: "ler", class: "read" as const }] };
const SKILLS = {
  "estilo-de-codigo": { descricao: "Estilo do time", corpo: "Prefira nomes claros.\nUm teste por comportamento." },
  "boas-praticas": { descricao: "Boas práticas", corpo: "Mudança pequena, com teste." },
};

const FLUXOS: Record<string, Fluxo> = {
  "review de PR via teams-inbox": {
    spec: {
      id: "review-teams",
      name: "Review do Teams",
      skills: [{ skill: "estilo-de-codigo", when: { always: true } }],
      steps: [
        { ...base, type: "action", key: "pegou", name: "Pegou", action: "teams.react", mode: "auto", params: { emoji: "👀", operacao: "set" } },
        {
          ...passoDeIA,
          outputSchema: { type: "object", properties: { verdict: { type: "string", enum: ["APPROVE", "COMMENT", "REQUEST_CHANGES"] }, summary: { type: "string" } }, required: ["verdict"] },
        },
        { ...base, type: "action", key: "publicar", name: "Publicar", needs: ["revisar"], action: "github.review_comment", mode: "approve", input: "revisar", params: { owner: "{{event.prOwner}}", repo: "{{event.prRepo}}", pull: "{{event.prNumber}}" } },
        { ...base, type: "action", key: "responder", name: "Responder", needs: ["revisar"], action: "teams.post", mode: "approve", input: "revisar", params: { destino: { tipo: "evento" } } },
        { ...base, type: "action", key: "veredito", name: "Veredito", needs: ["revisar"], action: "teams.react", mode: "approve", params: { operacao: "set", tirar: "👀", porValor: { de: "{{steps.revisar.verdict}}", mapa: { APPROVE: "✅", REQUEST_CHANGES: "⚠️" }, padrao: "💬" } } },
      ],
    },
    gatilhos: [{ kind: "teams-inbox", mentions: false, dms: false, prLinks: true, agruparPrs: false, maxPrs: 5, channels: [], chats: [], everyMinutes: 5 }],
    agents: [REVISOR],
    toolsets: [TOOLSET],
    skills: SKILLS,
  },
  "Slack com destino fixo e reação": {
    spec: {
      id: "aviso-slack",
      name: "Aviso no Slack",
      steps: [
        { ...passoDeIA, key: "resumir", name: "Resumir", profile: undefined, prompt: "Resuma a mensagem.", requiresServers: [] },
        { ...base, type: "action", key: "avisar", name: "Avisar", needs: ["resumir"], action: "slack.post", mode: "approve", input: "resumir", params: { destino: { tipo: "fixo", conversa: { app: "slack", ref: "canal/C0123ABCD45", rotulo: "Canal do time" } } } },
        { ...base, type: "action", key: "marcar", name: "Marcar", needs: ["resumir"], action: "slack.react", mode: "auto", params: { emoji: "white_check_mark", operacao: "set", destino: { tipo: "evento" } } },
      ],
    },
    gatilhos: [{ kind: "slack-inbox", mentions: true, dms: true, everyMinutes: 5 }],
  },
  "mcp.call e http.request": {
    spec: {
      id: "chamadas",
      name: "Chamadas",
      steps: [
        { ...passoDeIA, key: "preparar", name: "Preparar", profile: undefined, prompt: "Prepare o chamado.", requiresServers: [] },
        { ...base, type: "action", key: "chamar", name: "Chamar", needs: ["preparar"], action: "mcp.call", mode: "approve", params: { server: "ms365", tool: "enviar", args: { texto: "{{steps.preparar.resumo}}", prioridade: 2, titulo: "Revisão pronta" } } },
        { ...base, type: "action", key: "avisarapi", name: "Avisar a API", needs: ["preparar"], action: "http.request", mode: "approve", params: { method: "POST", url: "https://api.exemplo.com/v1/avisos", headers: { "X-Origem": "locum" }, body: "{\"status\":\"revisado\"}" } },
      ],
    },
  },
  "tarefa, digest e contexto": {
    spec: {
      id: "rotinas",
      name: "Rotinas",
      steps: [
        { ...passoDeIA, key: "analisar", name: "Analisar", profile: undefined, prompt: "Analise o que mudou.", requiresServers: [] },
        { ...base, type: "action", key: "tarefa", name: "Tarefa", needs: ["analisar"], action: "tracker.create_issue", mode: "approve", input: "analisar", target: "tracker-exemplo" },
        { ...base, type: "action", key: "entrega", name: "Entrega", needs: ["analisar"], action: "digest.deliver", mode: "approve", input: "analisar" },
        { ...base, type: "action", key: "contexto", name: "Contexto", needs: ["analisar"], action: "context.update", mode: "approve", input: "analisar" },
        { ...base, type: "action", key: "literal", name: "Review com dono fixo", needs: ["analisar"], action: "github.review_comment", mode: "approve", input: "analisar", params: { owner: "empresa-exemplo", repo: "servico-exemplo", pull: 12 } },
      ],
    },
    gatilhos: [{ kind: "cron", expression: "0 8 * * 1" }],
  },
};

test("toda ação registrada tem fixture, e só as registradas", () => {
  const usadas = new Set(Object.values(FLUXOS).flatMap((f) => (f.spec as { steps: { type: string; action?: string }[] }).steps.flatMap((p) => (p.type === "action" ? [p.action!] : []))));
  assert.deepEqual([...usadas].sort(), acoesRegistradas().map((a) => a.kind).sort());
});

for (const [nome, fluxo] of Object.entries(FLUXOS)) {
  test(`fluxo ${nome}: ida e volta`, async () => {
    await idaEVolta(fluxo);
  });
}

const pendencias = (v: { pendentes: { onde: string; campo: string; motivo: string }[] }, onde: string): string[] =>
  v.pendentes.filter((p) => p.onde === onde).map((p) => `${p.campo}:${p.motivo}`).sort();

test("o que cada ação deixa a preencher, com o motivo", async () => {
  const slack = await idaEVolta(FLUXOS["Slack com destino fixo e reação"]!);
  assert.deepEqual(pendencias(slack, "avisar"), ["params.destino:destino-a-escolher"]);
  assert.deepEqual(pendencias(slack, "marcar"), []);

  const chamadas = await idaEVolta(FLUXOS["mcp.call e http.request"]!);
  assert.deepEqual(pendencias(chamadas, "avisarapi"), ["params.headers:argumentos", "params.url:url-a-preencher"]);
  assert.deepEqual(pendencias(chamadas, "chamar"), []);

  const rotinas = await idaEVolta(FLUXOS["tarefa, digest e contexto"]!);
  assert.deepEqual(pendencias(rotinas, "tarefa"), ["target:tracker"]);
  assert.deepEqual(pendencias(rotinas, "literal"), ["params.owner:argumentos", "params.pull:argumentos", "params.repo:argumentos"]);
  assert.deepEqual(pendencias(rotinas, "entrega"), []);
  assert.deepEqual(pendencias(rotinas, "contexto"), []);
});

test("review do Teams: nada a preencher, e a reação em auto entra em aprovação", async () => {
  const v = await idaEVolta(FLUXOS["review de PR via teams-inbox"]!);
  assert.deepEqual(v.pendentes, []);
  const pegou = v.importada.steps.find((p) => p.key === "pegou");
  assert.equal(pegou?.type === "action" && pegou.mode, "approve");
});
