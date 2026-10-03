import { before, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { ApprovalGate } from "../src/approval/gate.js";
import { AgentSpec, LogicStep } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { Executor, foraDoCaminhoEscolhido } from "../src/executor/executor.js";
import { markdownParaSlack, runLogic } from "../src/executor/logic.js";
import { McpRegistry } from "../src/mcp/registry.js";
import { AgentService } from "../src/services/agent-service.js";

/** Passos de lógica: decidir caminho e transformar dado, sem modelo. */

before(() => migrateDb());

const evento = { repo: "slack/C1", changedFiles: [], text: "o login quebrou de novo" };
const saidas = new Map<string, unknown>([["analisar", { categoria: "bug", prioridade: 3, json: '```json\n{"a":1}\n```' }]]);
const passo = (extra: Record<string, unknown>) =>
  LogicStep.parse({ type: "logic", key: "x", name: "x", op: "if", ...extra });

test("if compara texto, número, vazio e expressão", () => {
  const caminho = (extra: Record<string, unknown>) =>
    (runLogic(passo(extra), evento, saidas) as { branch: string }).branch;
  assert.equal(caminho({ value: "{{event.text}}", compare: "contains", against: "LOGIN" }), "true");
  assert.equal(caminho({ value: "{{steps.analisar.prioridade}}", compare: "greater", against: "2" }), "true");
  assert.equal(caminho({ value: "{{steps.analisar.nada}}", compare: "empty" }), "true");
  assert.equal(caminho({ value: "{{steps.analisar.categoria}}", compare: "matches", against: "^(bug|erro)$" }), "true");
  assert.equal(caminho({ value: "{{steps.analisar.categoria}}", compare: "equals", against: "dúvida" }), "false");
});

test("switch escolhe o caso pelo texto exato, e o resto vai para default", () => {
  const s = (v: string) =>
    (runLogic(passo({ op: "switch", value: v, cases: ["bug", "dúvida"] }), evento, saidas) as { branch: string }).branch;
  assert.equal(s("{{steps.analisar.categoria}}"), "bug");
  assert.equal(s("pedido"), "default");
});

test("json.parse tira a cerca do modelo, e texto inválido falha com o nome do passo", () => {
  assert.deepEqual(runLogic(passo({ op: "json.parse", value: "{{steps.analisar.json}}" }), evento, saidas), { a: 1 });
  assert.throws(() => runLogic(passo({ op: "json.parse", name: "Ler", value: "não é json" }), evento, saidas), /"Ler" não é JSON/);
});

test("markdown vira mrkdwn do Slack sem mexer em código", () => {
  const md = "# Resumo\n**Bug** no *login*, veja [o PR](https://x.y/1)\n- item\n`**cru**`";
  assert.equal(markdownParaSlack(md), "*Resumo*\n*Bug* no _login_, veja <https://x.y/1|o PR>\n• item\n`**cru**`");
});

test("blocos do Slack e cartão do Teams levam título e texto", () => {
  const blocos = runLogic(passo({ op: "slack.blocks", title: "Chamado", value: "**urgente**" }), evento, saidas) as {
    text: string;
    blocks: { type: string }[];
  };
  assert.deepEqual(blocos.blocks.map((b) => b.type), ["header", "section"]);
  assert.match(blocos.text, /\*urgente\*/);
  const cartao = runLogic(passo({ op: "teams.card", title: "Chamado", value: "texto" }), evento, saidas) as {
    card: { type: string; body: unknown[] };
  };
  assert.equal(cartao.card.type, "AdaptiveCard");
  assert.equal(cartao.card.body.length, 2);
});

test("passo fora do caminho pula, e a junção depois de dois caminhos roda", () => {
  const decisao = new Map<string, unknown>([["se", { branch: "true" }]]);
  const fora = new Set<string>();
  const base = { type: "model" as const, name: "n", optional: false, model: "a/b", prompt: "", requiresServers: [], maxSteps: 1 };
  assert.equal(foraDoCaminhoEscolhido({ ...base, key: "a", needs: ["se"], when: { step: "se", branch: "true" } }, decisao, fora), false);
  assert.equal(foraDoCaminhoEscolhido({ ...base, key: "b", needs: ["se"], when: { step: "se", branch: "false" } }, decisao, fora), true);
  fora.add("b");
  assert.equal(foraDoCaminhoEscolhido({ ...base, key: "c", needs: ["b"] }, decisao, fora), true);
  assert.equal(foraDoCaminhoEscolhido({ ...base, key: "d", needs: ["a", "b"] }, decisao, fora), false);
});

test("o executor roda o caminho escolhido e grava o outro como pulado", async () => {
  const executor = new Executor({
    mcp: new McpRegistry(new Map()),
    runtimes: new Map(),
    gate: new ApprovalGate(new Map()),
    machineId: "maquina-de-teste",
  });
  const logica = (key: string, extra: Record<string, unknown>) => ({ type: "logic", key, name: key, ...extra });
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id: `logica-${randomUUID().slice(0, 8)}`,
      name: "Lógica",
      steps: [
        logica("se", { op: "if", value: "{{event.text}}", compare: "contains", against: "quebrou" }),
        logica("sim", { op: "text", value: "é bug", needs: ["se"], when: { step: "se", branch: "true" } }),
        logica("nao", { op: "text", value: "não é", needs: ["se"], when: { step: "se", branch: "false" } }),
        logica("depois-do-nao", { op: "text", value: "x", needs: ["nao"] }),
        logica("junta", { op: "text", value: "{{steps.sim}}{{steps.nao}}", needs: ["sim", "nao"] }),
      ],
    }),
    undefined,
    "human",
  );
  const eventId = randomUUID();
  await db.insert(schema.events).values({ id: eventId, source: "teste", externalId: eventId, payload: evento });
  const runId = await executor.createRun(versao.id, eventId);
  assert.equal(await executor.execute(runId), "done");

  const passos = await db.select().from(schema.steps).where(and(eq(schema.steps.runId, runId)));
  const estado = Object.fromEntries(passos.map((p) => [p.stepKey, `${p.status}${p.error ? `:${p.error}` : ""}`]));
  assert.deepEqual(estado, {
    se: "done",
    sim: "done",
    nao: "skipped:branch_not_taken",
    "depois-do-nao": "skipped:branch_not_taken",
    junta: "done",
  });
  assert.equal(passos.find((p) => p.stepKey === "junta")!.output, "é bugnull");
});
