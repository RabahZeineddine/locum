import assert from "node:assert/strict";
import { test } from "node:test";
import { candidatosDoTeams, escolherRecomendado, trazOTeams } from "../src/services/teams-ms365.js";

const cand = (name: string, destino: string, extra: Partial<{ origem: string; jaCadastrado: boolean; faltando: string[] }> = {}) => ({
  name,
  destino,
  origem: "usuário",
  jaCadastrado: false,
  faltando: [] as string[],
  ...extra,
});

test("trazOTeams: reconhece o ms365 pelo nome e pelo pacote", () => {
  assert.equal(trazOTeams(cand("ms365", "npx -y @softeria/ms-365-mcp-server")), true);
  assert.equal(trazOTeams(cand("microsoft-365", "https://exemplo/mcp")), true);
  assert.equal(trazOTeams(cand("m365", "npx -y @softeria/ms-365-mcp-server --org-mode")), true);
});

test("trazOTeams: servidor sem relação com o Teams não passa", () => {
  assert.equal(trazOTeams(cand("grafana", "docker run mcp/grafana")), false);
  assert.equal(trazOTeams(cand("plataforma", "https://plataforma.exemplo/mcp")), false);
});

test("escolherRecomendado: o de nome ms365 ganha, e o que falta variável fica por último", () => {
  const a = cand("microsoft-365", "https://exemplo/mcp");
  const b = cand("ms365", "npx -y @softeria/ms-365-mcp-server", { origem: "akad@akad" });
  const c = cand("ms365-velho", "npx -y @softeria/ms-365-mcp-server", { faltando: ["TOKEN"] });
  assert.equal(escolherRecomendado([a, c, b])?.name, "ms365");
  assert.equal(escolherRecomendado([c, a])?.name, "microsoft-365");
});

test("escolherRecomendado: sem candidato do Teams devolve nulo", () => {
  assert.equal(escolherRecomendado([cand("grafana", "docker run mcp/grafana")]), null);
  assert.equal(escolherRecomendado([]), null);
});

test("trazOTeams: teams-alerts e teams-notifier não são o Teams para ler", () => {
  assert.equal(trazOTeams(cand("teams-alerts", "node alerts.js")), false);
  assert.equal(trazOTeams(cand("teams-notifier", "https://notifier.exemplo/mcp")), false);
});

test("candidatosDoTeams: todos os que trazem, o recomendado primeiro", () => {
  const plugin = cand("ms365", "npx -y @softeria/ms-365-mcp-server", { origem: "akad@akad" });
  const usuario = cand("ms365", "npx -y @softeria/ms-365-mcp-server");
  const faltando = cand("m365", "npx -y @softeria/ms-365-mcp-server", { faltando: ["T"] });
  const lista = candidatosDoTeams([faltando, cand("grafana", "docker run mcp/grafana"), plugin, usuario]);
  assert.deepEqual(lista.map((c) => `${c.name}:${c.origem}`), ["ms365:akad@akad", "ms365:usuário", "m365:usuário"]);
});

test("trazOTeams: teams solto num caminho ou comando não basta", () => {
  assert.equal(trazOTeams(cand("locum-ferramentas", "/Applications/Locum.app/Contents/MacOS/Locum --teams")), false);
});

test("trazOTeams: pasta com ms365 no caminho do comando não basta", () => {
  assert.equal(trazOTeams(cand("locum-fixture", "/Users/x/.worktrees/locum-teams-ms365/app/dist/fixture.cjs")), false);
});
