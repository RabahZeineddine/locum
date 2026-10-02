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
  const versao = await service.upsert(spec("auto", "revise com calma"), undefined, "agent");

  assert.equal(versao.version, 2);
  assert.deepEqual(versao.downgrades, []);
  assert.equal(await modoGravado(service), "auto");
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
