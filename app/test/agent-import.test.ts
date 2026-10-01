import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSpec } from "../src/config/types.js";
import { DIGEST_READING_SCHEMA } from "../src/digest/proposal.js";
import { REPLY_SPECS, slackDigestSpec } from "../src/examples/agents.js";
import { TEAMS_REPLY_SCHEMA } from "../src/teams/action.js";
import { AgentService } from "../src/services/agent-service.js";
import { ExecutionService } from "../src/services/execution-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/**
 * O Locum não traz agent de fábrica: o banco nasce vazio e o primeiro agent
 * entra por importação. Aqui se testam a porta de entrada, a de saída, e que
 * nada roda por padrão num agent que ninguém escolheu.
 */

const EXEMPLOS = fileURLToPath(new URL("../../examples/agents/", import.meta.url));

const spec = (id = "revisor", prompt = "revise") => ({
  id,
  name: "Revisor",
  steps: [{ type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt }],
});

test("todo exemplo em examples/agents é um agent válido", () => {
  const arquivos = readdirSync(EXEMPLOS).filter((n) => n.endsWith(".json"));
  assert.ok(arquivos.length > 0, "a pasta de exemplos não pode ficar vazia");
  for (const nome of arquivos) {
    const lido = AgentSpec.safeParse(JSON.parse(readFileSync(join(EXEMPLOS, nome), "utf8")));
    assert.ok(lido.success, `${nome}: ${lido.success ? "" : lido.error.message}`);
  }
});

test("o exemplo de digest usa o esquema de leitura que o código espera", () => {
  // O esquema foi copiado para o JSON do exemplo. Se o código mudar e o exemplo
  // não, o digest importado passa a devolver leitura que a entrega recusa.
  const leitura = slackDigestSpec.steps.find((s) => s.key === "read");
  assert.ok(leitura?.type === "model");
  assert.deepEqual(leitura.outputSchema, DIGEST_READING_SCHEMA);
});

test("a resposta pronta de cada conversa publica pela ação certa, parada na fila", () => {
  for (const [servico, pronto] of Object.entries(REPLY_SPECS)) {
    const saida = pronto.steps.find((s) => s.type === "action");
    assert.ok(saida?.type === "action", servico);
    assert.equal(saida.action, `${servico}.post`);
    assert.equal(saida.mode, "approve");
  }
  const escrita = REPLY_SPECS.teams.steps.find((s) => s.key === "write");
  assert.ok(escrita?.type === "model");
  assert.deepEqual(escrita.outputSchema, TEAMS_REPLY_SCHEMA);
});

test("importar cria o agent e importar de novo com mudança vira versão nova", async () => {
  const service = new AgentService(bancoDeTeste());

  const primeira = await service.importSpec(JSON.stringify(spec()), "revisor.json");
  assert.equal(primeira.created, true);
  assert.equal(primeira.version.note, "importado de revisor.json");

  const segunda = await service.importSpec(JSON.stringify(spec("revisor", "revise melhor")), "revisor.json");
  assert.equal(segunda.created, false);
  assert.equal(segunda.version.version, 2);
});

test("exportar devolve o que importar lê de volta, sem mudar nada", async () => {
  const service = new AgentService(bancoDeTeste());
  await service.importSpec(JSON.stringify(spec()), "a.json");

  const texto = await service.exportSpec("revisor");
  const outro = new AgentService(bancoDeTeste());
  const { version } = await outro.importSpec(texto, "exportado.json");
  assert.deepEqual(version.spec, (await service.getLatestVersion("revisor"))!.spec);
});

test("arquivo que não é agent é recusado dizendo onde está o problema", async () => {
  const service = new AgentService(bancoDeTeste());

  await assert.rejects(() => service.importSpec("{ não é json", "x.json"), /x\.json não é JSON válido/);
  await assert.rejects(() => service.importSpec(JSON.stringify({ id: "a-b", name: "n" }), "y.json"), /y\.json não é um agent válido: steps/);
  await assert.rejects(() => service.importSpec(JSON.stringify(spec("Com Espaço")), "z.json"), /minúsculas/);
  assert.deepEqual(await service.list(), [], "nada recusado pode ter sido gravado");
});

test("sem agent pedido, roda o único que existe, e com dois pede qual", async () => {
  const db = bancoDeTeste();
  const agents = new AgentService(db);
  const execucao = new ExecutionService(db, agents, async () => {
    throw new Error("não devia chegar a executar");
  });

  await assert.rejects(() => execucao.start({ target: "sintetico" }), /nenhum agent cadastrado/);

  await agents.importSpec(JSON.stringify(spec("um")), "um.json");
  // Com um só, passa da escolha e para no executor de mentira.
  await assert.rejects(() => execucao.start({ target: "sintetico" }), /não devia chegar a executar/);

  await agents.importSpec(JSON.stringify(spec("dois")), "dois.json");
  await assert.rejects(() => execucao.start({ target: "sintetico" }), /diga qual agent roda: (um, dois|dois, um)/);
});
