import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ToolRef } from "../src/config/types.js";
import { consultarAgent, SERVIDOR_NATIVO, type ConsultaDeps } from "../src/native-tools/ask.js";
import { comandoDoApp, decidirRegistro, esteEOInstalado, type AmbienteDoApp } from "../src/native-tools/comando-do-locum.js";
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
          spec: { id, name: id, description: "", context: "", instructions: "", model: "anthropic/x", temperature: 0.1, toolsets: [], tools: ferramentas, connections: [], skills: [], budget: {}, maxSteps: 4 },
        },
        tools: ferramentas,
        confirmar: [],
        semServidor: [],
        fixas: [],
        grupos: [],
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

/** Uma máquina com ou sem o app instalado, e um processo rodando de onde se disser. */
function maquina(opcoes: { execPath: string; empacotado?: boolean; existentes?: string[] }): AmbienteDoApp {
  const existentes = new Set(opcoes.existentes ?? []);
  return {
    execPath: opcoes.execPath,
    empacotado: opcoes.empacotado ?? true,
    script: "/dev/main.cjs",
    home: "/Users/ana",
    plataforma: "darwin",
    existe: (c) => existentes.has(c),
  };
}

const INSTALADO = "/Applications/Locum.app/Contents/MacOS/Locum";
const WORKTREE = "/Users/ana/.worktrees/locum-dock/app/release/mac-arm64/Locum.app/Contents/MacOS/Locum";

test("decisão: o app instalado corrige registro que aponta para binário que sumiu ou para cópia", () => {
  const instalado = maquina({ execPath: INSTALADO, existentes: [INSTALADO, WORKTREE] });
  const certo = [INSTALADO, "--ferramentas"];

  assert.deepEqual(decidirRegistro(instalado, certo, "--ferramentas"), { acao: "manter" });
  const sumiu = decidirRegistro(instalado, ["/tmp/apagado/Locum", "--ferramentas"], "--ferramentas");
  assert.equal(sumiu.acao, "gravar");
  assert.deepEqual(sumiu.acao === "gravar" ? sumiu.comando : null, certo);
  // O worktree ainda existe, mas não é o app instalado.
  const copia = decidirRegistro(instalado, [WORKTREE, "--ferramentas"], "--ferramentas");
  assert.equal(copia.acao, "gravar");
  assert.deepEqual(decidirRegistro(instalado, null, "--ferramentas"), { acao: "gravar", comando: certo, motivo: "sem-registro" });
});

test("decisão: cópia fora de /Applications não reescreve registro que funciona", () => {
  const copia = maquina({ execPath: WORKTREE, existentes: [WORKTREE, "/Users/ana/Outro/Locum"] });
  // Sem app instalado na máquina, o registro de outro lugar que existe fica.
  assert.deepEqual(decidirRegistro(copia, ["/Users/ana/Outro/Locum", "--ferramentas"], "--ferramentas"), { acao: "manter" });
  // E o dela mesma também.
  assert.deepEqual(decidirRegistro(copia, [WORKTREE, "--ferramentas"], "--ferramentas"), { acao: "manter" });
});

test("decisão: cópia solta, mesmo com o app instalado na máquina, nunca mexe em registro que existe", () => {
  const copia = maquina({ execPath: WORKTREE, existentes: [WORKTREE, INSTALADO] });
  assert.deepEqual(decidirRegistro(copia, [WORKTREE, "--ferramentas"], "--ferramentas"), { acao: "manter" });
  assert.deepEqual(decidirRegistro(copia, ["/tmp/sumiu/Locum", "--ferramentas"], "--ferramentas"), { acao: "manter" });
  assert.deepEqual(decidirRegistro(copia, [INSTALADO, "--ferramentas"], "--ferramentas"), { acao: "manter" });
});

test("decisão: o locum-ferramentas de uma cópia solta, sem registro, aponta para a própria cópia e não para o instalado", () => {
  const copia = maquina({ execPath: WORKTREE, existentes: [WORKTREE, INSTALADO] });
  const d = decidirRegistro(copia, null, "--ferramentas");
  assert.deepEqual(d.acao === "gravar" ? d.comando : null, [WORKTREE, "--ferramentas"]);
  const dev = maquina({ execPath: "/usr/bin/electron", empacotado: false, existentes: [INSTALADO] });
  const e = decidirRegistro(dev, null, "--ferramentas");
  assert.deepEqual(e.acao === "gravar" ? e.comando : null, ["/usr/bin/electron", "/dev/main.cjs", "--ferramentas"]);
});

test("decisão: cópia de DMG ou em quarentena não conta como o app instalado e não corrige nada", () => {
  for (const caminho of ["/Volumes/Locum/Locum.app/Contents/MacOS/Locum", "/private/var/folders/x/AppTranslocation/ABC/d/Locum.app/Contents/MacOS/Locum"]) {
    const env = maquina({ execPath: caminho, existentes: [caminho] });
    assert.equal(esteEOInstalado(env), false);
    assert.deepEqual(decidirRegistro(env, [INSTALADO, "--ferramentas"], "--ferramentas"), { acao: "manter" });
    assert.deepEqual(decidirRegistro(env, ["/tmp/sumiu/Locum", "--ferramentas"], "--ferramentas"), { acao: "manter" });
  }
});

test("decisão: sem app instalado e sem registro, a cópia registra a si mesma; em desenvolvimento leva o script", () => {
  const dev = maquina({ execPath: "/usr/bin/electron", empacotado: false });
  const d = decidirRegistro(dev, null, "--mcp");
  assert.deepEqual(d.acao === "gravar" ? d.comando : null, ["/usr/bin/electron", "/dev/main.cjs", "--mcp"]);
  assert.deepEqual(decidirRegistro(dev, ["/qualquer/Locum", "--mcp"], "--mcp"), { acao: "manter" });
});

test("o comando que o Locum oferece ao Claude Code é o do app instalado, mesmo vindo de uma cópia", () => {
  const copia = maquina({ execPath: WORKTREE, existentes: [WORKTREE, INSTALADO] });
  assert.deepEqual(comandoDoApp(copia, "--mcp"), [INSTALADO, "--mcp"]);
  assert.deepEqual(comandoDoApp(maquina({ execPath: INSTALADO, existentes: [INSTALADO] }), "--mcp"), [INSTALADO, "--mcp"]);
});

test("cadastro nasce ligado, segue o app instalado e respeita quem desligou", async () => {
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
  const app = maquina({ execPath: INSTALADO, existentes: [INSTALADO] });
  await cadastrarFerramentasNativas(app, servico);
  await cadastrarFerramentasNativas(app, servico);
  // A cópia de um worktree abre, com o registro bom ou quebrado: nada muda.
  await cadastrarFerramentasNativas(maquina({ execPath: WORKTREE, existentes: [WORKTREE, INSTALADO] }), servico);
  const bom = atual;
  atual = { config: { transport: "stdio", command: ["/tmp/sumiu/Locum", "--ferramentas"], scope: "read" } };
  await cadastrarFerramentasNativas(maquina({ execPath: WORKTREE, existentes: [WORKTREE, INSTALADO] }), servico);
  atual = bom;
  // O registro foi parar numa cópia que sumiu: o app instalado conserta.
  atual = { config: { transport: "stdio", command: ["/tmp/sumiu/Locum", "--ferramentas"], scope: "read" } };
  await cadastrarFerramentasNativas(app, servico);
  assert.deepEqual(chamadas, [`register ${INSTALADO} --ferramentas`, "enabled true", `register ${INSTALADO} --ferramentas`]);
});
