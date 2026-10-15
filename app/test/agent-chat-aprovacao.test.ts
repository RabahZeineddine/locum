import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { abrirServidorDeAprovacao, FERRAMENTA_DE_APROVACAO } from "../src/agent-chat/servidor-de-aprovacao.js";

/**
 * A ferramenta de permissão que o Claude Code chama para a escrita: um
 * servidor MCP local, que só aceita quem traz o token da volta.
 */

async function conectar(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

const texto = (r: Awaited<ReturnType<Client["callTool"]>>): string => (r.content as { text: string }[])[0]?.text ?? "";

test("a chamada espera a decisão e devolve o que o Claude Code entende", async () => {
  const pedidos: { nome: string; entrada: unknown }[] = [];
  let liberar: () => void = () => undefined;
  const espera = new Promise<void>((r) => (liberar = r));
  const servidor = await abrirServidorDeAprovacao(async (nome, entrada) => {
    pedidos.push({ nome, entrada });
    await espera;
    return nome.endsWith("echo") ? { permitir: true, entrada } : { permitir: false, mensagem: "A pessoa recusou." };
  });
  const client = await conectar(servidor.url, servidor.token);
  try {
    let respondeu = false;
    const permitida = client
      .callTool({ name: FERRAMENTA_DE_APROVACAO, arguments: { tool_name: "mcp__painel__echo", input: { text: "oi" }, tool_use_id: "t1" } })
      .then((r) => {
        respondeu = true;
        return r;
      });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(respondeu, false, "enquanto ninguém decide, a chamada fica parada");
    liberar();
    assert.deepEqual(JSON.parse(texto(await permitida)), { behavior: "allow", updatedInput: { text: "oi" } });
    assert.deepEqual(pedidos, [{ nome: "mcp__painel__echo", entrada: { text: "oi" } }]);

    const negada = await client.callTool({ name: FERRAMENTA_DE_APROVACAO, arguments: { tool_name: "mcp__painel__drop", input: {} } });
    assert.deepEqual(JSON.parse(texto(negada)), { behavior: "deny", message: "A pessoa recusou." });
  } finally {
    await client.close();
    await servidor.fechar();
  }
});

test("sem o token da volta, o servidor não atende", async () => {
  const servidor = await abrirServidorDeAprovacao(async () => ({ permitir: true, entrada: {} }));
  try {
    const resposta = await fetch(servidor.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer errado" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(resposta.status, 401);
    await assert.rejects(conectar(servidor.url, "errado"));
  } finally {
    await servidor.fechar();
  }
});
