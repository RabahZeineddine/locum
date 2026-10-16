import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectionService } from "../src/services/connection-service.js";
import { ClaudeImportService, type Candidato } from "../src/services/claude-import.js";
import { abrirTeams, teamsNoMcp } from "../src/teams/graph.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOOLS = ["get-current-user", "list-chats", "list-chat-messages"].map((name) => ({ name }));
const SEM_TEAMS = ["list-mail-messages", "get-current-user"].map((name) => ({ name }));

const saude = { lastOkAt: null, lastFailureAt: null, lastError: null, needsAuth: false };

function entrada(name: string, enabled: boolean) {
  return { config: { name, transport: "stdio", command: ["npx", "-y", "x"] }, source: null, enabled, credentialRef: null, health: saude };
}

function candidato(name: string, extra: Partial<Candidato> = {}): Candidato {
  return { name, origem: "usuário", transport: "stdio", destino: "npx -y @softeria/ms-365-mcp-server", faltando: [], oauth: false, jaCadastrado: false, ...extra };
}

interface Opcoes {
  cadastro?: ReturnType<typeof entrada>[];
  ferramentas?: Record<string, { name: string }[]>;
  candidatos?: Candidato[];
  /** O que o teste guarda para o servidor importado. */
  depoisDoTeste?: { name: string }[];
  entra?: boolean;
}

function montar(opts: Opcoes) {
  const chamadas: string[] = [];
  const ferramentas = { ...(opts.ferramentas ?? {}) };
  const mcp = {
    list: async () => opts.cadastro ?? [],
    cachedTools: async (n: string) => (ferramentas[n] === undefined ? null : { at: 0, tools: ferramentas[n] }),
    testConnection: async (n: string) => {
      chamadas.push(`testar:${n}`);
      if (opts.depoisDoTeste !== undefined) ferramentas[n] = opts.depoisDoTeste;
      return { name: n, ok: true, elapsedMs: 1, toolCount: opts.depoisDoTeste?.length ?? 0 };
    },
  };
  const importacao = {
    listarTodos: async () => opts.candidatos ?? [],
    importar: async (nomes: string[], o?: { ligar?: boolean; origem?: string }) => {
      chamadas.push(`importar:${nomes.join(",")}:${o?.ligar === true}:${o?.origem ?? ""}`);
      return { importados: nomes };
    },
  };
  const oauth = { status: () => ({ connected: opts.entra === true, expiresAt: null, renewable: false }) };
  const servico = new ConnectionService({ mcp: mcp as never, importacao: importacao as never, oauth: oauth as never });
  return { servico, chamadas };
}

test("sem nenhum servidor: nada cadastrado e nada a oferecer, sem quebrar", async () => {
  const { servico } = montar({});
  assert.deepEqual(await servico.teamsPeloMcp(), { conectadoPeloEntra: false, cadastrado: null, candidatos: [] });
});

test("servidor cadastrado que traz o Teams aparece com o estado e sem oferta de importar", async () => {
  const { servico } = montar({ cadastro: [entrada("ms365", false)], ferramentas: { ms365: TOOLS }, candidatos: [candidato("ms365")] });
  const r = await servico.teamsPeloMcp();
  assert.equal(r.cadastrado?.server, "ms365");
  assert.equal(r.cadastrado?.ligado, false);
  assert.equal(r.cadastrado?.traz, true);
  assert.deepEqual(r.candidatos, []);
});

test("cadastrado já testado sem as ferramentas do Teams aparece como falha, não como pronto", async () => {
  const { servico } = montar({ cadastro: [entrada("ms365", true)], ferramentas: { ms365: SEM_TEAMS } });
  const r = await servico.teamsPeloMcp();
  assert.equal(r.cadastrado?.server, "ms365");
  assert.equal(r.cadastrado?.traz, false);
});

test("cadastrado sem ferramentas guardadas conta pelo nome; teams-alerts não conta", async () => {
  const a = montar({ cadastro: [entrada("ms365", true)] });
  assert.equal((await a.servico.teamsPeloMcp()).cadastrado?.server, "ms365");
  const b = montar({ cadastro: [entrada("teams-alerts", true), entrada("teams-notifier", true)] });
  assert.equal((await b.servico.teamsPeloMcp()).cadastrado, null);
});

