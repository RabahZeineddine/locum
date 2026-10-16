import { test } from "node:test";
import assert from "node:assert/strict";
import { resumoDoAgent } from "../renderer/lib/resumo-do-agent.js";

/** O que o painel do passo mostra, só leitura, do agent da biblioteca escolhido. */

const base = { model: "claude-code/claude-sonnet-5", instructions: "", context: "", toolsets: [], tools: [], connections: [] };

test("o modelo sai sem o provedor e as conexões trazem quantas ferramentas ligaram", () => {
  const r = resumoDoAgent({
    ...base,
    connections: [
      { connectionId: "github", tools: { "pulls/get": true, "pulls/list": "read", "issues/create": false } },
      { connectionId: "teams", tools: {} },
    ],
    tools: [{ server: "ms365", tool: "list-chats", class: "read" }],
    toolsets: ["leitura-teams"],
  });
  assert.equal(r.modelo, "claude-sonnet-5");
  assert.deepEqual(r.conexoes, [
    { id: "github", ferramentas: 2 },
    { id: "teams", ferramentas: 0 },
  ]);
  assert.equal(r.avulsas, 1);
  assert.equal(r.toolsets, 1);
});

test("o trecho das instruções corta no limite e avisa que há mais", () => {
  const longo = "a".repeat(400);
  const r = resumoDoAgent({ ...base, instructions: longo });
  assert.equal(r.trecho.length, 281);
  assert.equal(r.trecho.endsWith("…"), true);
  assert.equal(r.temMais, true);
});

test("instrução curta vem inteira, e sem instrução o trecho é vazio", () => {
  const curto = resumoDoAgent({ ...base, instructions: "  Revise o diff.\nCite a linha.  " });
  assert.equal(curto.trecho, "Revise o diff.\nCite a linha.");
  assert.equal(curto.temMais, false);
  assert.equal(resumoDoAgent(base).trecho, "");
});
