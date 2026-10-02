import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { fromJSONSchema } from "zod";
import { ApprovalGate } from "../src/approval/gate.js";
import { AgentSpec } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { prReviewSpec } from "../src/examples/agents.js";
import { AgentService } from "../src/services/agent-service.js";
import { ApprovalService } from "../src/services/approval-service.js";
import { githubReviewHandler, type ReviewClient } from "../src/sources/github.js";

before(() => migrateDb());

const ALVO = { owner: "dono", repo: "repositorio", pull: 42 };

const achado = {
  file: "src/Pedido.cs",
  line: 10,
  severity: "high",
  confidence: "high",
  problem: "referência nula quando o pedido não tem cliente",
};

/** Cliente do GitHub que só anota o que teria sido enviado. */
function clienteFalso() {
  const enviadas: Array<Record<string, unknown>> = [];
  const cliente = {
    rest: {
      pulls: {
        createReview: async (params: Record<string, unknown>) => {
          enviadas.push(params);
          return {};
        },
        listReviews: async () => ({ data: enviadas.map((e) => ({ body: e.body })) }),
      },
    },
  } as unknown as ReviewClient;
  return { enviadas, cliente: () => cliente };
}

/** Run com um passo de ação parado, para a gate ter onde gravar a pendência. */
async function passoDeAcao() {
  const agentId = `revisor-${randomUUID()}`;
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: agentId,
      name: "Revisor",
      steps: [
        { type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt: "revise" },
        { type: "action", key: "publicar", name: "Publicar", action: "github.review_comment", needs: ["ler"] },
      ],
    }),
    undefined,
    "human",
  );
  const runId = randomUUID();
  const stepId = randomUUID();
  await db.insert(schema.runs).values({ id: runId, agentVersionId: versao.id, status: "running" });
  await db
    .insert(schema.steps)
    .values({ id: stepId, runId, idx: 1, stepKey: "publicar", name: "Publicar", status: "running" });
  return { runId, stepId };
}

test("a auditoria devolve o veredito, preso no esquema de saída", () => {
  const audit = prReviewSpec.steps.find((s) => s.key === "audit");
  assert.ok(audit?.type === "model");
  const esquema = fromJSONSchema(audit.outputSchema as never);

  for (const verdict of ["APPROVE", "COMMENT", "REQUEST_CHANGES"]) {
    assert.equal(esquema.safeParse({ findings: [achado], verdict }).success, true, verdict);
  }
  assert.equal(esquema.safeParse({ findings: [achado] }).success, false, "sem veredito");
  assert.equal(esquema.safeParse({ findings: [], verdict: "LGTM" }).success, false);

  for (const verdict of ["APPROVE", "COMMENT", "REQUEST_CHANGES"]) {
    assert.match(audit.prompt, new RegExp(verdict), `critério de ${verdict} no prompt`);
  }
});

test("a ação de review publica com o veredito como evento", async () => {
  const { enviadas, cliente } = clienteFalso();
  const handler = githubReviewHandler(cliente);

  await handler.publish({ ...ALVO, findings: [achado], verdict: "REQUEST_CHANGES" }, "ext-1");
  await handler.publish({ ...ALVO, findings: [], verdict: "APPROVE" }, "ext-2");
  // Pendência gravada antes do veredito existir sai como sempre saiu.
  await handler.publish({ ...ALVO, findings: [achado] }, "ext-3");

  assert.deepEqual(
    enviadas.map((e) => e.event),
    ["REQUEST_CHANGES", "APPROVE", "COMMENT"],
  );
});

test("aprovar ou pedir mudança nunca sai em modo automático: vai para a fila", async () => {
  for (const verdict of ["APPROVE", "REQUEST_CHANGES"]) {
    const { enviadas, cliente } = clienteFalso();
    const gate = new ApprovalGate(new Map([["github.review_comment", githubReviewHandler(cliente)]]));
    const { runId, stepId } = await passoDeAcao();

    const estado = await gate.submit(
      { runId, stepId, kind: "github.review_comment", payload: { ...ALVO, findings: [achado], verdict } },
      "auto",
    );

    assert.equal(estado, "pending", verdict);
    assert.equal(enviadas.length, 0, `${verdict} não pode ter saído`);
    const [pendencia] = await db.select().from(schema.approvals).where(eq(schema.approvals.stepId, stepId));
    assert.equal(pendencia?.status, "pending");
  }
});

test("comentário em modo automático continua saindo sem fila", async () => {
  const { enviadas, cliente } = clienteFalso();
  const gate = new ApprovalGate(new Map([["github.review_comment", githubReviewHandler(cliente)]]));
  const { runId, stepId } = await passoDeAcao();

  const estado = await gate.submit(
    { runId, stepId, kind: "github.review_comment", payload: { ...ALVO, findings: [achado], verdict: "COMMENT" } },
    "auto",
  );

  assert.equal(estado, "published");
  assert.equal(enviadas.length, 1);
});

/** Pendência de review como o executor deixa, no banco do módulo. */
async function pendencia(payload: object) {
  const { runId, stepId } = await passoDeAcao();
  const id = randomUUID();
  await db.insert(schema.approvals).values({ id, runId, stepId, kind: "github.review_comment", payload });
  return id;
}

test("a edição troca o veredito e recusa o que não é veredito", async () => {
  const service = new ApprovalService();
  const id = await pendencia({ ...ALVO, findings: [achado], verdict: "REQUEST_CHANGES" });

  const nova = await service.updateFindings(id, [achado], "COMMENT");
  assert.deepEqual(nova.payload, { ...ALVO, findings: [achado], verdict: "COMMENT" });

  await assert.rejects(service.updateFindings(id, [achado], "MERGE"), /veredito/);
  assert.equal(((await service.get(id))!.payload as { verdict: string }).verdict, "COMMENT");

  // Edição só de achados não mexe no veredito gravado.
  await service.updateFindings(id, []);
  assert.equal(((await service.get(id))!.payload as { verdict: string }).verdict, "COMMENT");
});

test("publicar de novo a mesma pendência não assina uma segunda review", async () => {
  const { enviadas, cliente } = clienteFalso();
  const handler = githubReviewHandler(cliente);
  const payload = { ...ALVO, findings: [achado], verdict: "COMMENT" };

  await handler.publish(payload, "pendencia-1");
  await handler.publish(payload, "pendencia-1");
  await handler.draft!(payload, "pendencia-1");
  assert.equal(enviadas.length, 1);
  assert.match(String(enviadas[0]!.body), /<!-- locum:pendencia-1 -->/);
  assert.match(String(enviadas[0]!.body), /<!-- locum -->/);

  await handler.publish(payload, "pendencia-2");
  assert.equal(enviadas.length, 2);
});
