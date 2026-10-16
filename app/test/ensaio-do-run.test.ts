import { test } from "node:test";
import assert from "node:assert/strict";
import { ensaioDoPasso, estimativaAcimaDoTeto, passoDoDetalhe, passosEmEnsaio, ondeSairia } from "../renderer/lib/ensaio-do-run.js";

const ensaio = { state: "ensaio", motivo: "sem-conversa", text: "Revisão: tudo certo" };

test("ensaioDoPasso lê motivo e texto, e ignora saída que não é ensaio", () => {
  assert.deepEqual(ensaioDoPasso(ensaio), { motivo: "sem-conversa", text: "Revisão: tudo certo" });
  assert.deepEqual(ensaioDoPasso({ state: "ensaio" }), { motivo: "", text: null });
  assert.equal(ensaioDoPasso({ state: "published" }), null);
  assert.equal(ensaioDoPasso(null), null);
  assert.equal(ensaioDoPasso("ensaio"), null);
});

test("passosEmEnsaio devolve a chave de cada passo em ensaio, na ordem", () => {
  const steps = [
    { stepKey: "ler", output: { findings: [] } },
    { stepKey: "postar", output: ensaio },
    { stepKey: "avisar", output: { ...ensaio, motivo: "evento-colado" } },
  ];
  assert.deepEqual(passosEmEnsaio(steps).map((p) => p.stepKey), ["postar", "avisar"]);
  assert.deepEqual(passosEmEnsaio([{ stepKey: "ler", output: null }]), []);
});

test("passoDoDetalhe separa o run do passo no detalhe da rota", () => {
  const id = "0b0c5f0e-1111-4222-8333-444455556666";
  assert.deepEqual(passoDoDetalhe(id), { runId: id, stepKey: null });
  assert.deepEqual(passoDoDetalhe(`${id}@postar`), { runId: id, stepKey: "postar" });
  assert.equal(passoDoDetalhe("observability-watch"), null);
  assert.equal(passoDoDetalhe(null), null);
});

test("ondeSairia diz o destino pela ação do passo", () => {
  assert.equal(ondeSairia("teams.post"), "teams");
  assert.equal(ondeSairia("slack.post"), "slack");
  assert.equal(ondeSairia("github.review_comment"), "github");
  assert.equal(ondeSairia("tracker.create_issue"), "outro");
  assert.equal(ondeSairia(undefined), "outro");
});

const passo = (stepKey: string, costUsd: number, billable: boolean) => ({ stepKey, costUsd, billable });
const run = (perRunUsd: number | undefined, steps: ReturnType<typeof passo>[], tetosDosAgents: Record<string, number> = {}) => ({
  spec: {
    budget: perRunUsd === undefined ? {} : { perRunUsd },
    steps: [{ key: "ler", profile: "revisor" }, { key: "resumir" }, { key: "postar" }],
  },
  steps,
  tetosDosAgents,
});

test("assinatura com estimativa acima do teto da automação avisa, com os valores", () => {
  const aviso = estimativaAcimaDoTeto(run(0.2, [passo("ler", 0.7, false)]));
  assert.deepEqual(aviso, { estimateUsd: 0.7, capUsd: 0.2 });
});

test("sem teto, ou dentro dele, não avisa", () => {
  assert.equal(estimativaAcimaDoTeto(run(undefined, [passo("ler", 0.7, false)])), null);
  assert.equal(estimativaAcimaDoTeto(run(0.2, [passo("ler", 0.1, false)])), null);
});

test("modelo sem preço cobrado (billable, custo zero) não diz assinatura", () => {
  assert.equal(estimativaAcimaDoTeto(run(0.2, [passo("ler", 0, true)])), null);
});

test("run misto soma o cobrado ao estimado do não cobrado", () => {
  const aviso = estimativaAcimaDoTeto(run(0.2, [passo("ler", 0.15, true), passo("resumir", 0.1, false)]));
  assert.ok(aviso !== null);
  assert.ok(Math.abs(aviso.estimateUsd - 0.25) < 1e-9);
  assert.equal(aviso.capUsd, 0.2);
  // Tudo cobrado passou do teto por outro caminho (o orçamento barra): não é assunto deste aviso.
  assert.equal(estimativaAcimaDoTeto(run(0.2, [passo("ler", 0.5, true)])), null);
});

test("teto só no agent da biblioteca avisa pelos passos que usam esse agent", () => {
  const passos = [passo("ler", 0.4, false), passo("resumir", 0.1, false)];
  assert.deepEqual(estimativaAcimaDoTeto(run(undefined, passos, { revisor: 0.3 })), { estimateUsd: 0.4, capUsd: 0.3 });
  assert.equal(estimativaAcimaDoTeto(run(undefined, passos, { outro: 0.01 })), null);
});
