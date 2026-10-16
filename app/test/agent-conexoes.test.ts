import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentProfile } from "../src/config/types.js";
import * as schema from "../src/db/schema.js";
import { LibraryService, type CatalogoDeConexoes } from "../src/services/library-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/** O agent escolhe conexões; a biblioteca expande cada uma nas ferramentas dos servidores dela. */

const modelo = "anthropic/claude-sonnet-5";

type Oferecida = string | { name: string; readOnlyHint?: boolean; destructiveHint?: boolean };

/** Catálogo de mentira: servidores por conexão (ligados salvo `desligados`) e ferramentas por servidor. */
function catalogoCom(
  servidores: Record<string, string[]>,
  ferramentas: Record<string, Oferecida[] | Error>,
  desligados: string[] = [],
): CatalogoDeConexoes {
  return {
    servidoresDe: async (id) => (servidores[id] ?? []).map((nome) => ({ nome, ligado: !desligados.includes(nome) })),
    ferramentasDe: async (servidor) => {
      const lista = ferramentas[servidor];
      if (lista === undefined) throw new Error("não listou");
      if (lista instanceof Error) throw lista;
      return lista.map((f) => (typeof f === "string" ? { name: f } : f));
    },
    guardadasDe: async (servidor) => {
      const lista = ferramentas[servidor];
      return lista === undefined || lista instanceof Error ? null : lista.map((f) => (typeof f === "string" ? { name: f } : f));
    },
  };
}

const github = catalogoCom(
  { github: ["github"] },
  { github: ["get_issue", "list_commits", "create_comment", "merge_branch", "get_pull_request", "pull_request_read"] },
);

const nomes = (tools: readonly { server: string; tool: string }[]) => tools.map((t) => `${t.server}.${t.tool}`).sort();

test("a conexão libera só a leitura por padrão, e a escrita fica à espera de confirmação", async () => {
  const biblioteca = new LibraryService(bancoDeTeste(), github);
  await biblioteca.saveProfile({
    spec: { id: "revisor", name: "Revisor", model: modelo, connections: [{ connectionId: "github" }] },
  });
  const resolvido = await biblioteca.resolveProfile("revisor");
  assert.deepEqual(nomes(resolvido.tools), [
    "github.get_issue",
    "github.get_pull_request",
    "github.list_commits",
    "github.pull_request_read",
  ]);
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
  assert.deepEqual(nomes(resolvido.tools), ["github.get_issue", "github.get_pull_request", "github.pull_request_read"]);
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
  assert.deepEqual(resolvido.semServidor, [{ connectionId: "jira", motivo: "sem servidor ligado nesta máquina" }]);
});

test("servidor que não consegue listar as ferramentas deixa a conexão indisponível, com o motivo", async () => {
  const jira = catalogoCom({ jira: ["jira"] }, { jira: new Error("conexão recusada") });
  const biblioteca = new LibraryService(bancoDeTeste(), jira);
  await biblioteca.saveProfile({
    spec: { id: "x", name: "X", model: modelo, connections: [{ connectionId: "jira", tools: { search_issues: true } }] },
  });
  const resolvido = await biblioteca.resolveProfile("x");
  assert.deepEqual(resolvido.tools, []);
  assert.match(resolvido.semServidor[0]!.motivo, /não consegui listar.*conexão recusada/);
});

test("servidor desligado não entra, e a conexão só com ele fica indisponível", async () => {
  const catalogo = catalogoCom(
    { grafana: ["grafana-prod", "grafana-hml"], jira: ["jira"] },
    { "grafana-prod": ["query_metrics"], "grafana-hml": ["query_metrics"], jira: ["search_issues"] },
    ["grafana-hml", "jira"],
  );
  const biblioteca = new LibraryService(bancoDeTeste(), catalogo);
  await biblioteca.saveProfile({
    spec: { id: "x", name: "X", model: modelo, connections: [{ connectionId: "grafana" }, { connectionId: "jira" }] },
  });
  const resolvido = await biblioteca.resolveProfile("x");
  assert.deepEqual(nomes(resolvido.tools), ["grafana-prod.query_metrics"]);
  assert.deepEqual(resolvido.semServidor, [{ connectionId: "jira", motivo: "o servidor dela está desligado" }]);
  assert.deepEqual(resolvido.grupos, [{ connectionId: "grafana", servers: ["grafana-prod"] }]);
});

