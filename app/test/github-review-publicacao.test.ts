import { before, test } from "node:test";
import assert from "node:assert/strict";
import { PublishConflict } from "../src/approval/gate.js";
import { migrateDb } from "../src/db/migrate.js";
import { githubReviewHandler, LOCUM_MARKER, type ReviewClient } from "../src/sources/github.js";

before(() => {
  migrateDb();
});

type Chamada = Record<string, unknown>;

/** Cliente falso: nada sai para o GitHub. `headAtual` é o que o PR tem agora. */
function cliente(opcoes: { reviews?: { body: string }[]; headAtual?: string } = {}) {
  const criadas: Chamada[] = [];
  const fake = {
    rest: {
      pulls: {
        createReview: async (p: Chamada) => {
          criadas.push(p);
          return {};
        },
        listReviews: async () => ({ data: opcoes.reviews ?? [] }),
        get: async () => ({ data: { head: { sha: opcoes.headAtual ?? "aaa111" } } }),
      },
    },
  } as unknown as ReviewClient;
  return { fake, criadas };
}

const BASE = { owner: "acme", repo: "api", pull: 7, findings: [] };

test("sem achados e sem resumo, o corpo é só a marca invisível: nenhum texto fixo", async () => {
  const { fake, criadas } = cliente();
  await githubReviewHandler(() => fake).publish({ ...BASE, verdict: "APPROVE" }, "run:passo:0");
  const body = String(criadas[0]!.body);
  assert.equal(body.replaceAll(LOCUM_MARKER, "").replace("<!-- locum:run:passo:0 -->", "").trim(), "");
  assert.ok(body.includes("<!-- locum:run:passo:0 -->"));
});

test("o resumo do payload é o corpo, sem acréscimo", async () => {
  const { fake, criadas } = cliente();
  await githubReviewHandler(() => fake).publish({ ...BASE, summary: "Tudo certo" }, "run:passo:0");
  assert.ok(String(criadas[0]!.body).startsWith("Tudo certo"));
  assert.ok(!String(criadas[0]!.body).includes("LGTM"));
});

test("a review sai presa ao commit avaliado", async () => {
  const { fake, criadas } = cliente({ headAtual: "aaa111" });
  await githubReviewHandler(() => fake).publish({ ...BASE, verdict: "APPROVE", headSha: "aaa111" }, "run:passo:0");
  assert.equal(criadas[0]!.commit_id, "aaa111");
});

test("a cabeça do PR mudou desde a avaliação: conflito claro, nada publicado", async () => {
  const { fake, criadas } = cliente({ headAtual: "bbb222" });
  await assert.rejects(
    githubReviewHandler(() => fake).publish({ ...BASE, verdict: "APPROVE", headSha: "aaa111" }, "run:passo:0"),
    (err: Error) => err instanceof PublishConflict && /aaa111/.test(err.message) && /bbb222/.test(err.message),
  );
  assert.equal(criadas.length, 0);
});

test("evento sem headSha publica sem commit_id e deixa isso na proposta", async () => {
  const { fake, criadas } = cliente();
  const handler = githubReviewHandler(() => fake);
  const proposta = (await handler.propose!({ ...BASE }, null)) as { semCommitAvaliado?: boolean };
  assert.equal(proposta.semCommitAvaliado, true);
  await handler.publish(proposta, "run:passo:0");
  assert.equal("commit_id" in criadas[0]!, false);
});

test("proposta com headSha não leva o aviso de commit", async () => {
  const handler = githubReviewHandler(() => cliente().fake);
  const proposta = (await handler.propose!({ ...BASE, headSha: "aaa111" }, null)) as Chamada;
  assert.equal("semCommitAvaliado" in proposta, false);
});

test("rascunho também leva o commit avaliado", async () => {
  const { fake, criadas } = cliente();
  await githubReviewHandler(() => fake).draft!({ ...BASE, headSha: "aaa111" }, "run:passo:0");
  assert.equal(criadas[0]!.commit_id, "aaa111");
});

test("marca de tentativa antiga não bloqueia a tentativa nova", async () => {
  const { fake, criadas } = cliente({ reviews: [{ body: "x\n<!-- locum:run:passo:0 -->" }] });
  await githubReviewHandler(() => fake).publish({ ...BASE }, "run:passo:1");
  assert.equal(criadas.length, 1);
});

test("pendência antiga, sem tentativa no id, continua achando a própria review", async () => {
  const { fake, criadas } = cliente({ reviews: [{ body: "x\n<!-- locum:run:passo -->" }] });
  await githubReviewHandler(() => fake).publish({ ...BASE }, "run:passo");
  assert.equal(criadas.length, 0);
});

test("o handler declara que o headSha é do evento, e não do modelo", () => {
  assert.deepEqual(githubReviewHandler(() => cliente().fake).camposDoEvento, ["headSha"]);
});
