import { before, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { migrateDb } from "../src/db/migrate.js";
import { CALCULO_DA_TELA_COM_FERRAMENTA } from "../src/mcp-server/paridade.js";
import { buildMcpServer } from "../src/mcp-server/server.js";
import type { GrupoDeReferencias } from "../src/config/referencias.js";

before(() => migrateDb());

async function ligarCliente(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildMcpServer().connect(serverTransport);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

const FLUXO = {
  id: "ref-teste",
  name: "Fluxo",
  model: "ollama/x",
  steps: [
    { type: "model", key: "revisar", name: "Revisar o PR", model: "ollama/x", prompt: "x", outputSchema: { type: "object", properties: { findings: { type: "array", items: { type: "object", properties: { severity: { type: "string" } } } } } } },
    { type: "action", key: "publicar", name: "Publicar", action: "teams.post", mode: "approve", needs: ["revisar"] },
  ],
};

test("list_step_references devolve o catálogo estruturado de um rascunho, com número, nome e caminhos que o executor resolve", async () => {
  const client = await ligarCliente();
  const res = await client.callTool({
    name: "list_step_references",
    arguments: { spec: FLUXO, triggers: [{ kind: "teams-inbox", mentions: false, dms: false, prLinks: true }], stepKey: "publicar" },
  });
  assert.equal(res.isError, undefined, JSON.stringify(res.content));
  const { publicar } = JSON.parse((res.content as { text: string }[])[0]!.text) as { publicar: GrupoDeReferencias[] };
  assert.deepEqual(publicar.map((g) => g.id), ["event", "revisar"]);
  const evento = publicar[0]!.itens.map((i) => i.caminho);
  for (const c of ["event.prOwner", "event.prsTexto", "event.diff", "event.title"]) assert.ok(evento.includes(c), c);
  const revisar = publicar[1]!;
  assert.deepEqual([revisar.numero, revisar.nome], [1, "Revisar o PR"]);
  assert.ok(revisar.itens.some((i) => i.caminho === "steps.revisar.findings.0.severity"));
});

test("a paridade lista a ferramenta que devolve o que a tela calcula", async () => {
  const nomes = new Set((await (await ligarCliente()).listTools()).tools.map((t) => t.name));
  for (const ferramenta of Object.values(CALCULO_DA_TELA_COM_FERRAMENTA)) assert.ok(nomes.has(ferramenta), ferramenta);
});
