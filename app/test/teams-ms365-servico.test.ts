import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectionService } from "../src/services/connection-service.js";
import type { Candidato } from "../src/services/claude-import.js";

const TOOLS = ["list-chats", "list-chat-messages", "get-chat-message"].map((name) => ({ name }));

const saude = { lastOkAt: null, lastFailureAt: null, lastError: null, needsAuth: false };

function entrada(name: string, enabled: boolean) {
  return { config: { name, transport: "stdio", command: ["npx", "-y", "x"] }, source: null, enabled, credentialRef: null, health: saude };
}

function candidato(name: string, destino = "npx -y @softeria/ms-365-mcp-server"): Candidato {
  return { name, origem: "usuário", transport: "stdio", destino, faltando: [], oauth: false, jaCadastrado: false };
}

function montar(opts: { cadastro?: ReturnType<typeof entrada>[]; ferramentas?: Record<string, { name: string }[]>; candidatos?: Candidato[] }) {
  const chamadas: string[] = [];
  const mcp = {
    list: async () => opts.cadastro ?? [],
    cachedTools: async (n: string) => (opts.ferramentas?.[n] === undefined ? null : { at: 0, tools: opts.ferramentas[n] }),
    testConnection: async (n: string) => {
      chamadas.push(`testar:${n}`);
      return { name: n, ok: true, elapsedMs: 1, toolCount: 3 };
    },
  };
  const importacao = {
    listar: async () => opts.candidatos ?? [],
    importar: async (nomes: string[], o?: { ligar?: boolean }) => {
      chamadas.push(`importar:${nomes.join(",")}:${o?.ligar === true}`);
      return { importados: nomes };
    },
  };
  const servico = new ConnectionService({ mcp: mcp as never, importacao: importacao as never });
  return { servico, chamadas };
}

test("sem nenhum servidor: nada cadastrado e nada a recomendar, sem quebrar", async () => {
  const { servico } = montar({});
  assert.deepEqual(await servico.teamsPeloMcp(), { cadastrado: null, recomendado: null });
});

test("servidor cadastrado que traz o Teams aparece com o estado", async () => {
  const { servico } = montar({ cadastro: [entrada("ms365", false)], ferramentas: { ms365: TOOLS }, candidatos: [candidato("ms365")] });
  const r = await servico.teamsPeloMcp();
  assert.equal(r.cadastrado?.server, "ms365");
  assert.equal(r.cadastrado?.ligado, false);
  assert.equal(r.recomendado, null, "já cadastrado: não oferece importar");
});

test("sem cadastro, recomenda o do Claude Code que traz o Teams", async () => {
  const { servico } = montar({ candidatos: [candidato("grafana", "docker run mcp/grafana"), candidato("ms365")] });
  const r = await servico.teamsPeloMcp();
  assert.equal(r.cadastrado, null);
  assert.equal(r.recomendado?.name, "ms365");
  assert.equal(r.recomendado?.origem, "usuário");
});

test("usar o do Claude Code importa só esse servidor, ligado, e testa", async () => {
  const { servico, chamadas } = montar({ candidatos: [candidato("ms365"), candidato("grafana", "docker run mcp/grafana")] });
  const r = await servico.usarTeamsDoClaude("ms365");
  assert.deepEqual(chamadas, ["importar:ms365:true", "testar:ms365"]);
  assert.equal(r.ok, true);
});

test("usar recusa servidor que não traz o Teams", async () => {
  const { servico, chamadas } = montar({ candidatos: [candidato("grafana", "docker run mcp/grafana")] });
  await assert.rejects(() => servico.usarTeamsDoClaude("grafana"));
  assert.deepEqual(chamadas, []);
});
