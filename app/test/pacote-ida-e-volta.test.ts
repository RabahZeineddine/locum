import { before, test } from "node:test";
import assert from "node:assert/strict";
import type { TriggerConfigInput } from "../src/config/types.js";
import { migrateDb } from "../src/db/migrate.js";
import { idaEVolta, kindsDeGatilho, type Fluxo } from "./helpers/ida-e-volta.js";

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
