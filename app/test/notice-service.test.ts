import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentSpec } from "../src/config/types.js";
import { schema } from "../src/db/index.js";
import { AgentService } from "../src/services/agent-service.js";
import { NoticeService, criticalNotices } from "../src/services/notice-service.js";
import { bancoDeTeste } from "./helpers/db.js";

async function montar() {
  const db = bancoDeTeste();
  const versao = await new AgentService(db).upsert(
    AgentSpec.parse({
      id: "revisor",
      name: "Revisor",
      steps: [{ type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt: "revise" }],
    }),
    undefined,
    "human",
  );
  return { db, versao: versao.id, service: new NoticeService(db) };
}

test("pendências do mesmo run viram um aviso só, com a soma dos críticos e a hora da mais nova", () => {
  const avisos = criticalNotices([
    { runId: "r1", agentName: "A", createdAt: 10, payload: { findings: [{ severity: "critical" }, { severity: "high" }] } },
    { runId: "r1", agentName: "A", createdAt: 30, payload: { findings: [{ severity: "critical" }] } },
    { runId: "r2", agentName: "B", createdAt: 20, payload: { findings: [{ severity: "high" }] } },
    { runId: "r3", agentName: "C", createdAt: 5, payload: "texto solto" },
  ]);
  assert.deepEqual(avisos, [
    { key: "critical_finding:r1", runId: "r1", kind: "critical_finding", agentName: "A", criticalCount: 2, at: 30 },
  ]);
});

test("run longo que falhou agora entra no aviso, mesmo criado antes do corte", async () => {
  const { db, versao, service } = await montar();
  await db.insert(schema.runs).values([
    { id: "longo", agentVersionId: versao, status: "failed", error: "estourou", createdAt: 100, endedAt: 900 },
    { id: "velho", agentVersionId: versao, status: "failed", createdAt: 100, endedAt: 200 },
    { id: "ok", agentVersionId: versao, status: "done", createdAt: 800, endedAt: 850 },
  ]);

  const avisos = await service.pending({ since: 500 });
  assert.deepEqual(
    avisos.map((a) => [a.key, a.agentName, a.error, a.at]),
    [["run_failed:longo", "Revisor", "estourou", 900]],
  );
});

test("teto de leitura fica com as falhas mais recentes, pela hora da falha", async () => {
  const { db, versao, service } = await montar();
  await db.insert(schema.runs).values([
    { id: "criado-cedo", agentVersionId: versao, status: "failed", createdAt: 1, endedAt: 999 },
    { id: "a", agentVersionId: versao, status: "failed", createdAt: 10, endedAt: 11 },
    { id: "b", agentVersionId: versao, status: "failed", createdAt: 20, endedAt: 21 },
  ]);

  const avisos = await service.pending({ limit: 2 });
  assert.deepEqual(avisos.map((a) => a.runId), ["criado-cedo", "b"]);
});
