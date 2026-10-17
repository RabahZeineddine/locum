import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentSpec } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { buildMcpServer } from "../src/mcp-server/server.js";
import { AgentService } from "../src/services/agent-service.js";

before(() => migrateDb());

async function cliente(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildMcpServer({ systemLocale: () => "pt-BR", appVersion: () => "0.0.0-teste" }).connect(serverTransport);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

const texto = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

test("propose_run_action cria a pendência na Fila e não publica, e describe_steps traz o inputSchema", async () => {
  const client = await cliente();
  const proposta = (await client.listTools()).tools.find((t) => t.name === "propose_run_action");
  assert.equal(proposta?.annotations?.destructiveHint, false);
  assert.equal(proposta?.annotations?.openWorldHint, false);

  const catalogo = JSON.parse(texto(await client.callTool({ name: "describe_steps", arguments: {} }))) as { actions: { kind: string; inputSchema?: unknown }[] };
  assert.ok(catalogo.actions.find((a) => a.kind === "github.review_comment")?.inputSchema);

  const versao = await new AgentService().upsert(
    AgentSpec.parse({ id: `mcp-${randomUUID().slice(0, 8)}`, name: "Revisor", steps: [{ type: "action", key: "revisar", name: "Revisar", action: "github.review_comment" }] }),
    undefined,
    "human",
  );
  const eventoId = randomUUID();
  await db.insert(schema.events).values({ id: eventoId, source: "github", externalId: eventoId, payload: { repo: "acme/api", repoName: "api", owner: "acme", pull: 7, headSha: "aaa111", changedFiles: [] } });
  const runId = randomUUID();
  await db.insert(schema.runs).values({ id: runId, agentVersionId: versao.id, eventId: eventoId, status: "done" });

  const resposta = JSON.parse(texto(await client.callTool({ name: "propose_run_action", arguments: { runId, kind: "github.review_comment", content: { verdict: "APPROVE", summary: "", findings: [] } } }))) as { approvalId: string; stepKey: string };
  assert.equal(resposta.stepKey, "avulso-1");
  const [pendencia] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId));
  assert.equal(pendencia!.id, resposta.approvalId);
  assert.equal(pendencia!.status, "pending");
  assert.equal((pendencia!.payload as { headSha: string }).headSha, "aaa111");

  const alvoNoConteudo = await client.callTool({ name: "propose_run_action", arguments: { runId, kind: "github.review_comment", content: { verdict: "APPROVE", findings: [], owner: "outra-org" } } });
  assert.equal((alvoNoConteudo as { isError?: boolean }).isError, true);
});
