import { before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { migrateDb } from "../src/db/migrate.js";
import { buildMcpServer } from "../src/mcp-server/server.js";
import { libraryService } from "../src/services/library-service.js";

/** A área de Skills pelo MCP: o mesmo que a tela faz, com a anotação certa em cada ferramenta. */

const claude = mkdtempSync(join(tmpdir(), "locum-mcp-claude-"));
before(() => {
  migrateDb();
  process.env.LOCUM_CLAUDE_DIR = claude;
  mkdirSync(join(claude, "skills", "da-maquina"), { recursive: true });
  writeFileSync(join(claude, "skills", "da-maquina", "SKILL.md"), "---\nname: da-maquina\ndescription: vem de ~/.claude\n---\nCorpo");
});

async function cliente(): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildMcpServer().connect(b);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(a);
  return client;
}

const json = async <T>(chamada: Promise<unknown>): Promise<T> => {
  const res = (await chamada) as { isError?: boolean; content: { text: string }[] };
  assert.equal(res.isError, undefined, res.content[0]?.text);
  return JSON.parse(res.content[0]!.text) as T;
};

test("cada ferramenta de skill diz o que faz: leitura, escrita e a remoção como perigosa", async () => {
  const client = await cliente();
  const por = new Map((await client.listTools()).tools.map((t) => [t.name, t.annotations]));
  for (const nome of ["list_skills", "get_skill"]) assert.equal(por.get(nome)?.readOnlyHint, true, nome);
  for (const nome of ["create_skill", "import_skill", "add_skill_to_agent"]) {
    assert.equal(por.get(nome)?.readOnlyHint, false, nome);
    assert.equal(por.get(nome)?.destructiveHint, false, nome);
  }
  assert.equal(por.get("remove_skill")?.destructiveHint, true);
  assert.equal(por.get("update_skill")?.destructiveHint, true, "substitui o arquivo inteiro");
});

test("criar, ler, editar, usar num agent e remover uma skill do Locum", async () => {
  const client = await cliente();
  await json(client.callTool({ name: "create_skill", arguments: { name: "pelo-mcp", description: "Criada pelo MCP", body: "Passo um." } }));
  const lida = await json<{ corpo: string; fonte: { tipo: string }; editavel: boolean }>(client.callTool({ name: "get_skill", arguments: { name: "pelo-mcp" } }));
  assert.equal(lida.fonte.tipo, "locum");
  assert.equal(lida.editavel, true);
  assert.match(lida.corpo, /Passo um\./);

  await json(client.callTool({ name: "update_skill", arguments: { name: "pelo-mcp", description: "Editada", body: "Passo dois." } }));
  assert.match((await json<{ corpo: string }>(client.callTool({ name: "get_skill", arguments: { name: "pelo-mcp" } }))).corpo, /Passo dois\./);

  await libraryService.saveProfile({ spec: { id: "usa-skill", name: "Usa", model: "anthropic/claude-sonnet-5" } });
  const somada = await json<{ added: boolean; version: number }>(client.callTool({ name: "add_skill_to_agent", arguments: { agentId: "usa-skill", skill: "pelo-mcp" } }));
  assert.equal(somada.added, true);
  assert.equal((await json<{ added: boolean }>(client.callTool({ name: "add_skill_to_agent", arguments: { agentId: "usa-skill", skill: "pelo-mcp" } }))).added, false);
  assert.deepEqual((await libraryService.getProfile("usa-skill"))?.spec.skills.map((k) => k.skill), ["pelo-mcp"]);

  const lista = await json<{ name: string; agents: { id: string }[] }[]>(client.callTool({ name: "list_skills", arguments: {} }));
  assert.deepEqual(lista.find((s) => s.name === "pelo-mcp")?.agents.map((a) => a.id), ["usa-skill"]);

  const removida = await json<{ agents: { id: string }[] }>(client.callTool({ name: "remove_skill", arguments: { name: "pelo-mcp" } }));
  assert.deepEqual(removida.agents.map((a) => a.id), ["usa-skill"]);
});

test("skill da máquina aparece com a origem, e não se edita nem se remove", async () => {
  const client = await cliente();
  const lista = await json<{ name: string; fonte: { tipo: string } }[]>(client.callTool({ name: "list_skills", arguments: { refresh: true } }));
  assert.equal(lista.find((s) => s.name === "da-maquina")?.fonte.tipo, "minhas");
  const recusa = (await client.callTool({ name: "update_skill", arguments: { name: "da-maquina", description: "x", body: "y" } })) as { isError?: boolean };
  assert.equal(recusa.isError, true);
});

test("importar pelo caminho copia para o Locum", async () => {
  const client = await cliente();
  const arquivo = join(claude, "solta-no-disco.md");
  writeFileSync(arquivo, "---\nname: importada-mcp\ndescription: Veio de um arquivo\n---\nCorpo importado");
  const importada = await json<{ fonte: { tipo: string } }>(client.callTool({ name: "import_skill", arguments: { path: arquivo } }));
  assert.equal(importada.fonte.tipo, "locum");
  await json(client.callTool({ name: "remove_skill", arguments: { name: "importada-mcp" } }));
});

test("skill da pasta do projeto aparece no MCP, mas não entra num agent da biblioteca", async () => {
  const repo = mkdtempSync(join(tmpdir(), "locum-mcp-repo-"));
  mkdirSync(join(repo, ".claude", "skills", "do-repo"), { recursive: true });
  writeFileSync(join(repo, ".claude", "skills", "do-repo", "SKILL.md"), "---\nname: do-repo\ndescription: do repo\n---\nCorpo");
  const antes = process.cwd();
  process.chdir(repo);
  try {
    const client = await cliente();
    const lista = await json<{ name: string; fonte: { tipo: string } }[]>(client.callTool({ name: "list_skills", arguments: { refresh: true } }));
    assert.equal(lista.find((s) => s.name === "do-repo")?.fonte.tipo, "projeto");
    await libraryService.saveProfile({ spec: { id: "sem-projeto", name: "Sem projeto", model: "anthropic/claude-sonnet-5" } });
    const recusa = (await client.callTool({ name: "add_skill_to_agent", arguments: { agentId: "sem-projeto", skill: "do-repo" } })) as { isError?: boolean; content: { text: string }[] };
    assert.equal(recusa.isError, true);
    assert.match(recusa.content[0]!.text, /pasta do projeto/);
    assert.deepEqual((await libraryService.getProfile("sem-projeto"))?.spec.skills, []);
  } finally {
    process.chdir(antes);
  }
});

test("update_skill e remove_skill recusam nome com caminho", async () => {
  const client = await cliente();
  const alheia = join(claude, "skills", "da-maquina", "SKILL.md");
  for (const name of ["../../../skills/da-maquina", "../skills/da-maquina"]) {
    const a = (await client.callTool({ name: "update_skill", arguments: { name, description: "x", body: "invadida" } })) as { isError?: boolean };
    const b = (await client.callTool({ name: "remove_skill", arguments: { name } })) as { isError?: boolean };
    assert.equal(a.isError, true);
    assert.equal(b.isError, true);
  }
  assert.match(readFileSync(alheia, "utf8"), /^---\nname: da-maquina/);
});
