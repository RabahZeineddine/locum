import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { AgentSpec } from "../src/config/types.js";
import { schema } from "../src/db/index.js";
import { AgentService } from "../src/services/agent-service.js";
import { bancoDeTeste } from "./helpers/db.js";

const spec = (id: string, prompt = "x") =>
  AgentSpec.parse({ id, name: id, steps: [{ type: "model", key: "ler", name: "Ler", model: "ollama/m", prompt }] });

async function arquivada() {
  const db = bancoDeTeste();
  const agents = new AgentService(db);
  await agents.upsert(spec("arq-a"), undefined, "human");
  await agents.upsert(spec("arq-a", "outro"), undefined, "human");
  db.update(schema.agents).set({ archivedAt: 1 }).where(eq(schema.agents.id, "arq-a")).run();
  return { db, agents };
}
const versoes = (db: Awaited<ReturnType<typeof arquivada>>["db"]) => db.select().from(schema.agentVersions).all().length;

const caminhos: [string, (a: AgentService) => Promise<unknown>][] = [
  ["save_agent_edited", (a) => a.saveEdited("arq-a", spec("arq-a", "novo"), "n")],
  ["restore_agent_version", (a) => a.restoreVersion("arq-a", 1)],
  ["upsert_agent e import de agent", (a) => a.upsert(spec("arq-a", "novo"), "n", "human")],
  ["set_agent_budget", (a) => a.setBudget("arq-a", { perDayUsd: 1 })],
];
for (const [nome, caminho] of caminhos) {
  test(`${nome} recusa a automação arquivada e não grava versão`, async () => {
    const { db, agents } = await arquivada();
    const antes = versoes(db);
    await assert.rejects(caminho(agents), /esta arquivada/);
    assert.equal(versoes(db) - antes, 0);
  });
}

test("salvar o mesmo spec na arquivada também é recusado, e desarquivar libera", async () => {
  const { db, agents } = await arquivada();
  const igual = (await agents.getLatestVersion("arq-a"))!.spec;
  await assert.rejects(agents.saveEdited("arq-a", igual, "n"), /esta arquivada/);
  db.update(schema.agents).set({ archivedAt: null }).where(eq(schema.agents.id, "arq-a")).run();
  await agents.saveEdited("arq-a", spec("arq-a", "novo"), "n");
});
