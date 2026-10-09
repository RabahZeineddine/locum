import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentSpec, SERVIDOR_NATIVO, type Step } from "../src/config/types.js";
import { buildDigestProposal, DIGEST_READING_SCHEMA } from "../src/digest/proposal.js";
import { foraDoCaminhoEscolhido } from "../src/executor/executor.js";
import { runLogic } from "../src/executor/logic.js";

/** O exemplo da central de chamados: o desenho dos ramos e o contrato com o digest. */

const spec = AgentSpec.parse(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../examples/agents/support-desk.json", import.meta.url)), "utf8")),
);
const passo = (key: string) => spec.steps.find((s) => s.key === key) as Step;

/** Roda só a decisão dos ramos, na ordem do arquivo (já é topológica), com a saída da triagem dada. */
function ramos(triagem: unknown): string[] {
  const saidas = new Map<string, unknown>([["triage", triagem]]);
  const fora = new Set<string>();
  const rodou: string[] = [];
  for (const step of spec.steps) {
    if (step.key === "triage") continue;
    if (foraDoCaminhoEscolhido(step, saidas, fora)) {
      saidas.set(step.key, null);
      fora.add(step.key);
      continue;
    }
    rodou.push(step.key);
    saidas.set(step.key, step.type === "logic" ? runLogic(step, { repo: "", changedFiles: [] }, saidas) : { simulado: true });
  }
  return rodou;
}

const item = { channel: "#suporte", subject: "login fora", kind: "needs_reply", summary: "state: new | faixa: p1" };

test("a triagem lê com ferramentas de leitura e pede a faixa à ferramenta nativa", () => {
  const triage = passo("triage");
  assert.ok(triage.type === "model");
  assert.equal(triage.model, "claude-code/haiku");
  assert.ok(triage.tools!.every((t) => t.class === "read"));
  assert.ok(triage.tools!.some((t) => t.server === SERVIDOR_NATIVO && t.tool === "business_hours"));
  assert.match(triage.prompt, /business_hours/);
  const investigate = passo("investigate");
  assert.ok(investigate.type === "model");
  assert.equal(investigate.model, "claude-code/sonnet");
  assert.ok(investigate.tools!.every((t) => t.class === "read" && t.server !== SERVIDOR_NATIVO));
  assert.deepEqual(investigate.outputSchema, DIGEST_READING_SCHEMA);
});

test("a saída da triagem é um digest com o booleano de investigação por cima", () => {
  const triage = passo("triage");
  assert.ok(triage.type === "model");
  const { needsInvestigation, ...resto } = triage.outputSchema!.properties as Record<string, unknown>;
  assert.deepEqual(needsInvestigation, { type: "boolean" });
  assert.deepEqual(resto, DIGEST_READING_SCHEMA.properties);
  const proposta = buildDigestProposal({ headline: "1 aberto", items: [item], needsInvestigation: false });
  assert.equal(proposta.counts.needs_reply, 1);
});

test("só digest.deliver em aprovação sai do fluxo, e nenhum gatilho vem no arquivo", () => {
  const saidas = spec.steps.filter((s) => s.type === "action");
  assert.deepEqual(saidas.map((s) => s.type === "action" && [s.action, s.mode]), [
    ["digest.deliver", "approve"],
    ["digest.deliver", "approve"],
  ]);
  assert.ok(spec.budget.perRunTokens !== undefined);
});

test("dia calmo: sem itens nada é entregue e ninguém falha", () => {
  assert.deepEqual(ramos({ headline: "calmo", items: [], needsInvestigation: false }), ["no_items"]);
});

test("itens sem urgência vão direto para a entrega da triagem", () => {
  assert.deepEqual(ramos({ headline: "x", items: [item], needsInvestigation: false }), [
    "no_items",
    "needs_look",
    "deliver_triage",
  ]);
});

test("itens que pedem olhar mais fundo passam pela investigação e saem só por ela", () => {
  assert.deepEqual(ramos({ headline: "x", items: [item], needsInvestigation: true }), [
    "no_items",
    "needs_look",
    "investigate",
    "deliver_investigated",
  ]);
});

test("importa pelo serviço, que é por onde o exemplo entra de verdade", async () => {
  const { AgentService } = await import("../src/services/agent-service.js");
  const { bancoDeTeste } = await import("./helpers/db.js");
  const texto = readFileSync(fileURLToPath(new URL("../../examples/agents/support-desk.json", import.meta.url)), "utf8");
  const { created } = await new AgentService(bancoDeTeste()).importSpec(texto, "support-desk.json");
  assert.equal(created, true);
});

test("a triagem não põe resolvido nem waiting_requester em items, e fixa a janela de leitura", () => {
  const triage = passo("triage");
  assert.ok(triage.type === "model");
  assert.equal(triage.maxSteps, 60);
  assert.match(triage.prompt, /waiting_requester ou resolved não vira item/);
  assert.match(triage.prompt, /3 dias corridos/);
});
