import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { rodarPelaAssinatura } from "../src/agent-chat/assinatura.js";
import type { FerramentaLocal } from "../src/agent-chat/nucleo.js";
import { abrirServidorLocal, SERVIDOR_LOCAL } from "../src/agent-chat/servidor-local.js";

/** As ferramentas da conversa do run também chegam ao Claude Code, por um servidor MCP local com token. */

const eco: FerramentaLocal = {
  nome: "eco",
  descricao: "devolve o que recebeu",
  entrada: { texto: z.string() },
  executar: async ({ texto }) => `eco: ${texto as string}`,
};
const quebra: FerramentaLocal = { nome: "quebra", descricao: "falha", entrada: {}, executar: async () => Promise.reject(new Error("recusado: arquivada")) };

const texto = (r: Awaited<ReturnType<Client["callTool"]>>): string => (r.content as { text: string }[])[0]?.text ?? "";

test("o servidor local serve as ferramentas com o token, e o erro volta como erro da ferramenta", async () => {
  const servidor = await abrirServidorLocal([eco, quebra], new AbortController().signal);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(servidor.url), { requestInit: { headers: { Authorization: `Bearer ${servidor.token}` } } }));
  try {
    assert.equal(texto(await client.callTool({ name: "eco", arguments: { texto: "oi" } })), "eco: oi");
    const erro = await client.callTool({ name: "quebra", arguments: {} });
    assert.equal(erro.isError, true);
    assert.equal(texto(erro), "recusado: arquivada");
    const sem = await fetch(servidor.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer errado" }, body: "{}" });
    assert.equal(sem.status, 401);
  } finally {
    await client.close();
    await servidor.fechar();
  }
});

test("pela assinatura, as ferramentas locais entram liberadas e o servidor local sobe na configuração", async () => {
  let args: string[] = [];
  let configuracao = "";
  await rodarPelaAssinatura(
    { texto: "x", modelo: "sonnet", system: "", sessao: undefined, leitura: [], confirmar: [], locais: [eco], maxSteps: 5, aprovar: async () => ({ permitir: false, mensagem: "" }), emitir: () => undefined, sinal: new AbortController().signal },
    {
      binario: async () => "/bin/claude",
      configs: async () => [],
      mensagemSemClaude: "sem claude",
      abrir: (_comando, a) => {
        args = a;
        configuracao = readFileSync(a[a.indexOf("--mcp-config") + 1]!, "utf8");
        return {
          linhas: (async function* () {
            yield JSON.stringify({ type: "result", subtype: "success", session_id: "s1", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
          })(),
          encerrar: () => undefined,
          saida: Promise.resolve(0),
        };
      },
    },
  );
  assert.equal(args[args.indexOf("--allowedTools") + 1], `mcp__${SERVIDOR_LOCAL}__eco`);
  const mcp = (JSON.parse(configuracao) as { mcpServers: Record<string, { type?: string; headers?: Record<string, string> }> }).mcpServers;
  assert.deepEqual(Object.keys(mcp).sort(), ["locum-aprovacao", SERVIDOR_LOCAL]);
  assert.match(mcp[SERVIDOR_LOCAL]?.headers?.Authorization ?? "", /^Bearer /);
  assert.ok(!args.join(" ").includes(mcp[SERVIDOR_LOCAL]!.headers!.Authorization!), "o token vai por arquivo, não pela linha de comando");
});
