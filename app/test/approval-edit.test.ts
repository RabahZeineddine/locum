import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentSpec } from "../src/config/types.js";
import { schema } from "../src/db/index.js";
import { eq } from "drizzle-orm";
import { buildGate } from "../src/executor/build.js";
import { ApprovalService } from "../src/services/approval-service.js";
import { AgentService } from "../src/services/agent-service.js";
import { bancoDeTeste } from "./helpers/db.js";

const ALVO = { owner: "dono", repo: "repositorio", pull: 42 };

const achado = {
  file: "src/Pedido.cs",
  line: 10,
  severity: "high",
  category: "nulo",
  problem: "referência nula quando o pedido não tem cliente",
  fix: "conferir antes de ler",
};

/** Uma pendência de review como o executor deixa, com o alvo que ele gravou. */
async function pendencia(kind = "github.review_comment", payload: object = { ...ALVO, findings: [achado] }) {
  const db = bancoDeTeste();
  const versao = await new AgentService(db).upsert(
    AgentSpec.parse({
      id: "revisor",
      name: "Revisor",
      steps: [
        { type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt: "revise" },
        { type: "action", key: "publicar", name: "Publicar", action: kind, needs: ["ler"] },
      ],
    }),
    undefined,
    "human",
  );
  await db.insert(schema.runs).values({ id: "run", agentVersionId: versao.id, status: "paused" });
  await db.insert(schema.steps).values({
    id: "passo",
    runId: "run",
    idx: 1,
    stepKey: "publicar",
    name: "Publicar",
    status: "awaiting_approval",
  });
  await db.insert(schema.approvals).values({ id: "pendencia", runId: "run", stepId: "passo", kind, payload });
  return new ApprovalService(db);
}

test("edição que tenta trocar o alvo mantém o pull request gravado pelo executor", async () => {
  const service = await pendencia();
  const outro = { ...achado, problem: "texto revisado" };

  // A janela com defeito manda o payload inteiro, com outro repositório dentro.
  await service.updateFindings("pendencia", [
    { ...outro, owner: "outro", repo: "alheio", pull: 1 },
  ] as unknown[]).catch(() => undefined);
  await service.updateFindings("pendencia", { owner: "outro", repo: "alheio", pull: 1, findings: [outro] }).catch(
    () => undefined,
  );

  const gravada = (await service.get("pendencia"))!.payload as Record<string, unknown>;
  assert.equal(gravada.owner, ALVO.owner);
  assert.equal(gravada.repo, ALVO.repo);
  assert.equal(gravada.pull, ALVO.pull);
});

test("edição troca a lista de achados e preserva o resto do payload", async () => {
  const service = await pendencia();
  const revisado = { ...achado, problem: "texto revisado" };

  const nova = await service.updateFindings("pendencia", [revisado]);

  assert.deepEqual(nova.payload, { ...ALVO, findings: [revisado] });
});

test("lista vazia é edição válida: a pessoa tirou todos os achados", async () => {
  const service = await pendencia();
  const nova = await service.updateFindings("pendencia", []);
  assert.deepEqual(nova.payload, { ...ALVO, findings: [] });
});

test("achado fora do formato é recusado e a pendência fica como estava", async () => {
  const service = await pendencia();
  const invalidos: unknown[] = [
    [{ ...achado, severity: "gravissimo" }],
    [{ ...achado, problem: "" }],
    [{ ...achado, line: -3 }],
    [{ ...achado, owner: "outro" }],
    "não é lista",
  ];

  for (const entrada of invalidos) {
    await assert.rejects(service.updateFindings("pendencia", entrada), /findings/);
  }
  assert.deepEqual((await service.get("pendencia"))!.payload, { ...ALVO, findings: [achado] });
});

test("pendência que não é de review não aceita edição de achados", async () => {
  const service = await pendencia("slack.post", { channel: "C1", text: "oi" });
  await assert.rejects(service.updateFindings("pendencia", [achado]), /não aceita edição de findings/);
  assert.deepEqual((await service.get("pendencia"))!.payload, { channel: "C1", text: "oi" });
});

const RESPOSTA = { chatId: "19:abc", text: "texto do modelo", subject: "pode olhar?", author: "Ana", webUrl: null };

test("resposta do Teams troca só o texto, e o destino fica o gravado", async () => {
  const service = await pendencia("teams.post", RESPOSTA);
  const nova = await service.updateText("pendencia", "  texto revisado  ");
  assert.deepEqual(nova.payload, { ...RESPOSTA, text: "texto revisado" });
});

test("texto vazio, longo demais ou em pendência que não é mensagem é recusado", async () => {
  const service = await pendencia("slack.post", { ...RESPOSTA, channel: "C1", threadTs: "1.0" });
  await assert.rejects(service.updateText("pendencia", "   "), /text/);
  await assert.rejects(service.updateText("pendencia", "x".repeat(3001)));
  await assert.rejects(service.updateText("pendencia", { text: "objeto" }));

  const review = await pendencia();
  await assert.rejects(review.updateText("pendencia", "oi"), /não aceita edição de text/);
});

