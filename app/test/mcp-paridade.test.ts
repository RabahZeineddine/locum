import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BRIDGE_CHANNELS } from "../electron/bridge-contract.js";
import { migrateDb } from "../src/db/migrate.js";
import type { Ambiente } from "../src/mcp-server/ambiente.js";
import { CANAIS_SEM_FERRAMENTA, FERRAMENTA_DO_CANAL, semFerramenta } from "../src/mcp-server/paridade.js";
import { buildMcpServer } from "../src/mcp-server/server.js";
import { exigirAnotacoes } from "../src/mcp-server/tool-def.js";
import { secretService } from "../src/services/secret-service.js";

/** A tela inteira pelo MCP: cada canal da ponte tem ferramenta, e cada ferramenta diz o que faz. */

before(() => migrateDb());

/** Nada sai da máquina nem lê a pasta do Claude Code de verdade. */
const FORA: Partial<Ambiente> = {
  teamsChats: async () => [],
  teamsChannels: async () => [],
  sessions: async () => [],
  systemLocale: () => "pt-BR",
  appVersion: () => "0.0.0-teste",
  decidir: async () => ({ status: "rejected" }),
  resolverEstancada: async () => ({ status: "pending" }),
};

async function ligarCliente(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(FORA).connect(serverTransport);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

type Resposta = Awaited<ReturnType<Client["callTool"]>>;
const texto = (res: Resposta): string => (res.content as { type: string; text: string }[])[0]?.text ?? "";

function ok(res: Resposta): string {
  assert.equal(res.isError, undefined, `ferramenta devolveu erro: ${texto(res)}`);
  return texto(res);
}

test("cada canal da tela tem ferramenta no MCP, ou está nas exceções com o motivo", async () => {
  const client = await ligarCliente();
  const nomes = new Set((await client.listTools()).tools.map((t) => t.name));
  const canais = new Set<string>(BRIDGE_CHANNELS);

  const semNada = [...canais].filter((c) => FERRAMENTA_DO_CANAL[c] === undefined && semFerramenta(c) === undefined);
  assert.deepEqual(semNada, [], "canal da tela sem ferramenta no MCP: acrescente a ferramenta e a linha em paridade.ts");

  const nosDois = [...canais].filter((c) => FERRAMENTA_DO_CANAL[c] !== undefined && semFerramenta(c) !== undefined);
  assert.deepEqual(nosDois, []);

  const ausentes = Object.entries(FERRAMENTA_DO_CANAL).filter(([, ferramenta]) => !nomes.has(ferramenta));
  assert.deepEqual(ausentes, [], "a tabela aponta ferramenta que o servidor não registra");

  const sobrando = Object.keys(FERRAMENTA_DO_CANAL).filter((c) => !canais.has(c));
  assert.deepEqual(sobrando, [], "a tabela cita canal que a ponte não tem mais");

  for (const [chave, motivo] of Object.entries(CANAIS_SEM_FERRAMENTA)) {
    assert.ok(motivo.length > 20, `exceção ${chave} sem motivo`);
    assert.ok([...canais].some((c) => (chave.endsWith(".") ? c.startsWith(chave) : c === chave)), `exceção ${chave} não casa com canal nenhum`);
  }
});

/** Publicam em nome da pessoa, ou ligam e disparam o que age sozinho com a conta dela. */
const PUBLICAM = [
  "decide_approval",
  "run_agent",
  "rerun_step",
  "run_automation_now",
  "tick_triggers",
  "set_automation_enabled",
  "set_trigger_enabled",
  "agent_chat_decide",
];

/** Gravam por cima de uma credencial que já estava guardada. */
const SOBRESCREVEM_CREDENCIAL = ["save_github_token", "use_gh_account", "save_provider_secret", "save_tracker_secret", "save_grafana_instance", "set_mcp_server_credential"];

/** Leem pelo nome, mas sobem o servidor cadastrado. */
const LEITURA_SO_NO_NOME = new Set(["list_server_tools"]);

test("toda ferramenta vem anotada, e a anotação bate com o que ela faz", async () => {
  const client = await ligarCliente();
  const ferramentas = (await client.listTools()).tools;
  assert.ok(ferramentas.length >= 175, `só ${ferramentas.length} ferramentas`);
  const porNome = new Map(ferramentas.map((t) => [t.name, t.annotations ?? {}]));

  for (const [nome, a] of porNome) {
    for (const dica of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
      assert.equal(typeof a[dica], "boolean", `${nome} sem ${dica}`);
    }
    if (a.readOnlyHint === true) assert.equal(a.destructiveHint, false, `${nome} lê e se diz destrutiva`);
    if (/^(list|get)_/.test(nome) && !LEITURA_SO_NO_NOME.has(nome)) assert.equal(a.readOnlyHint, true, `${nome} deveria ser leitura`);
  }
  for (const nome of PUBLICAM) {
    const a = porNome.get(nome);
    assert.ok(a, `falta ${nome}`);
    assert.equal(a.destructiveHint, true, `${nome} publica e não se diz destrutiva`);
    assert.equal(a.openWorldHint, true, `${nome} publica e não se diz de fora`);
    assert.equal(a.readOnlyHint, false);
  }
  for (const nome of ["save_github_token", "save_provider_secret", "set_mcp_server_enabled", "remove_provider", "accept_mcp_origin", "agent_chat_reset"]) {
    assert.equal(porNome.get(nome)?.readOnlyHint, false, nome);
  }
  // Sobrescrevem credencial: o cliente tem de perguntar.
  for (const nome of SOBRESCREVEM_CREDENCIAL) {
    assert.equal(porNome.get(nome)?.destructiveHint, true, `${nome} sobrescreve credencial e não se diz destrutiva`);
  }
  // Trocar o endereço de um cadastro manda a chave guardada para o host novo, ou busca de fora e sobrescreve.
  for (const nome of ["register_provider", "register_tracker", "install_agent_template", "save_automation"]) {
    const a = porNome.get(nome);
    assert.equal(a?.destructiveHint, true, `${nome} deveria ser destrutiva`);
    assert.equal(a?.openWorldHint, true, `${nome} deveria ser de mundo aberto`);
  }
});

test("ferramenta registrada sem tipo de anotação estoura na montagem", () => {
  const server = exigirAnotacoes(new McpServer({ name: "x", version: "0" }));
  assert.throws(() => server.registerTool("ferramenta_nova_sem_tipo", { description: "x", inputSchema: {} }, async () => ({ content: [] })), /sem tipo de anotação/);
});

/** Junta pedaços: um token de mentira inteiro no código acende a proteção de push do GitHub. */
const j = (...partes: string[]): string => partes.join("");

/** Ferramentas de leitura que olham a pasta do usuário de verdade (~/.claude, gh, opencode). */
const OLHAM_A_CASA = new Set([
  "list_skills",
  "list_claude_import",
  "list_claude_import_origins",
  "get_claude_code_status",
  "get_opencode_status",
  "list_gh_accounts",
]);

test("segredo guardado pelas ferramentas não volta por nenhuma leitura", async () => {
  secretService.useBackend({ available: () => true, encrypt: (p) => Buffer.from(p), decrypt: (b) => b.toString() });
  const client = await ligarCliente();
  const sufixo = randomUUID().slice(0, 8);
  const segredos = {
    github: j("gh", "p_", "Zq81", sufixo, "abcdefghijklmnopqrstuvwx"),
    provedor: j("valor-do-provedor-", sufixo),
    tracker: j("valor-do-tracker-", sufixo),
    grafana: j("glsa_", "valor-do-grafana-", sufixo),
    mcp: j("valor-do-servidor-", sufixo),
  };

  ok(await client.callTool({ name: "save_github_token", arguments: { token: segredos.github } }));
  ok(await client.callTool({ name: "save_provider_secret", arguments: { name: "anthropic", secret: segredos.provedor } }));
  const tracker = `tr-${sufixo}`;
  ok(await client.callTool({ name: "register_tracker", arguments: { id: tracker, kind: "github-issues", label: "Tarefas" } }));
  ok(await client.callTool({ name: "save_tracker_secret", arguments: { id: tracker, secret: segredos.tracker } }));
  ok(await client.callTool({ name: "save_grafana_instance", arguments: { name: `gf-${sufixo}`, url: "https://grafana.exemplo", token: segredos.grafana } }));
  const servidor = `srv-${sufixo}`;
  ok(await client.callTool({ name: "register_mcp_server", arguments: { name: servidor, transport: "http", url: "https://mcp.exemplo/x" } }));
  const credencial = ok(await client.callTool({ name: "set_mcp_server_credential", arguments: { name: servidor, field: "Authorization", value: segredos.mcp } }));
  assert.doesNotMatch(credencial, new RegExp(segredos.mcp));

  const leituras = (await client.listTools()).tools.filter(
    (t) => t.annotations?.readOnlyHint === true && t.annotations.openWorldHint !== true && !OLHAM_A_CASA.has(t.name) && (t.inputSchema.required ?? []).length === 0,
  );
  assert.ok(leituras.length > 30, `só ${leituras.length} leituras sem argumento`);
  const chamadas = [
    ...leituras.map((t) => ({ name: t.name, arguments: {} })),
    { name: "list_cached_server_tools", arguments: { name: servidor } },
    { name: "get_connection_usage", arguments: { id: "github" } },
  ];
  for (const chamada of chamadas) {
    const saida = texto(await client.callTool(chamada));
    for (const [qual, valor] of Object.entries(segredos)) {
      assert.doesNotMatch(saida, new RegExp(valor), `${chamada.name} devolveu o segredo de ${qual}`);
    }
  }

  ok(await client.callTool({ name: "forget_provider_secret", arguments: { name: "anthropic" } }));
  ok(await client.callTool({ name: "forget_github_token", arguments: {} }));
});

test("ferramentas que só existem com o app dizem isso, sem quebrar o resto", async () => {
  const client = await ligarCliente();
  const res = await client.callTool({ name: "agent_chat_state", arguments: { agentId: "qualquer" } });
  assert.equal(res.isError, true);
  assert.match(texto(res), /só existe com o aplicativo/);
  assert.match(ok(await client.callTool({ name: "get_app_version", arguments: {} })), /0\.0\.0-teste/);
  assert.match(ok(await client.callTool({ name: "get_language", arguments: {} })), /pt-BR/);
});

test("o chat de agent pelo MCP espera a volta acabar ou parar no cartão, e decide pelo cartão", async () => {
  const falas: { de: string; texto: string; ferramentas: string[]; cartoes: { id: string; estado: string }[] }[] = [];
  let respondendo = false;
  const decisoes: string[] = [];
  const estado = async () => ({ falas: structuredClone(falas), respondendo, resumido: false, semServidor: [], contaIgnorada: 0, seq: 0 });
  const chat = {
    estado,
    enviar: async (_id: string, texto: string) => {
      respondendo = true;
      falas.push({ de: "user", texto, ferramentas: [], cartoes: [] });
      // Como no caminho do Claude Code: a volta para no cartão e só resolve depois do clique.
      falas.push({ de: "assistant", texto: "vou publicar", ferramentas: [], cartoes: [{ id: "c1", estado: "pendente" }] });
      await new Promise<void>((resolve) => setTimeout(resolve, 60_000).unref());
    },
    decidir: async (_id: string, cartao: string, decisao: string) => {
      decisoes.push(`${cartao}:${decisao}`);
      falas[1]!.cartoes[0]!.estado = decisao === "executar" ? "executado" : "recusado";
      respondendo = false;
    },
    cancelar: () => undefined,
    limpar: async () => {
      falas.length = 0;
    },
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await buildMcpServer({ ...FORA, agentChat: chat as never }).connect(serverTransport);
  const client = new Client({ name: "teste", version: "0.0.0" });
  await client.connect(clientTransport);

  const enviado = JSON.parse(ok(await client.callTool({ name: "agent_chat_send", arguments: { agentId: "a", text: "publique" } })));
  assert.equal(enviado.falas[1].cartoes[0].estado, "pendente");
  const decidido = JSON.parse(ok(await client.callTool({ name: "agent_chat_decide", arguments: { agentId: "a", cardId: "c1", decision: "recusar" } })));
  assert.equal(decidido.falas[1].cartoes[0].estado, "recusado");
  assert.deepEqual(decisoes, ["c1:recusar"]);
  assert.equal(JSON.parse(ok(await client.callTool({ name: "agent_chat_reset", arguments: { agentId: "a" } }))).reset, true);
  assert.equal(falas.length, 0);
});
