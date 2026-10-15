import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentProfile } from "../src/config/types.js";
import * as schema from "../src/db/schema.js";
import { LibraryService, type CatalogoDeConexoes } from "../src/services/library-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/** O agent escolhe conexões; a biblioteca expande cada uma nas ferramentas dos servidores dela. */

const modelo = "anthropic/claude-sonnet-5";

function catalogoCom(
  servidores: Record<string, string[]>,
  ferramentas: Record<string, string[] | null>,
): CatalogoDeConexoes {
  return {
    servidoresDe: async (id) => servidores[id] ?? [],
    ferramentasDe: async (servidor) => ferramentas[servidor] ?? null,
  };
}

const github = catalogoCom({ github: ["github"] }, { github: ["get_issue", "list_commits", "create_comment", "merge_branch"] });

const nomes = (tools: readonly { server: string; tool: string }[]) => tools.map((t) => `${t.server}.${t.tool}`).sort();

test("a conexão libera só a leitura por padrão, e a escrita fica à espera de confirmação", async () => {
  const biblioteca = new LibraryService(bancoDeTeste(), github);
  await biblioteca.saveProfile({
    spec: { id: "revisor", name: "Revisor", model: modelo, connections: [{ connectionId: "github" }] },
  });
  const resolvido = await biblioteca.resolveProfile("revisor");
  assert.deepEqual(nomes(resolvido.tools), ["github.get_issue", "github.list_commits"]);
  assert.ok(resolvido.tools.every((t) => t.class === "read"));
  assert.deepEqual(resolvido.confirmar, []);
});

test("a escrita marcada sai de tools e vem em confirmar, como escrita externa", async () => {
  const biblioteca = new LibraryService(bancoDeTeste(), github);
  await biblioteca.saveProfile({
    spec: {
      id: "revisor",
      name: "Revisor",
      model: modelo,
      connections: [{ connectionId: "github", tools: { create_comment: true, list_commits: false } }],
    },
  });
  const resolvido = await biblioteca.resolveProfile("revisor");
  assert.deepEqual(nomes(resolvido.tools), ["github.get_issue"]);
  assert.deepEqual(resolvido.confirmar, [{ server: "github", tool: "create_comment", class: "external_write" }]);
});

test("conexão com várias instâncias libera as ferramentas de cada uma", async () => {
  const grafana = catalogoCom(
    { grafana: ["grafana-prod", "grafana-hml"] },
    { "grafana-prod": ["query_metrics"], "grafana-hml": ["query_metrics", "create_dashboard"] },
  );
  const biblioteca = new LibraryService(bancoDeTeste(), grafana);
  await biblioteca.saveProfile({ spec: { id: "sre", name: "SRE", model: modelo, connections: [{ connectionId: "grafana" }] } });
  const resolvido = await biblioteca.resolveProfile("sre");
  assert.deepEqual(nomes(resolvido.tools), ["grafana-hml.query_metrics", "grafana-prod.query_metrics"]);
});

test("conexão sem servidor não entra e é apontada, sem derrubar o agent", async () => {
  const biblioteca = new LibraryService(bancoDeTeste(), catalogoCom({}, {}));
  await biblioteca.saveProfile({ spec: { id: "x", name: "X", model: modelo, connections: [{ connectionId: "jira" }] } });
  const resolvido = await biblioteca.resolveProfile("x");
  assert.deepEqual(resolvido.tools, []);
  assert.deepEqual(resolvido.semServidor, ["jira"]);
});

test("servidor que nunca listou ferramentas só entra pelo que foi marcado", async () => {
  const biblioteca = new LibraryService(bancoDeTeste(), catalogoCom({ jira: ["jira"] }, {}));
  await biblioteca.saveProfile({
    spec: { id: "x", name: "X", model: modelo, connections: [{ connectionId: "jira", tools: { search_issues: true } }] },
  });
  assert.deepEqual(nomes((await biblioteca.resolveProfile("x")).tools), ["jira.search_issues"]);
});

test("toolset e conexão que alcançam a mesma ferramenta não a repetem", async () => {
  const biblioteca = new LibraryService(bancoDeTeste(), github);
  await biblioteca.saveToolset({
    toolset: { id: "pr", name: "PR", tools: [{ server: "github", tool: "get_issue", class: "read" }] },
  });
  await biblioteca.saveProfile({
    spec: {
      id: "revisor",
      name: "Revisor",
      model: modelo,
      toolsets: ["pr"],
      tools: [{ server: "github", tool: "list_commits", class: "read" }],
      connections: [{ connectionId: "github" }],
    },
  });
  assert.deepEqual(nomes((await biblioteca.resolveProfile("revisor")).tools), [
    "github.get_issue",
    "github.list_commits",
  ]);
});

test("versão gravada antes das conexões, das skills e do orçamento continua abrindo", async () => {
  const banco = bancoDeTeste();
  const antigo = { id: "legado", name: "Legado", description: "", context: "", instructions: "Faça.", model: modelo, toolsets: [], tools: [], maxSteps: 7 };
  banco.insert(schema.agentProfiles).values({ id: "legado", name: "Legado" }).run();
  banco
    .insert(schema.agentProfileVersions)
    .values({ id: "v1", profileId: "legado", version: 1, spec: antigo as unknown as object })
    .run();
  const biblioteca = new LibraryService(banco, github);
  const lido = await biblioteca.getProfile("legado");
  assert.deepEqual(lido?.spec.connections, []);
  assert.deepEqual(lido?.spec.skills, []);
  assert.deepEqual(lido?.spec.budget, {});
  assert.equal(lido?.spec.maxSteps, 7);
  assert.equal((await biblioteca.resolveProfile("legado")).tools.length, 0);
  // Gravar o mesmo conteúdo de novo não vira versão nova.
  assert.equal((await biblioteca.saveProfile({ spec: antigo })).version, 1);
});

test("skill aceita o nome puro ou a regra completa", () => {
  const spec = AgentProfile.parse({
    id: "a",
    name: "A",
    model: modelo,
    skills: ["revisao", { skill: "ts", when: { filesMatch: ["**/*.ts"] } }],
  });
  assert.deepEqual(spec.skills, [
    { skill: "revisao", when: { always: true } },
    { skill: "ts", when: { filesMatch: ["**/*.ts"] } },
  ]);
});