test("a Fila não cria tarefa de tracker a partir de uma review: abrir tarefa é nó do fluxo", async () => {
  const service = await pendencia();
  assert.equal("createTrackerIssueProposal" in service, false);
});

test("pendência de tracker.create_issue gravada antes continua na Fila e decidível", async () => {
  const service = await pendencia("tracker.create_issue", {
    tracker: "shortcut",
    project: "123",
    title: "Fix PR #42: ajuste",
    body: "### Apontamentos a Resolver",
    pullRequestUrl: "https://github.com/dono/repositorio/pull/42",
  });

  const fila = await service.listPending();
  assert.deepEqual(fila.map((p) => [p.id, p.kind]), [["pendencia", "tracker.create_issue"]]);
});

const bancoDe = (service: ApprovalService) => (service as unknown as { db: ReturnType<typeof bancoDeTeste> }).db;

test("cada ação que se edita declara os campos editáveis num esquema, e a gate os expõe", () => {
  const gate = buildGate();
  assert.deepEqual(Object.keys(gate.camposEditaveis("github.review_comment")!.properties!).sort(), ["findings", "summary", "verdict"]);
  assert.deepEqual(Object.keys(gate.camposEditaveis("teams.post")!.properties!), ["text"]);
  assert.deepEqual(Object.keys(gate.camposEditaveis("slack.post")!.properties!), ["text"]);
  assert.equal(gate.camposEditaveis("tracker.create_issue"), undefined);
  const descrita = gate.describe().find((a) => a.kind === "teams.post");
  assert.deepEqual(descrita?.camposEditaveis, gate.camposEditaveis("teams.post"));
});

test("editar pela conversa muda o payload e marca a pendência; pela pessoa, muda e não marca", async () => {
  const service = await pendencia("teams.post", RESPOSTA);
  const pelaPessoa = await service.editarCampos("pendencia", { text: "da pessoa" }, "pessoa");
  assert.equal((pelaPessoa.payload as { text: string }).text, "da pessoa");
  assert.equal(pelaPessoa.alteradaPelaConversaEm, null);

  const antes = Math.floor(Date.now() / 1000);
  const pelaConversa = await service.editarCampos("pendencia", { text: "da conversa" }, { conversa: "run" });
  assert.deepEqual(pelaConversa.payload, { ...RESPOSTA, text: "da conversa" });
  assert.ok(pelaConversa.alteradaPelaConversaEm! >= antes);

  // Quem editou por último vale: a pessoa sobrescreve e a marca da conversa some.
  const depois = await service.editarCampos("pendencia", { text: "a pessoa voltou atrás" }, "pessoa");
  assert.equal((depois.payload as { text: string }).text, "a pessoa voltou atrás");
  assert.equal(depois.alteradaPelaConversaEm, null);
});

test("editar pela conversa recusa campo fora do esquema da ação, e a pendência fica como estava", async () => {
  const service = await pendencia("teams.post", RESPOSTA);
  await assert.rejects(service.editarCampos("pendencia", { chatId: "19:outra" }, { conversa: "run" }), /chatId/);
  await assert.rejects(service.editarCampos("pendencia", { text: "ok", chatId: "19:outra" }, { conversa: "run" }), /chatId/);
  const intacta = await service.get("pendencia");
  assert.deepEqual(intacta!.payload, RESPOSTA);
  assert.equal(intacta!.alteradaPelaConversaEm, null);
});

test("editar pela conversa recusa pendência de outro run", async () => {
  const service = await pendencia("teams.post", RESPOSTA);
  await assert.rejects(service.editarCampos("pendencia", { text: "x" }, { conversa: "outro-run" }), /outro run/);
  assert.deepEqual((await service.get("pendencia"))!.payload, RESPOSTA);
});

test("editar pela conversa recusa automação arquivada e pendência já resolvida", async () => {
  const service = await pendencia("teams.post", RESPOSTA);
  const db = bancoDe(service);
  await db.update(schema.agents).set({ archivedAt: 1 }).where(eq(schema.agents.id, "revisor"));
  await assert.rejects(service.editarCampos("pendencia", { text: "x" }, { conversa: "run" }), /arquivada/);
  await db.update(schema.agents).set({ archivedAt: null }).where(eq(schema.agents.id, "revisor"));
  await db.update(schema.approvals).set({ status: "approved" }).where(eq(schema.approvals.id, "pendencia"));
  await assert.rejects(service.editarCampos("pendencia", { text: "x" }, { conversa: "run" }), /já resolvida/);
  assert.deepEqual((await service.get("pendencia"))!.payload, RESPOSTA);
});
