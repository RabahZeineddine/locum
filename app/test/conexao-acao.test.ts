import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acaoDeLigar,
  avisoDoEnderecoDoOllama,
  destinoDeConexaoAntiga,
} from "../renderer/lib/conexao-acao.js";

const conexao = (extra: Partial<Parameters<typeof acaoDeLigar>[0]> = {}) => ({
  kind: "oauth" as const,
  custom: false,
  state: "available" as const,
  servers: [] as string[],
  ...extra,
});

test("serviço OAuth conectado pelo servidor MCP oferece desconectar", () => {
  assert.equal(acaoDeLigar(conexao({ state: "connected", servers: ["notion"] })), "disconnect");
});

test("sem servidor MCP cadastrado nunca se oferece desconectar, mesmo conectado por tracker", () => {
  assert.equal(acaoDeLigar(conexao({ state: "connected", servers: [] })), "connect");
});

test("servidor cadastrado que pede atenção oferece reconectar, e o que não existe ainda, conectar", () => {
  assert.equal(acaoDeLigar(conexao({ state: "attention", servers: ["linear"] })), "reconnect");
  assert.equal(acaoDeLigar(conexao({ state: "error", servers: ["linear"] })), "reconnect");
  assert.equal(acaoDeLigar(conexao({ state: "available" })), "connect");
});

test("conexão que não liga por um clique não tem ação principal", () => {
  assert.equal(acaoDeLigar(conexao({ kind: "panel" })), null);
  assert.equal(acaoDeLigar(conexao({ custom: true, servers: ["casa"] })), null);
});

test("id antigo de tracker cai na conexão dona dele, e id desconhecido na lista", () => {
  const trackers = [
    { id: "meu-jira", kind: "jira" },
    { id: "github-issues", kind: "github-issues" },
    { id: "sc", kind: "shortcut" },
  ];
  assert.deepEqual(destinoDeConexaoAntiga("meu-jira", trackers), { rota: "connections", detalhe: "atlassian" });
  assert.deepEqual(destinoDeConexaoAntiga("github-issues", trackers), { rota: "connections", detalhe: "github" });
  assert.deepEqual(destinoDeConexaoAntiga("sc", trackers), { rota: "connections", detalhe: "shortcut" });
  assert.deepEqual(destinoDeConexaoAntiga("nao-sei", trackers), { rota: "connections" });
});

test("claude-code e opencode antigos caem na Configuração, onde moram agora", () => {
  assert.deepEqual(destinoDeConexaoAntiga("claude-code", []), { rota: "settings", detalhe: "tools" });
  assert.deepEqual(destinoDeConexaoAntiga("opencode", []), { rota: "settings", detalhe: "tools" });
});

test("endereço do Ollama: inválido, sem /v1 e certo", () => {
  assert.equal(avisoDoEnderecoDoOllama("ollama.local"), "invalid");
  assert.equal(avisoDoEnderecoDoOllama("ftp://x/v1"), "invalid");
  assert.equal(avisoDoEnderecoDoOllama("http://127.0.0.1:11434"), "noV1");
  assert.equal(avisoDoEnderecoDoOllama("http://127.0.0.1:11434/api"), "noV1");
  assert.equal(avisoDoEnderecoDoOllama("http://127.0.0.1:11434/v1"), null);
  assert.equal(avisoDoEnderecoDoOllama("http://127.0.0.1:11434/v1/"), null);
  assert.equal(avisoDoEnderecoDoOllama("  "), null);
});
