import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentSpec, type ActionMode } from "../src/config/types.js";
import { AgentService } from "../src/services/agent-service.js";
import { bancoDeTeste } from "./helpers/db.js";

const spec = (mode: ActionMode, prompt = "revise"): AgentSpec =>
  AgentSpec.parse({
    id: "revisor",
    name: "Revisor",
    steps: [
      { type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt },
      { type: "action", key: "publicar", name: "Publicar", action: "github.review_comment", needs: ["ler"], mode },
    ],
  });

const modoGravado = async (service: AgentService): Promise<ActionMode | undefined> => {
  const versao = await service.getLatestVersion("revisor");
  const passo = versao?.spec.steps.find((s) => s.key === "publicar");
  return passo?.type === "action" ? passo.mode : undefined;
};

test("agent que grava ação em auto tem o passo rebaixado para approve", async () => {
  const service = new AgentService(bancoDeTeste());
  const versao = await service.upsert(spec("auto"), undefined, "agent");

  assert.deepEqual(versao.downgrades, [{ step: "publicar", from: "auto", to: "approve" }]);
  assert.equal(await modoGravado(service), "approve");
});

test("agent também não sobe para draft", async () => {
  const service = new AgentService(bancoDeTeste());
  const versao = await service.upsert(spec("draft"), undefined, "agent");

  assert.deepEqual(versao.downgrades, [{ step: "publicar", from: "draft", to: "approve" }]);
  assert.equal(await modoGravado(service), "approve");
});

test("ator padrão é agent, não pessoa", async () => {
  const service = new AgentService(bancoDeTeste());
  await service.upsert(spec("auto"));
  assert.equal(await modoGravado(service), "approve");
});

test("pessoa grava o modo que quiser", async () => {
  const service = new AgentService(bancoDeTeste());
  const versao = await service.upsert(spec("auto"), undefined, "human");

  assert.deepEqual(versao.downgrades, []);
  assert.equal(await modoGravado(service), "auto");
});

test("modo que uma pessoa já autorizou sobrevive a edição do agent em outra parte", async () => {
  const service = new AgentService(bancoDeTeste());
  await service.upsert(spec("auto"), undefined, "human");
  const original = spec("auto");
  const versao = await service.upsert(
    AgentSpec.parse({
      ...original,
      name: "Revisor de PR",
      budget: { perDayUsd: 1 },
      // Passo novo fora da cadeia da ação não mexe no que ela publica.
      steps: [...original.steps, { type: "model", key: "resumo", name: "Resumo", model: "anthropic/modelo", prompt: "resuma" }],
    }),
    undefined,
    "agent",
  );

  assert.equal(versao.version, 2);
  assert.deepEqual(versao.downgrades, []);
  assert.equal(await modoGravado(service), "auto");
});

test("trocar o prompt, o modelo ou as ferramentas acima da ação pede a autorização de novo", async () => {
  const service = new AgentService(bancoDeTeste());
  const autorizado = spec("auto");
  const comLer = (troca: Record<string, unknown>, base = autorizado): AgentSpec =>
    AgentSpec.parse({ ...base, steps: base.steps.map((s) => (s.key === "ler" ? { ...s, ...troca } : s)) });

  for (const editado of [
    spec("auto", "revise com calma"),
    comLer({ model: "anthropic/outro" }),
    comLer({ tools: [{ server: "srv", tool: "ler" }] }),
    AgentSpec.parse({ ...autorizado, defaultTools: [{ server: "srv", tool: "ler" }] }),
  ]) {
    await service.upsert(autorizado, undefined, "human");
    const versao = await service.upsert(editado, undefined, "agent");
    assert.deepEqual(versao.downgrades, [{ step: "publicar", from: "auto", to: "approve" }]);
  }

  // A cadeia é transitiva: o passo de antes do `ler` também conta.
  const emDoisPassos = (prompt: string): AgentSpec =>
    AgentSpec.parse({
      ...autorizado,
      steps: [
        { type: "model", key: "buscar", name: "Buscar", model: "anthropic/modelo", prompt },
        { ...autorizado.steps[0], needs: ["buscar"] },
        autorizado.steps[1],
      ],
    });
  await service.upsert(emDoisPassos("busque"), undefined, "human");
  const versao = await service.upsert(emDoisPassos("busque tudo"), undefined, "agent");
  assert.deepEqual(versao.downgrades, [{ step: "publicar", from: "auto", to: "approve" }]);
});

test("agent que sobe além do que a pessoa autorizou é rebaixado para approve", async () => {
  const service = new AgentService(bancoDeTeste());
  await service.upsert(spec("draft"), undefined, "human");
  const versao = await service.upsert(spec("auto"), undefined, "agent");

  assert.deepEqual(versao.downgrades, [{ step: "publicar", from: "auto", to: "approve" }]);
  assert.equal(await modoGravado(service), "approve");
});

test("ação já em approve não gera rebaixamento", async () => {
  const service = new AgentService(bancoDeTeste());
  const versao = await service.upsert(spec("approve"), undefined, "agent");
  assert.deepEqual(versao.downgrades, []);
});

test("autorização dada a uma ação não passa para outra ação ou outro destino na mesma chave", async () => {
  const comPasso = (passo: Record<string, unknown>): AgentSpec =>
    AgentSpec.parse({
      id: "revisor",
      name: "Revisor",
      steps: [
        { type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt: "revise" },
        { type: "action", key: "publicar", name: "Publicar", needs: ["ler"], mode: "auto", ...passo },
      ],
    });

  const service = new AgentService(bancoDeTeste());
  await service.upsert(comPasso({ action: "slack.post", target: "C-TIME" }), undefined, "human");

  for (const troca of [
    { action: "teams.post", target: "C-TIME" },
    { action: "slack.post", target: "C-OUTRO" },
    { action: "slack.post", target: "C-TIME", input: "ler.outra" },
  ]) {
    const versao = await service.upsert(comPasso(troca), undefined, "agent");
    assert.deepEqual(versao.downgrades, [{ step: "publicar", from: "auto", to: "approve" }]);
    await service.upsert(comPasso({ action: "slack.post", target: "C-TIME" }), undefined, "human");
  }
});

test("pelo servidor MCP o teto de gasto só baixa", async () => {
  const service = new AgentService(bancoDeTeste());
  await service.upsert({ ...spec("approve"), budget: { perDayUsd: 5 } }, undefined, "human");

  await assert.rejects(service.setBudget("revisor", { perDayUsd: null }), /só pode subir ou sair pela tela/);
  await assert.rejects(service.setBudget("revisor", { perDayUsd: 50 }), /perDayUsd/);
  await assert.rejects(
    service.upsert({ ...spec("approve"), budget: {} }, undefined, "agent"),
    /só pode subir ou sair pela tela/,
  );

  const menor = await service.setBudget("revisor", { perDayUsd: 2, perRunUsd: 1 });
  assert.deepEqual(menor.spec.budget, { perDayUsd: 2, perRunUsd: 1 });
  // A pessoa, pela tela, afrouxa à vontade.
  const solto = await service.upsert({ ...spec("approve"), budget: {} }, undefined, "human");
  assert.deepEqual(solto.spec.budget, {});
});
