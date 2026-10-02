import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentSpec, type ActionMode } from "../src/config/types.js";
import { AgentService } from "../src/services/agent-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/**
 * O editor da tela grava como pessoa, e duplicar é o caminho para criar agent.
 *
 * As duas operações abrem escrita a partir da janela, então o que se testa aqui
 * são as travas: a edição não pode virar criação disfarçada, e a cópia não pode
 * pisar num agent que já existe.
 */

const spec = (mode: ActionMode = "approve", prompt = "revise"): AgentSpec =>
  AgentSpec.parse({
    id: "revisor",
    name: "Revisor",
    steps: [
      { type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt },
      { type: "action", key: "publicar", name: "Publicar", action: "github.review_comment", needs: ["ler"], mode },
    ],
  });

const modo = async (service: AgentService, id: string): Promise<ActionMode | undefined> => {
  const passo = (await service.getLatestVersion(id))?.spec.steps.find((s) => s.key === "publicar");
  return passo?.type === "action" ? passo.mode : undefined;
};

test("editar pela tela grava versão nova com a nota como registro", async () => {
  const service = new AgentService(bancoDeTeste());
  await service.upsert(spec(), "semente", "human");

  const nova = await service.saveEdited("revisor", spec("approve", "revise com cuidado"), "prompt mais rigoroso");

  assert.equal(nova.version, 2);
  assert.equal(nova.note, "prompt mais rigoroso");
});

test("editar pela tela pode subir o modo, porque o clique é de uma pessoa", async () => {
  const service = new AgentService(bancoDeTeste());
  await service.upsert(spec("approve"), "semente", "human");

  const nova = await service.saveEdited("revisor", spec("draft"), "passa a rascunho");

  assert.deepEqual(nova.downgrades, []);
  assert.equal(await modo(service, "revisor"), "draft");
});

test("edição sem nota é recusada, porque versão sem motivo ninguém entende depois", async () => {
  const service = new AgentService(bancoDeTeste());
  await service.upsert(spec(), "semente", "human");

  await assert.rejects(() => service.saveEdited("revisor", spec(), "   "), /diga o que mudou/);
  assert.equal((await service.listVersions("revisor")).length, 1);
});

test("edição com outro id é recusada, e não vira agent novo em silêncio", async () => {
  const service = new AgentService(bancoDeTeste());
  await service.upsert(spec(), "semente", "human");

  const outro = { ...spec(), id: "intruso" };
  await assert.rejects(() => service.saveEdited("revisor", outro, "troquei o id"), /tela editava/);
  assert.equal(await service.get("intruso"), undefined);
});

test("duplicar cria agent novo com o spec do original e mantém o modo da ação", async () => {
  const service = new AgentService(bancoDeTeste());
  await service.upsert(spec("draft"), "semente", "human");

  const copia = await service.duplicate("revisor", "revisor-go", "Revisor de Go");

  assert.equal(copia.agentId, "revisor-go");
  assert.equal(copia.spec.name, "Revisor de Go");
  assert.equal(copia.note, "duplicado de revisor");
  assert.equal(await modo(service, "revisor-go"), "draft");
  assert.equal((await service.listVersions("revisor")).length, 1, "o original não pode mudar");
});

test("duplicar recusa id que já existe", async () => {
  const service = new AgentService(bancoDeTeste());
  await service.upsert(spec(), "semente", "human");

  await assert.rejects(() => service.duplicate("revisor", "revisor", "De novo"), /já existe/);
});

test("duplicar recusa id fora do formato", async () => {
  const service = new AgentService(bancoDeTeste());
  await service.upsert(spec(), "semente", "human");

  for (const ruim of ["Revisor Go", "x", "-comeca-com-hifen", "tem_sublinhado"]) {
    await assert.rejects(() => service.duplicate("revisor", ruim, "Nome"), /minúsculas/, ruim);
  }
});

test("a fila diz os modos de cada ação, perguntando ao handler", async () => {
  const { buildGate } = await import("../src/executor/build.js");
  const porAcao = new Map(buildGate().describe().map((a) => [a.kind, a]));

  // Criar tarefa só aceita aprovação: é card em nome de uma pessoa.
  assert.deepEqual([...porAcao.get("tracker.create_issue")!.modes], ["approve"]);
  // A review aceita os três, mas segura na fila conforme o veredito.
  assert.equal(porAcao.get("github.review_comment")!.holdsByContent, true);
  assert.equal(porAcao.get("github.review_comment")!.modes.length, 3);
});

test("rascunho do Criar com IA nasce em approve, com a descrição na nota, e não pisa em agent existente", async () => {
  const service = new AgentService(bancoDeTeste());

  const nova = await service.saveDraft(spec("auto"), "revisa   PR\nde pagamento");

  assert.equal(nova.version, 1);
  assert.equal(nova.note, "criado com IA: revisa PR de pagamento");
  assert.equal(await modo(service, "revisor"), "approve");
  await assert.rejects(service.saveDraft(spec(), "de novo"), /já existe/);
});
