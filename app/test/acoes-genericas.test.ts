import { test } from "node:test";
import assert from "node:assert/strict";
import { httpRequestHandler, mcpCallHandler } from "../src/actions/generic.js";
import { renderParams } from "../src/executor/executor.js";

/** As ações genéricas: chamar ferramenta de app e chamar API, com a configuração por template. */

const evento = { repo: "slack/C1", changedFiles: [], channel: "C1", ts: "1.2", text: "oi" };
const saidas = new Map<string, unknown>([["analisar", { titulo: "Bug no login", prioridade: 2, tags: ["a"] }]]);

test("marcador sozinho devolve o valor cru, e marcador no meio do texto vira texto", () => {
  const params = {
    server: "slack",
    args: {
      channel: "{{event.channel}}",
      prioridade: "{{steps.analisar.prioridade}}",
      tudo: "{{steps.analisar}}",
      texto: "Abri: {{steps.analisar.titulo}} ({{event.ts}})",
      lista: ["{{steps.analisar.tags}}", 3],
      falta: "{{steps.nada.x}}",
    },
  };
  assert.deepEqual(renderParams(params, evento, saidas), {
    server: "slack",
    args: {
      channel: "C1",
      prioridade: 2,
      tudo: { titulo: "Bug no login", prioridade: 2, tags: ["a"] },
      texto: "Abri: Bug no login (1.2)",
      lista: [["a"], 3],
      falta: null,
    },
  });
});

test("mcp.call grava só servidor, ferramenta e argumentos, e chama com eles", async () => {
  const chamadas: unknown[] = [];
  const handler = mcpCallHandler({ call: async (...a) => void chamadas.push(a) });
  const proposta = await handler.propose!({ repo: "x", text: "do evento", server: "slack", tool: "react", args: { name: "eyes" } }, null);
  assert.deepEqual(proposta, { server: "slack", tool: "react", args: { name: "eyes" } });
  await handler.publish(proposta, "ext");
  assert.deepEqual(chamadas, [["slack", "react", { name: "eyes" }]]);
});

test("mcp.call sem ferramenta é recusado na proposta, e resposta com isError falha a publicação", async () => {
  const handler = mcpCallHandler({ call: async () => ({ isError: true, content: [{ type: "text", text: "canal arquivado" }] }) });
  await assert.rejects(handler.propose!({ server: "slack" }, null), /escolha a ferramenta/);
  await assert.rejects(handler.publish({ server: "slack", tool: "post", args: {} }, "ext"), /canal arquivado/);
});

test("http.request manda JSON com content-type e falha fora de 2xx", async () => {
  const pedidos: { url: string; init: RequestInit }[] = [];
  let status = 201;
  const fetchFalso = (async (url: string, init: RequestInit) => {
    pedidos.push({ url, init });
    return new Response("negado", { status });
  }) as unknown as typeof fetch;
  const handler = httpRequestHandler({ fetch: fetchFalso });
  const proposta = await handler.propose!({ url: "https://api.exemplo.com/x", method: "POST", body: { a: 1 }, repo: "y" }, null);
  await handler.publish(proposta, "ext");
  assert.equal(pedidos[0]!.init.body, '{"a":1}');
  assert.equal((pedidos[0]!.init.headers as Record<string, string>)["content-type"], "application/json");

  status = 403;
  await assert.rejects(handler.publish(proposta, "ext"), /respondeu 403: negado/);
  await assert.rejects(handler.propose!({ url: "file:///etc/passwd" }, null), /http/);
});
