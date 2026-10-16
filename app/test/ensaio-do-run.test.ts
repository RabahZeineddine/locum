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

test("estimativa acima do teto só vale para run não cobrado", () => {
  const spec = (perRunUsd?: number) => ({ budget: perRunUsd === undefined ? {} : { perRunUsd } });
  assert.equal(estimativaAcimaDoTeto({ costUsd: 0, estimateUsd: 0.7, spec: spec(0.2) }), true);
  assert.equal(estimativaAcimaDoTeto({ costUsd: 0, estimateUsd: 0.1, spec: spec(0.2) }), false);
  assert.equal(estimativaAcimaDoTeto({ costUsd: 0, estimateUsd: 0.7, spec: spec() }), false);
  assert.equal(estimativaAcimaDoTeto({ costUsd: 0.3, estimateUsd: 0.7, spec: spec(0.2) }), false);
});
