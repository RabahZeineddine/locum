import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentSpec, type AgentProfile, type Toolset } from "../src/config/types.js";
import { quemUsa } from "../src/services/conexao-uso.js";

const spec = (id: string, passos: unknown[], defaultTools: unknown[] = []): AgentSpec =>
  AgentSpec.parse({ id, name: `Automação ${id}`, defaultTools, steps: passos });

const passoIA = (key: string, extra: Record<string, unknown> = {}) => ({
  type: "model",
  key,
  name: key,
  model: "claude-code/claude-sonnet-5",
  prompt: "x",
  ...extra,
});

const perfil = (id: string, extra: Partial<AgentProfile> = {}): AgentProfile => ({
  id,
  name: `Agent ${id}`,
  description: "",
  context: "",
  instructions: "",
  model: "claude-code/claude-sonnet-5",
  toolsets: [],
  tools: [],
  connections: [],
  skills: [],
  budget: {},
  maxSteps: 12,
  ...extra,
});

test("automação que exige o servidor ou usa ferramenta dele em um passo aparece, com o motivo", () => {
  const exige = spec("exige", [passoIA("a", { requiresServers: ["notion"] })]);
  const usa = spec("usa", [passoIA("a", { tools: [{ server: "notion", tool: "search", class: "read" }] })]);
  const outra = spec("outra", [passoIA("a", { requiresServers: ["figma"] })]);

  const uso = quemUsa("notion", { automacoes: [exige, usa, outra], agents: [], toolsets: [] });

  assert.deepEqual(
    uso.map((u) => [u.tipo, u.id, u.como]),
    [
      ["automation", "exige", ["exige"]],
      ["automation", "usa", ["ferramenta"]],
    ],
  );
});

test("ferramenta herdada do agent padrão conta para o passo que não declara as suas", () => {
  const herda = spec("herda", [passoIA("a")], [{ server: "linear", tool: "list_issues", class: "read" }]);
  const propria = spec("propria", [passoIA("a", { tools: [] })], [{ server: "linear", tool: "list_issues", class: "read" }]);

  const uso = quemUsa("linear", { automacoes: [herda, propria], agents: [], toolsets: [] });

  assert.deepEqual(uso.map((u) => u.id), ["herda"]);
});

test("ação de chamar ferramenta num servidor conta como uso", () => {
  const acao = spec("acao", [
    { type: "action", key: "b", name: "b", action: "mcp.call", params: { server: "sentry", tool: "x", args: {} } },
    { type: "action", key: "c", name: "c", action: "slack.post" },
  ]);

  assert.deepEqual(quemUsa("sentry", { automacoes: [acao], agents: [], toolsets: [] }).map((u) => [u.id, u.como]), [
    ["acao", ["acao"]],
  ]);
  assert.deepEqual(quemUsa("slack", { automacoes: [acao], agents: [], toolsets: [] }), []);
});

test("agent usa o servidor por ferramenta avulsa ou pelo toolset que inclui", () => {
  const toolset: Toolset = {
    id: "leitura",
    name: "Leitura",
    description: "",
    tools: [{ server: "notion", tool: "fetch", class: "read" }],
  };
  const avulso = perfil("avulso", { tools: [{ server: "notion", tool: "search", class: "read" }] });
  const viaToolset = perfil("via-toolset", { toolsets: ["leitura"] });
  const sem = perfil("sem");

  const uso = quemUsa("notion", { automacoes: [], agents: [avulso, viaToolset, sem], toolsets: [toolset] });

  assert.deepEqual(
    uso.map((u) => [u.tipo, u.id]),
    [
      ["agent", "avulso"],
      ["agent", "via-toolset"],
    ],
  );
});

test("o mesmo motivo repetido em vários passos aparece uma vez", () => {
  const dois = spec("dois", [
    passoIA("a", { requiresServers: ["notion"] }),
    passoIA("b", { requiresServers: ["notion"] }),
  ]);
  assert.deepEqual(quemUsa("notion", { automacoes: [dois], agents: [], toolsets: [] })[0]?.como, ["exige"]);
});
