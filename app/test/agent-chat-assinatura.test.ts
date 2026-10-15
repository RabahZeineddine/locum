import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rodarPelaAssinatura } from "../src/agent-chat/assinatura.js";
import type { DecisaoDaAssinatura, PedidoDaAssinatura } from "../src/agent-chat/conversas.js";
import { AgentProfile, McpServerConfig } from "../src/config/types.js";
import type { ResolvedProfile } from "../src/services/library-service.js";

/** O chat do agent pelo Claude Code: o que vai na linha de comando e na configuração de MCP. */

const perfil: ResolvedProfile = {
  version: {
    id: "v",
    profileId: "a",
    version: 1,
    spec: AgentProfile.parse({ id: "a", name: "A", model: "claude-code/sonnet" }),
    note: null,
    createdAt: 0,
  },
  tools: [{ server: "painel", tool: "pid", class: "read" }],
  confirmar: [{ server: "painel", tool: "echo", class: "external_write" }],
  semServidor: [],
  fixas: [],
  grupos: [],
  system: "sistema do agent",
};

const servidor = (name: string) =>
  McpServerConfig.parse({ name, transport: "stdio", command: ["node", `${name}.js`], env: { SEGREDO: "valor" } });

test("a escrita não entra nas liberadas: o Claude Code a leva à ferramenta de permissão do Locum", async () => {
  let args: string[] = [];
  let configuracao = "";
  const aprovados: DecisaoDaAssinatura[] = [];
  const pedido: PedidoDaAssinatura = {
    texto: "faz",
    modelo: "sonnet",
    system: perfil.system,
    sessao: "s0",
    perfil,
    aprovar: async (nome, entrada) => {
      const d: DecisaoDaAssinatura = { permitir: true, entrada: { nome, entrada } };
      aprovados.push(d);
      return d;
    },
    emitir: () => undefined,
    sinal: new AbortController().signal,
  };

  const { gasto, sessao } = await rodarPelaAssinatura(
    pedido,
    {
      binario: async () => "/bin/claude",
      configs: async () => [servidor("painel"), servidor("outro")],
      mensagemSemClaude: "sem claude",
      abrir: (_comando, a) => {
        args = a;
        configuracao = readFileSync(a[a.indexOf("--mcp-config") + 1]!, "utf8");
        return {
          linhas: (async function* () {
            yield JSON.stringify({ type: "result", subtype: "success", session_id: "s1", total_cost_usd: 0.1, usage: { input_tokens: 4, output_tokens: 6 } });
          })(),
          encerrar: () => undefined,
          saida: Promise.resolve(0),
        };
      },
    },
  );

  const valor = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(valor("--allowedTools"), "mcp__painel__pid");
  assert.equal(valor("--permission-prompt-tool"), "mcp__locum-aprovacao__aprovar");
  assert.equal(valor("--permission-mode"), "default");
  assert.equal(valor("--tools"), "");
  assert.equal(valor("--resume"), "s0");

  const mcp = (JSON.parse(configuracao) as { mcpServers: Record<string, { type?: string; url?: string; headers?: Record<string, string> }> }).mcpServers;
  assert.deepEqual(Object.keys(mcp).sort(), ["locum-aprovacao", "painel"], "só os servidores do agent e o de aprovação");
  assert.equal(mcp["locum-aprovacao"]?.type, "http");
  assert.match(mcp["locum-aprovacao"]?.headers?.Authorization ?? "", /^Bearer [0-9a-f]{48}$/);
  assert.deepEqual({ gasto, sessao }, { gasto: { usd: 0.1, tokens: 10 }, sessao: "s1" });
});

test("sem o Claude Code instalado, a volta diz isso", async () => {
  await assert.rejects(
    rodarPelaAssinatura(
      { texto: "x", modelo: "sonnet", system: "", sessao: undefined, perfil, aprovar: async () => ({ permitir: false, mensagem: "" }), emitir: () => undefined, sinal: new AbortController().signal },
      { binario: async () => undefined, configs: async () => [], mensagemSemClaude: "sem claude" },
    ),
    /sem claude/,
  );
});