test("ferramenta que o servidor deixou de oferecer sai, mesmo escolhida", async () => {
  const biblioteca = new LibraryService(bancoDeTeste(), catalogoCom({ github: ["github"] }, { github: ["get_issue"] }));
  await biblioteca.saveProfile({
    spec: { id: "x", name: "X", model: modelo, connections: [{ connectionId: "github", tools: { sumiu: true, "github/outra": "read" } }] },
  });
  const resolvido = await biblioteca.resolveProfile("x");
  assert.deepEqual(nomes(resolvido.tools), ["github.get_issue"]);
  assert.deepEqual(resolvido.confirmar, []);
});

test("instância nova da conexão não entra ligada, e o agent não é regravado", async () => {
  const servidores = { grafana: ["grafana-prod"] };
  const ferramentas = { "grafana-prod": ["query_metrics"], "grafana-dev": ["query_metrics"] };
  const biblioteca = new LibraryService(bancoDeTeste(), catalogoCom(servidores, ferramentas));
  await biblioteca.saveProfile({ spec: { id: "x", name: "X", model: modelo, connections: [{ connectionId: "grafana" }] } });
  assert.deepEqual(nomes((await biblioteca.resolveProfile("x")).tools), ["grafana-prod.query_metrics"]);
  servidores.grafana.push("grafana-dev");
  // Instância nova traz ferramenta nova, e ferramenta nova nasce desligada.
  assert.deepEqual(nomes((await biblioteca.resolveProfile("x")).tools), ["grafana-prod.query_metrics"]);
});

test("a anotação do servidor classifica, e a pessoa pode declarar que uma escrita só lê", async () => {
  const catalogo = catalogoCom(
    { fx: ["fx"] },
    { fx: [{ name: "pid", readOnlyHint: true }, { name: "mystery_tool", readOnlyHint: false }, "sum", "echo"] },
  );
  const biblioteca = new LibraryService(bancoDeTeste(), catalogo);
  await biblioteca.saveProfile({
    spec: { id: "x", name: "X", model: modelo, connections: [{ connectionId: "fx", tools: { "fx/sum": "read", "fx/echo": true } }] },
  });
  const resolvido = await biblioteca.resolveProfile("x");
  assert.deepEqual(nomes(resolvido.tools), ["fx.pid", "fx.sum"]);
  assert.deepEqual(nomes(resolvido.confirmar), ["fx.echo"]);
});

