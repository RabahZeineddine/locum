import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolRef } from "../src/config/types.js";
import { consultarAgent, SERVIDOR_NATIVO, type ConsultaDeps } from "../src/native-tools/ask.js";
import { cadastrarFerramentasNativas } from "../src/native-tools/register.js";
import { buildNativeToolsServer } from "../src/native-tools/server.js";
import { httpGet, jsonQuery, LIMITE_DO_CORPO } from "../src/native-tools/tools.js";
import type { RuntimeRequest } from "../src/runtimes/types.js";

/** O `locum-ferramentas`: ler endereço, consultar JSON e perguntar a outro agent. */

const fetchQueResponde = (corpo: string, contentType: string, status = 200) =>
  (async () => new Response(corpo, { status, headers: { "content-type": contentType } })) as unknown as typeof fetch;

test("http_get lê JSON já interpretado, corta corpo grande e recusa outro protocolo", async () => {
  const json = await httpGet("https://api.exemplo.com/x", {}, fetchQueResponde('{"ok":true}', "application/json"));
  assert.deepEqual(json, { status: 200, contentType: "application/json", truncated: false, json: { ok: true } });

  const grande = await httpGet("http://exemplo.com", {}, fetchQueResponde("a".repeat(LIMITE_DO_CORPO + 10), "text/html"));
  assert.equal(grande.truncated, true);
  assert.equal(grande.text?.length, LIMITE_DO_CORPO);

  await assert.rejects(httpGet("file:///etc/passwd"), /só http e https/);
});

test("http_get com caminho devolve só o pedaço, mesmo de corpo maior que o teto", async () => {
  const corpo = JSON.stringify({ periods: [{ start: "2026-09-28", total: 7 }], lixo: "x".repeat(LIMITE_DO_CORPO + 10) });
  const recorte = await httpGet("https://api.exemplo.com/x", {}, fetchQueResponde(corpo, "application/json"), "periods[0]");
  assert.deepEqual(recorte, { status: 200, contentType: "application/json", json: { start: "2026-09-28", total: 7 }, truncated: false });
  const nada = await httpGet("https://api.exemplo.com/x", {}, fetchQueResponde(corpo, "application/json"), "nao.existe");
  assert.equal(nada.json, null);
});

test("json_query segue o caminho, aceita texto com cerca e devolve null no que falta", () => {
  const dado = { itens: [{ nome: "a" }, { nome: "b" }], total: 2 };
  assert.equal(jsonQuery(dado, "itens[1].nome"), "b");
  assert.equal(jsonQuery('```json\n{"a":{"b":3}}\n```', "a.b"), 3);
  assert.equal(jsonQuery(dado, "itens[5].nome"), null);
  assert.deepEqual(jsonQuery(dado), dado);
  assert.throws(() => jsonQuery("não é json", "a"), /não é JSON/);
});

function depsDaConsulta(pedidos: RuntimeRequest[], gastos: unknown[], ferramentas: ToolRef[]): ConsultaDeps {
  return {
    library: {
      resolveProfile: async (id: string) => ({
        version: {
          id: "v",
          profileId: id,
          version: 3,
          note: null,
          createdAt: 0,
          spec: { id, name: id, description: "", context: "", instructions: "", model: "anthropic/x", temperature: 0.1, toolsets: [], tools: ferramentas, maxSteps: 4 },
        },
        tools: ferramentas,
        system: "Você é o agent de chamados.",
      }),
    },
    fallbacks: async () => [],
    build: async () => ({
      mcp: { toolsFor: async (refs: ToolRef[]) => ({ tools: Object.fromEntries(refs.map((r) => [`${r.server}__${r.tool}`, {} as never])), release: () => {} }) },
      runtimes: new Map([
        [
          "native",
          {
            id: "native",
            run: async (req: RuntimeRequest) => {
              pedidos.push(req);
              return { text: "resposta do agent", promptTokens: 10, completionTokens: 5, costUsd: 0.01, billable: true, toolsUsed: [] };
            },
          },
        ],
      ]),
    }),
    spend: async (...a) => void gastos.push(a),
  };
}

test("ask_agent roda o agent sem a própria consulta e registra o gasto no nome dele", async () => {
  const anterior = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "chave-de-teste";
  try {
    const pedidos: RuntimeRequest[] = [];
    const gastos: unknown[] = [];
    const ferramentas: ToolRef[] = [
      { server: SERVIDOR_NATIVO, tool: "http_get", class: "read" },
      { server: SERVIDOR_NATIVO, tool: "ask_agent", class: "read" },
    ];
    const resposta = await consultarAgent("chamados", "o login caiu?", depsDaConsulta(pedidos, gastos, ferramentas));

    assert.equal(resposta.answer, "resposta do agent");
    assert.equal(resposta.version, 3);
    assert.deepEqual(Object.keys(pedidos[0]!.tools), [`${SERVIDOR_NATIVO}__http_get`]);
    assert.equal(pedidos[0]!.temperature, 0.1);
    assert.equal(pedidos[0]!.system, "Você é o agent de chamados.");
    assert.deepEqual(gastos, [["biblioteca:chamados", { usd: 0.01, tokens: 15 }, true]]);
    await assert.rejects(consultarAgent("chamados", "  ", depsDaConsulta([], [], [])), /o que perguntar/);
  } finally {
    if (anterior === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = anterior;
  }
});

test("o servidor expõe as quatro ferramentas, só de leitura", async () => {
  const [cliente, servidor] = InMemoryTransport.createLinkedPair();
  await buildNativeToolsServer({ fetch: fetchQueResponde("oi", "text/plain"), consulta: depsDaConsulta([], [], []) }).connect(servidor);
  const client = new Client({ name: "teste", version: "0" });
  await client.connect(cliente);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["ask_agent", "business_hours", "http_get", "json_query"]);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));

  const res = await client.callTool({ name: "json_query", arguments: { json: { a: [1, 2] }, path: "a[1]" } });
  assert.equal((res.content as { text: string }[])[0]!.text, "2");

  const horas = await client.callTool({
    name: "business_hours",
    arguments: { items: [{ id: "a", since: "2026-10-12T12:00:00Z" }], now: "2026-10-12T17:00:00Z" },
  });
  assert.deepEqual(JSON.parse((horas.content as { text: string }[])[0]!.text), { results: [{ id: "a", hours: 5, band: "p1" }] });

  const recusa = await client.callTool({
    name: "business_hours",
    arguments: { items: [], window: { start: "09:00", end: "18:00", days: [1], timeZone: "Marte/Olimpo" } },
  });
  assert.equal(recusa.isError, true);
});

test("cadastro nasce ligado, segue o app quando muda de lugar e respeita quem desligou", async () => {
  const chamadas: string[] = [];
  let atual: { config: { transport: string; command?: string[]; scope: string } } | undefined;
  const servico = {
    get: async () => atual as never,
    register: async (c: { command?: string[] }) => {
      chamadas.push(`register ${c.command!.join(" ")}`);
      atual = { config: { transport: "stdio", command: c.command, scope: "read" } };
      return atual as never;
    },
    setEnabled: async (_n: string, e: boolean) => void chamadas.push(`enabled ${e}`),
  };
  await cadastrarFerramentasNativas(["/a/Locum", "--ferramentas"], servico);
  await cadastrarFerramentasNativas(["/a/Locum", "--ferramentas"], servico);
  await cadastrarFerramentasNativas(["/b/Locum", "--ferramentas"], servico);
  assert.deepEqual(chamadas, ["register /a/Locum --ferramentas", "enabled true", "register /b/Locum --ferramentas"]);
});
