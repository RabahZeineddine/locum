import { test } from "node:test";
import assert from "node:assert/strict";
import { MARCAS } from "../renderer/src/marcas.js";
import { marcaDoServidor } from "../renderer/lib/marca.js";

test("o host do endereço dá a marca, qualquer que seja o nome do servidor", () => {
  assert.equal(marcaDoServidor({ name: "gh", url: "https://api.githubcopilot.com/mcp/" }).chave, "github");
  assert.equal(marcaDoServidor({ name: "design", url: "https://mcp.figma.com/mcp" }).chave, "figma");
  assert.equal(marcaDoServidor({ name: "jira", url: "https://mcp.atlassian.com/v1/mcp" }).chave, "atlassian");
  assert.equal(marcaDoServidor({ name: "apm", url: "https://mcp.newrelic.com/mcp" }).chave, "newrelic");
});

test("Slack e Microsoft não têm logo no pacote: glifo com a cor da marca", () => {
  const slack = marcaDoServidor({ name: "slack", url: "https://mcp.slack.com/mcp" });
  assert.deepEqual([slack.chave, slack.glifo, slack.cor], [null, "slack", "4A154B"]);
  const ms = marcaDoServidor({ name: "ms365", command: ["npx", "-y", "@softeria/ms-365-mcp-server"] });
  assert.deepEqual([ms.chave, ms.glifo, ms.cor], [null, "teams", "5059C9"]);
  assert.equal(marcaDoServidor({ name: "outro", command: ["npx", "@softeria/ms-365-mcp-server@1.2.3"] }).glifo, "teams");
});

test("ferramentas de casa conhecidas pelo nome ou pelo comando", () => {
  assert.equal(marcaDoServidor({ name: "argocd", url: "http://localhost:3000/mcp" }).chave, "argo");
  assert.equal(marcaDoServidor({ name: "cd", command: ["npx", "argocd-mcp@latest"] }).chave, "argo");
  assert.equal(marcaDoServidor({ name: "datagrip", url: "http://127.0.0.1:64342/sse" }).chave, "datagrip");
  assert.equal(marcaDoServidor({ name: "ide", command: ["/Applications/DataGrip.app/Contents/jbr/bin/java"] }).chave, "datagrip");
  assert.equal(marcaDoServidor({ name: "jetbrains", url: "http://127.0.0.1:64342/sse" }).chave, "jetbrains");
});

test("marca conhecida sem logo no pacote (Context7, Waroom, Qulture) cai na inicial, com a cor de sempre", () => {
  const a = marcaDoServidor({ name: "context7", url: "https://mcp.context7.com/mcp" });
  assert.equal(a.chave, null);
  assert.equal(a.glifo, null);
  assert.equal(a.inicial, "C");
  assert.equal(marcaDoServidor({ name: "waroom" }).inicial, "W");
  assert.equal(marcaDoServidor({ name: "qulture", url: "https://mcp.qulture.rocks/x" }).inicial, "Q");
});

test("sem marca conhecida, inicial com cor estável por nome", () => {
  const a = marcaDoServidor({ name: "locum-ferramentas", url: "https://exemplo.test/mcp" });
  const b = marcaDoServidor({ name: "locum-ferramentas", url: "https://outro.test/mcp" });
  assert.equal(a.chave, null);
  assert.equal(a.glifo, null);
  assert.equal(a.inicial, "L");
  assert.equal(a.cor, b.cor, "a mesma cor para o mesmo nome");
  assert.match(a.cor, /^[0-9A-F]{6}$/);
  assert.notEqual(marcaDoServidor({ name: "locum-fixture" }).cor, "", "sempre uma cor");
});

test("toda chave de logo que o mapeamento devolve existe em MARCAS", () => {
  const entradas = [
    { name: "github" }, { name: "notion" }, { name: "figma" }, { name: "atlassian" }, { name: "linear" },
    { name: "sentry" }, { name: "newrelic" }, { name: "grafana" }, { name: "vercel" }, { name: "miro" },
    { name: "asana" }, { name: "posthog" }, { name: "intercom" }, { name: "shortcut" }, { name: "argocd" },
    { name: "datagrip" }, { name: "jetbrains" },
  ];
  for (const e of entradas) {
    const chave = marcaDoServidor(e).chave;
    assert.ok(chave !== null && MARCAS[chave] !== undefined, `${e.name} -> ${String(chave)}`);
  }
});