test("a escolha por servidor e ferramenta separa instâncias que a chave antiga, só pelo nome, não separa", async () => {
  const catalogo = catalogoCom(
    { grafana: ["grafana-prod", "grafana-hml"] },
    { "grafana-prod": ["create_dashboard"], "grafana-hml": ["create_dashboard"] },
  );
  const biblioteca = new LibraryService(bancoDeTeste(), catalogo);
  await biblioteca.saveProfile({
    spec: { id: "x", name: "X", model: modelo, connections: [{ connectionId: "grafana", tools: { "grafana-hml/create_dashboard": true } }] },
  });
  assert.deepEqual(nomes((await biblioteca.resolveProfile("x")).confirmar), ["grafana-hml.create_dashboard"]);
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
  const { tools } = await biblioteca.resolveProfile("revisor");
  assert.equal(tools.filter((t) => t.tool === "get_issue").length, 1);
  assert.equal(tools.filter((t) => t.tool === "list_commits").length, 1);
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

test("a lista resume o que cada agent alcança, com a escrita ligada contada à parte", async () => {
  const biblioteca = new LibraryService(bancoDeTeste(), github);
  await biblioteca.saveProfile({
    spec: {
      id: "revisor",
      name: "Revisor",
      model: modelo,
      skills: ["revisao"],
      connections: [{ connectionId: "github", tools: { create_comment: true, merge_branch: true, get_issue: true, list_commits: false } }],
    },
  });
  const [resumo] = await biblioteca.listProfiles();
  assert.deepEqual(resumo?.connections, ["github"]);
  assert.equal(resumo?.writes, 2);
  assert.equal(resumo?.skills, 1);
});

test("a contagem de escrita ligada segue a anotação do servidor, e o nome só quando ele não anotou", async () => {
  const anotado = catalogoCom(
    { painel: ["painel"] },
    { painel: [{ name: "get_report", readOnlyHint: false }, { name: "get_data", destructiveHint: true }, { name: "pid", readOnlyHint: true }, "create_note"] },
  );
  const biblioteca = new LibraryService(bancoDeTeste(), anotado);
  await biblioteca.saveProfile({
    spec: {
      id: "anotado",
      name: "Anotado",
      model: modelo,
      // `get_report` e `get_data` leem pelo nome e escrevem pela anotação; `pid` é o contrário.
      connections: [{ connectionId: "painel", tools: { get_report: true, get_data: true, pid: true, create_note: true } }],
    },
  });
  const [resumo] = await biblioteca.listProfiles();
  assert.equal(resumo?.writes, 3);
});

test("conexão limitada começa sem nenhuma leitura, e a escolha da pessoa liga", async () => {
  const leituras = Array.from({ length: 31 }, (_, i) => `list-coisa-${i}`);
  const grande = catalogoCom({ ms365: ["ms365"] }, { ms365: [...leituras, "send-mail"] });
  const biblioteca = new LibraryService(bancoDeTeste(), grande);
  await biblioteca.saveProfile({
    spec: { id: "teams-agent", name: "Teams", model: modelo, connections: [{ connectionId: "ms365", tools: { "ms365/list-coisa-3": true }, leituraPadrao: "limitada" }] },
  });
  const resolvido = await biblioteca.resolveProfile("teams-agent");
  assert.deepEqual(nomes(resolvido.tools), ["ms365.list-coisa-3"]);
});

test("conexão limitada de servidor pequeno também não liga nada que não foi escolhido", async () => {
  const leituras = Array.from({ length: 5 }, (_, i) => `list-coisa-${i}`);
  const biblioteca = new LibraryService(bancoDeTeste(), catalogoCom({ ms365: ["ms365"] }, { ms365: leituras }));
  await biblioteca.saveProfile({ spec: { id: "t30", name: "T", model: modelo, connections: [{ connectionId: "ms365", leituraPadrao: "limitada" }] } });
  assert.equal((await biblioteca.resolveProfile("t30")).tools.length, 0);
});

test("agent salvo sem modo mantém toda leitura ligada, mesmo em servidor com mais de 30", async () => {
  const leituras = Array.from({ length: 31 }, (_, i) => `list-coisa-${i}`);
  const biblioteca = new LibraryService(bancoDeTeste(), catalogoCom({ ms365: ["ms365"] }, { ms365: [...leituras, "send-mail"] }));
  await biblioteca.saveProfile({ spec: { id: "antigo", name: "A", model: modelo, connections: [{ connectionId: "ms365" }] } });
  const resolvido = await biblioteca.resolveProfile("antigo");
  assert.equal(resolvido.tools.length, 31);
  assert.ok(resolvido.tools.every((t) => t.class === "read"));
});

/** Ferramenta nova do servidor nunca entra ligada: o que vale é a lista explícita. */

const catalogoGithub = (extra: string[] = []) =>
  catalogoCom({ github: ["github"] }, { github: ["get_issue", "list_commits", "get_pull_request", "pull_request_read", "create_comment", ...extra] });

test("ao gravar com a lista do servidor em cache, o agent fica com a lista explícita das ligadas de hoje", async () => {
  const biblioteca = new LibraryService(bancoDeTeste(), catalogoGithub());
  const salvo = await biblioteca.saveProfile({
    spec: { id: "pr-review", name: "PR", model: modelo, connections: [{ connectionId: "github", tools: { create_comment: false, list_commits: false } }] },
  });
  assert.equal(salvo.spec.connections[0]?.leituraPadrao, "limitada");
  assert.deepEqual(salvo.spec.connections[0]?.tools, {
    "github/get_issue": true,
    "github/get_pull_request": true,
    "github/pull_request_read": true,
    "github/list_commits": false,
    "github/create_comment": false,
  });
});

test("ferramenta nova do servidor fica desligada na execução", async () => {
  const bd = bancoDeTeste();
  await new LibraryService(bd, catalogoGithub()).saveProfile({
    spec: { id: "pr-review", name: "PR", model: modelo, connections: [{ connectionId: "github" }] },
  });
  const depois = new LibraryService(bd, catalogoGithub(["get_nova", "create_nova"]));
  const resolvido = await depois.resolveProfile("pr-review");
  assert.deepEqual(nomes(resolvido.tools), ["github.get_issue", "github.get_pull_request", "github.list_commits", "github.pull_request_read"]);
  assert.deepEqual(resolvido.confirmar, []);
});

test("a migração dos agents antigos preserva exatamente as ligadas de hoje e grava versão com a nota", async () => {
  const bd = bancoDeTeste();
  const semCache: CatalogoDeConexoes = { ...catalogoGithub(), guardadasDe: async () => null };
  const antigo = new LibraryService(bd, semCache);
  await antigo.saveProfile({
    spec: { id: "pr-review", name: "PR", model: modelo, connections: [{ connectionId: "github", tools: { create_comment: false, list_commits: false } }] },
  });
  const antes = nomes((await antigo.resolveProfile("pr-review")).tools);
  assert.equal((await antigo.getProfile("pr-review"))?.spec.connections[0]?.leituraPadrao, undefined, "sem cache segue o comportamento antigo");

  const comCache = new LibraryService(bd, catalogoGithub());
  const { migrados, pendentes } = await comCache.migrarListasExplicitas();
  assert.deepEqual(migrados, ["pr-review"]);
  assert.deepEqual(pendentes, []);
  const versao = await comCache.getProfile("pr-review");
  assert.equal(versao?.version, 2);
  assert.equal(versao?.note, "lista de ferramentas explícita");
  assert.deepEqual(nomes((await comCache.resolveProfile("pr-review")).tools), antes);
  assert.deepEqual((await comCache.migrarListasExplicitas()).migrados, [], "a segunda passada não grava nada");
});

test("sem lista em cache o agent segue como antes e a lista de agents o aponta até alguém salvar", async () => {
  const biblioteca = new LibraryService(bancoDeTeste(), catalogoCom({ github: ["github"] }, {}));
  await biblioteca.saveProfile({ spec: { id: "pr-review", name: "PR", model: modelo, connections: [{ connectionId: "github" }] } });
  assert.deepEqual((await biblioteca.migrarListasExplicitas()).pendentes, ["pr-review"]);
  assert.deepEqual((await biblioteca.listProfiles())[0]?.listaImplicita, ["github"]);
});

test("ferramentas novas no catálogo seguem como aviso depois da migração e de um save, e nenhuma versão nasce", async () => {
  const bd = bancoDeTeste();
  const semCache: CatalogoDeConexoes = { ...catalogoGithub(), guardadasDe: async () => null };
  await new LibraryService(bd, semCache).saveProfile({ spec: { id: "pr-review", name: "PR", model: modelo, connections: [{ connectionId: "github" }] } });

  const comNovas = new LibraryService(bd, catalogoGithub(["get_nova", "create_nova"]));
  assert.deepEqual((await comNovas.migrarListasExplicitas()).migrados, ["pr-review"]);
  const migrada = await comNovas.getProfile("pr-review");
  const tools = migrada?.spec.connections[0]?.tools ?? {};
  assert.deepEqual(Object.keys(tools).sort(), ["github/get_issue", "github/get_nova", "github/get_pull_request", "github/list_commits", "github/pull_request_read"]);
  assert.equal(Object.values(tools).every((v) => v === true), true, "só o que estava ligado foi gravado");
  assert.equal(tools["github/create_comment"], undefined);
  assert.equal(tools["github/create_nova"], undefined);

  const salvo = await comNovas.saveProfile({ spec: migrada!.spec });
  assert.equal(salvo.version, migrada!.version, "salvar sem mudança não cria versão");
  assert.deepEqual(salvo.spec.connections[0]?.tools, tools);
  assert.deepEqual((await comNovas.migrarListasExplicitas()).migrados, []);
});

test("a migração segue quando um agent falha, e diz qual foi e por quê", async () => {
  const bd = bancoDeTeste();
  const semCache: CatalogoDeConexoes = { ...catalogoGithub(), guardadasDe: async () => null };
  const antigo = new LibraryService(bd, semCache);
  await antigo.saveProfile({ spec: { id: "bom", name: "Bom", model: modelo, connections: [{ connectionId: "github" }] } });
  // Um agent com toolset que não existe mais: o `saveProfile` recusa.
  bd.insert(schema.agentProfiles).values({ id: "quebrado", name: "Quebrado" }).run();
  bd.insert(schema.agentProfileVersions)
    .values({ id: "v-quebrado", profileId: "quebrado", version: 1, spec: { id: "quebrado", name: "Quebrado", model: modelo, toolsets: ["sumiu"], connections: [{ connectionId: "github" }] } })
    .run();
  const resultado = await new LibraryService(bd, catalogoGithub()).migrarListasExplicitas();
  assert.deepEqual(resultado.migrados, ["bom"]);
  assert.deepEqual(resultado.falhas.map((f) => f.id), ["quebrado"]);
  assert.match(resultado.falhas[0]!.erro, /toolset inexistente: sumiu/);
});

test("dois processos migrando o mesmo agent deixam uma versão só", async () => {
  const bd = bancoDeTeste();
  const semCache: CatalogoDeConexoes = { ...catalogoGithub(), guardadasDe: async () => null };
  await new LibraryService(bd, semCache).saveProfile({ spec: { id: "pr-review", name: "PR", model: modelo, connections: [{ connectionId: "github" }] } });
  const [a, b] = await Promise.all([new LibraryService(bd, catalogoGithub()).migrarListasExplicitas(), new LibraryService(bd, catalogoGithub()).migrarListasExplicitas()]);
  assert.equal((await new LibraryService(bd, catalogoGithub()).getProfile("pr-review"))?.version, 2);
  assert.equal(a.migrados.length + b.migrados.length <= 2, true);
});