test("sem cadastro lista todos os candidatos, o recomendado primeiro, cada um com a sua origem", async () => {
  const { servico } = montar({
    candidatos: [
      candidato("grafana", { destino: "docker run mcp/grafana" }),
      candidato("m365", { faltando: ["TOKEN"] }),
      candidato("ms365", { origem: "akad@akad" }),
      candidato("ms365"),
    ],
  });
  const r = await servico.teamsPeloMcp();
  assert.deepEqual(r.candidatos.map((c) => `${c.name}:${c.origem}`), ["ms365:akad@akad", "ms365:usuário", "m365:usuário"]);
  assert.deepEqual(r.candidatos[2]?.faltando, ["TOKEN"]);
});

test("com o login do Entra conectado o ms365 segue na lista, para a tela chamá-lo de alternativa", async () => {
  const { servico } = montar({ entra: true, candidatos: [candidato("ms365")] });
  const r = await servico.teamsPeloMcp();
  assert.equal(r.conectadoPeloEntra, true);
  assert.equal(r.candidatos.length, 1);
});

test("usar importa só esse servidor, da origem escolhida, ligado, e testa", async () => {
  const { servico, chamadas } = montar({
    candidatos: [candidato("ms365"), candidato("ms365", { origem: "akad@akad" }), candidato("grafana", { destino: "docker run mcp/grafana" })],
    depoisDoTeste: TOOLS,
  });
  const r = await servico.usarTeamsDoClaude("ms365", "akad@akad");
  assert.deepEqual(chamadas, ["importar:ms365:true:akad@akad", "testar:ms365"]);
  assert.equal(r.ok, true);
});

test("usar: o servidor sobe mas não traz o Teams devolve erro claro", async () => {
  const { servico } = montar({ candidatos: [candidato("ms365")], depoisDoTeste: SEM_TEAMS });
  const r = await servico.usarTeamsDoClaude("ms365");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /o ms365 subiu, mas não traz as ferramentas do Teams; no ms365 da Softeria isso pede --org-mode/);
});

test("usar recusa servidor que não traz o Teams e candidato com variável faltando", async () => {
  const { servico, chamadas } = montar({ candidatos: [candidato("grafana", { destino: "docker run mcp/grafana" }), candidato("ms365", { faltando: ["T"] })] });
  await assert.rejects(() => servico.usarTeamsDoClaude("grafana"));
  await assert.rejects(() => servico.usarTeamsDoClaude("ms365"), /falta definir T/);
  assert.deepEqual(chamadas, []);
});

test("candidato de plugin importado e ligado: grava o vínculo do plugin e o abrirTeams o acha", async () => {
  const home = mkdtempSync(join(tmpdir(), "locum-teams-plugin-"));
  const raiz = join(home, ".claude", "plugins", "cache", "akad", "akad", "1.0.0");
  mkdirSync(raiz, { recursive: true });
  writeFileSync(join(raiz, ".mcp.json"), JSON.stringify({ mcpServers: { ms365: { command: "${CLAUDE_PLUGIN_ROOT}/bin/ms365.sh", args: ["--org-mode"] } } }));
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "akad@akad": [{ installPath: raiz }] } }));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "akad@akad": true } }));

  const cadastro = new Map<string, { enabled: boolean; source: unknown }>();
  const importacao = new ClaudeImportService({
    home,
    ambiente: async () => ({}),
    mcp: {
      list: async () => [],
      register: async (c, o) => {
        cadastro.set(c.name, { enabled: true, source: o?.source });
        return {} as never;
      },
      setEnabled: async (n, ligado) => void (cadastro.get(n)!.enabled = ligado),
      setCredentialRef: async () => undefined,
      vincular: async () => undefined,
    },
    secrets: { set: () => undefined },
    settings: { set: async () => undefined, get: async () => undefined },
  });
  const [candidatoDoPlugin] = await importacao.listarTodos();
  assert.equal(candidatoDoPlugin?.origem, "akad@akad");
  await importacao.importar(["ms365"], { ligar: true, origem: "akad@akad" });
  assert.deepEqual(cadastro.get("ms365"), { enabled: true, source: { kind: "claude-plugin", plugin: "akad", marketplace: "akad", server: "ms365" } });

  // O teste do servidor guardou as ferramentas; o abrirTeams acha o servidor ligado e chama por ele.
  const mcp = {
    list: async () => [{ ...entrada("ms365", cadastro.get("ms365")!.enabled) }] as never,
    cachedTools: async () => ({ at: 0, tools: TOOLS }),
  };
  assert.equal((await teamsNoMcp(mcp as never))?.server, "ms365");
  const chamadas: string[] = [];
  const teams = await abrirTeams({
    mcp: mcp as never,
    token: async () => null,
    call: async (servidor, ferramenta) => {
      chamadas.push(`${servidor}:${ferramenta}`);
      return { content: [{ type: "text", text: "{}" }] } as never;
    },
  });
  assert.ok(teams !== null);
});
