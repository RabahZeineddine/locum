import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { migrateDb } from "../src/db/migrate.js";
import { buildMcpServer } from "../src/mcp-server/server.js";
import { FERRAMENTA_DO_CANAL } from "../src/mcp-server/paridade.js";
import { agentService } from "../src/services/agent-service.js";
import { libraryService } from "../src/services/library-service.js";

/** O histórico de versões da tela pelo MCP: ler com o spec de cada uma, e restaurar. */

before(() => migrateDb());

async function ligarCliente(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildMcpServer().connect(serverTransport);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

type Resposta = Awaited<ReturnType<Client["callTool"]>>;
const texto = (res: Resposta): string => (res.content as { type: string; text: string }[])[0]?.text ?? "";
function ok<T = unknown>(res: Resposta): T {
  assert.equal(res.isError, undefined, `ferramenta devolveu erro: ${texto(res)}`);
  return JSON.parse(texto(res)) as T;
}
const id = (base: string): string => `${base}-${randomUUID().slice(0, 8)}`;

const spec = (agentId: string, prompt: string) => ({
  id: agentId,
  name: "Versoes",
  steps: [{ type: "model", key: "ler", name: "Ler", model: "anthropic/modelo", prompt }],
});

test("as ferramentas mapeadas para o histórico devolvem o formato do canal, com o spec de cada versão", async () => {
  const client = await ligarCliente();
  const agentId = id("hist");
  await agentService.upsert(spec(agentId, "primeiro") as never, "um", "human");
  await agentService.upsert(spec(agentId, "segundo") as never, "dois", "human");
  const perfil = id("perfil");
  await libraryService.saveProfile({ spec: { id: perfil, name: "P", model: "anthropic/modelo", toolsets: [] } as never, note: "um" });
  await libraryService.saveProfile({ spec: { id: perfil, name: "P2", model: "anthropic/modelo", toolsets: [] } as never, note: "dois" });

  // O canal devolve o que o serviço devolve; a ferramenta mapeada tem de ser igual, versão por versão.
  const daTela = JSON.parse(JSON.stringify(await agentService.listVersions(agentId)));
  const daFerramenta = ok(await client.callTool({ name: FERRAMENTA_DO_CANAL["agents.versions"]!, arguments: { agentId } }));
  assert.deepEqual(daFerramenta, daTela);
  assert.equal((daFerramenta as { spec: unknown }[]).length, 2);

  const perfisDaTela = JSON.parse(JSON.stringify(await libraryService.listProfileVersions(perfil)));
  const perfisDaFerramenta = ok(await client.callTool({ name: FERRAMENTA_DO_CANAL["library.profileVersions"]!, arguments: { id: perfil } }));
  assert.deepEqual(perfisDaFerramenta, perfisDaTela);
  assert.equal((perfisDaFerramenta as { spec: { name: string } }[])[1]!.spec.name, "P");
});

test("restaurar uma versão grava uma versão nova com o spec dela", async () => {
  const client = await ligarCliente();
  const agentId = id("rest");
  await agentService.upsert(spec(agentId, "primeiro") as never, "um", "human");
  await agentService.upsert(spec(agentId, "segundo") as never, "dois", "human");

  const nova = ok<{ agentId: string; version: number; note: string }>(await client.callTool({ name: "restore_agent_version", arguments: { agentId, version: 1 } }));
  assert.equal(nova.version, 3);
  assert.match(nova.note, /versão 1/);
  assert.equal((await agentService.getLatestVersion(agentId))!.spec.steps[0] && ((await agentService.getLatestVersion(agentId))!.spec.steps[0] as { prompt: string }).prompt, "primeiro");
  const res = await client.callTool({ name: "restore_agent_version", arguments: { agentId, version: 99 } });
  assert.equal(res.isError, true);

  const perfil = id("rperfil");
  await libraryService.saveProfile({ spec: { id: perfil, name: "Antigo", model: "anthropic/modelo", toolsets: [] } as never });
  await libraryService.saveProfile({ spec: { id: perfil, name: "Novo", model: "anthropic/modelo", toolsets: [] } as never });
  const volta = ok<{ id: string; version: number }>(await client.callTool({ name: "restore_library_agent_version", arguments: { id: perfil, version: 1 } }));
  assert.equal(volta.version, 3);
  assert.equal((await libraryService.getProfile(perfil))!.spec.name, "Antigo");
});

test("restaurar versão sobrescreve a atual: vem anotada como destrutiva, e a leitura como leitura", async () => {
  const client = await ligarCliente();
  const por = new Map((await client.listTools()).tools.map((t) => [t.name, t.annotations]));
  for (const nome of ["restore_agent_version", "restore_library_agent_version"]) {
    assert.equal(por.get(nome)?.destructiveHint, true, nome);
  }
  for (const nome of ["list_agent_versions", "list_library_agent_versions"]) assert.equal(por.get(nome)?.readOnlyHint, true, nome);
});

test("o --mcp não tem o terminal do Locum: com ele preferido usa o do sistema e avisa", async () => {
  const { terminalDeFora } = await import("../src/mcp-server/session-tools.js");
  assert.deepEqual(terminalDeFora(undefined, "iterm"), { terminal: "iterm" });
  assert.deepEqual(terminalDeFora("warp", "locum"), { terminal: "warp" });
  const sem = terminalDeFora(undefined, "locum");
  assert.equal(sem.terminal, "terminal");
  assert.match(sem.aviso ?? "", /do Locum/);
});
