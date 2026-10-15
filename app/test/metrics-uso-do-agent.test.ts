import { test } from "node:test";
import assert from "node:assert/strict";
import * as schema from "../src/db/schema.js";
import { MetricsService } from "../src/services/metrics-service.js";
import { bancoDeTeste } from "./helpers/db.js";

test("o gasto de agent da biblioteca vem marcado, para ninguém somar em dobro com o da automação", async () => {
  const banco = bancoDeTeste();
  const dia = "2026-10-15";
  banco.insert(schema.usageDaily).values([
    { day: dia, agentId: "pr-review", costUsd: 1, tokens: 10, runs: 1 },
    { day: dia, agentId: "biblioteca:revisor", costUsd: 1, tokens: 10, runs: 0 },
  ]).run();
  const uso = await new MetricsService(banco).usage();
  assert.deepEqual(
    uso.map((u) => [u.agentId, u.kind]).sort(),
    [["biblioteca:revisor", "agent"], ["pr-review", "automation"]],
  );
});
