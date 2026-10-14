import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { McpRegistry } from "../src/mcp/registry.js";
import { mcpService } from "../src/services/mcp-service.js";
import { githubReviewHandler, type ReviewClient } from "../src/sources/github.js";

const ALVO = { owner: "dono", repo: "repositorio", pull: 42, findings: [] };

const cliente = {
  rest: { pulls: { createReview: async () => ({}), listReviews: async () => ({ data: [] }) } },
} as unknown as ReviewClient;

const original = {
  enabledConfigs: mcpService.enabledConfigs,
  fromList: McpRegistry.fromList,
};
afterEach(() => {
  mcpService.enabledConfigs = original.enabledConfigs;
  McpRegistry.fromList = original.fromList;
});

/** Troca o Slack por um que só anota as chamadas. `ativo` liga o servidor "slack". */
function slackFalso(ativo = true) {
  const chamadas: { tool: string; args: Record<string, unknown> }[] = [];
  mcpService.enabledConfigs = (async () => (ativo ? [{ name: "slack" }] : [])) as never;
  McpRegistry.fromList = (() => ({
    callTool: async (_server: string, tool: string, args: Record<string, unknown>) => {
      chamadas.push({ tool, args });
      return {};
    },
    closeAll: async () => undefined,
  })) as never;
  return chamadas;
}

test("review de mensagem do Slack tira eyes e põe a reação do veredito", async () => {
  const esperado = { APPROVE: "white_check_mark", REQUEST_CHANGES: "warning", COMMENT: "speech_balloon" } as const;
  for (const [verdict, emoji] of Object.entries(esperado)) {
    const chamadas = slackFalso();
    await githubReviewHandler(() => cliente).publish(
      { ...ALVO, verdict, slackChannel: "C1", slackTs: "1700.01" },
      `ext-${verdict}`,
    );
    assert.deepEqual(chamadas, [
      { tool: "slack_remove_reaction", args: { channel_id: "C1", timestamp: "1700.01", name: "eyes" } },
      { tool: "slack_add_reaction", args: { channel_id: "C1", timestamp: "1700.01", name: emoji } },
    ]);
  }
});

test("o Slack também vale pelo canal e ts do evento, e sem veredito é comentário", async () => {
  const chamadas = slackFalso();
  await githubReviewHandler(() => cliente).publish({ ...ALVO, channel: "C2", ts: "1700.02" }, "ext-a");
  assert.equal(chamadas[1]?.args.name, "speech_balloon");
  assert.equal(chamadas[1]?.args.channel_id, "C2");
});

test("sem servidor Slack cadastrado, ou sem canal, nada é chamado e o review sai", async () => {
  const semServidor = slackFalso(false);
  await githubReviewHandler(() => cliente).publish({ ...ALVO, slackChannel: "C1", slackTs: "1" }, "ext-b");
  assert.deepEqual(semServidor, []);

  const semCanal = slackFalso();
  await githubReviewHandler(() => cliente).publish({ ...ALVO, verdict: "APPROVE" }, "ext-c");
  assert.deepEqual(semCanal, []);
});

test("erro do Slack na reação não impede o review", async () => {
  mcpService.enabledConfigs = (async () => {
    throw new Error("slack fora");
  }) as never;
  await githubReviewHandler(() => cliente).publish({ ...ALVO, slackChannel: "C1", slackTs: "1" }, "ext-d");
});
