import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb } from "../src/db/migrate.js";
import { SecretService } from "../src/services/secret-service.js";
import { SettingsService } from "../src/services/settings-service.js";
import { TrackerService } from "../src/services/tracker-service.js";
import { db } from "../src/db/index.js";
import { JiraAtlassianAdapter } from "../src/trackers/jira-atlassian.js";

before(() => {
  migrateDb();
});

/** Cofre de verdade numa pasta de rascunho, com a cifra trocada por texto puro. */
function cofre(): SecretService {
  const secrets = new SecretService(mkdtempSync(join(tmpdir(), "locum-jira-atl-")));
  secrets.useBackend({
    available: () => true,
    encrypt: (plain) => Buffer.from(plain),
    decrypt: (blob) => blob.toString(),
  });
  return secrets;
}

/** Resposta no envelope que um servidor MCP devolve, com o JSON em texto. */
function envelope(valor: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(valor) }] };
}

interface Chamada {
  server?: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * O servidor da Atlassian de mentira, com o que as três ferramentas usadas
 * devolvem. O projeto vem com os tipos em português, que é o caso que fez o
 * adaptador escolher o tipo em vez de mandar `Task` fixo.
 */
function atlassianFalsa(chamadas: Chamada[]) {
  return async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    chamadas.push({ tool, args });
    if (tool === "getVisibleJiraProjects") {
      return envelope({
        values: [
          {
            key: "ABC",
            name: "Projeto ABC",
            issueTypes: [
              { name: "Subtarefa", subtask: true },
              { name: "Bug", subtask: false },
              { name: "Tarefa", subtask: false },
            ],
          },
          { key: "XYZ", name: "Outro" },
        ],
      });
    }
    if (tool === "searchJiraIssuesUsingJql") {
      const citou = String(args.jql).includes("/pull/42");
      return envelope({ issues: citou ? [{ key: "ABC-7", fields: { summary: "ja aberta" } }] : [] });
    }
    if (tool === "createJiraIssue") return envelope({ key: "ABC-8", id: "10008" });
    return { isError: true, content: [{ type: "text", text: `ferramenta ${tool} nao existe` }] };
  };
}

test("o adaptador manda o site como cloudId e monta o endereço da tarefa", async () => {
  const chamadas: Chamada[] = [];
  const jira = new JiraAtlassianAdapter("https://exemplo.atlassian.net/jira", atlassianFalsa(chamadas));

  const projetos = await jira.listProjects();
  assert.deepEqual(projetos, [
    { key: "ABC", name: "Projeto ABC" },
    { key: "XYZ", name: "Outro" },
  ]);
  assert.equal(chamadas[0]?.args.cloudId, "exemplo.atlassian.net");

  const achada = await jira.findByPullRequest("ABC", "https://github.com/dono/repo/pull/42");
  assert.deepEqual(achada, {
    key: "ABC-7",
    url: "https://exemplo.atlassian.net/browse/ABC-7",
    title: "ja aberta",
  });
  assert.equal(await jira.findByPullRequest("ABC", "https://github.com/dono/repo/pull/99"), null);
});

test("a criação usa o tipo de tarefa do projeto e leva o pull request no corpo", async () => {
  const chamadas: Chamada[] = [];
  const jira = new JiraAtlassianAdapter("https://exemplo.atlassian.net", atlassianFalsa(chamadas));

  const criada = await jira.createIssue({
    project: "ABC",
    title: "Corrigir a validação",
    body: "O achado da revisão.",
    labels: ["locum"],
    pullRequestUrl: "https://github.com/dono/repo/pull/42",
  });

  assert.deepEqual(criada, {
    key: "ABC-8",
    url: "https://exemplo.atlassian.net/browse/ABC-8",
    title: "Corrigir a validação",
  });
  const pedido = chamadas.find((c) => c.tool === "createJiraIssue")?.args;
  assert.equal(pedido?.issueTypeName, "Tarefa");
  assert.equal(pedido?.projectKey, "ABC");
  assert.equal(pedido?.contentFormat, "markdown");
  assert.match(String(pedido?.description), /pull\/42$/);
  assert.deepEqual(pedido?.additional_fields, { labels: ["locum"] });
});

test("erro da ferramenta vira exceção, e não lista vazia", async () => {
  const jira = new JiraAtlassianAdapter("https://exemplo.atlassian.net", async () => ({
    isError: true,
    content: [{ type: "text", text: "site sem acesso" }],
  }));
  await assert.rejects(jira.listProjects(), /site sem acesso/);
});

test("o tracker pela Atlassian usa a credencial da conexão e não guarda a sua", async () => {
  const secrets = cofre();
  const chamadas: Chamada[] = [];
  const falsa = atlassianFalsa(chamadas);
  const trackers = new TrackerService(db, secrets, new SettingsService(db), (server, tool, args) => {
    chamadas.push({ server, tool, args });
    return falsa(tool, args);
  });
  const id = `atl-${randomUUID().slice(0, 8)}`;

  // Sem e-mail e sem protocolo: o site basta, e o protocolo entra sozinho.
  await trackers.register({ id, kind: "jira-atlassian", label: "Jira", baseUrl: "exemplo.atlassian.net" });
  const cadastrado = (await trackers.list()).find((t) => t.id === id);
  assert.equal(cadastrado?.baseUrl, "https://exemplo.atlassian.net");
  assert.equal(cadastrado?.stored, false);

  // Sem a conexão autorizada, o teste responde de dentro da máquina.
  assert.deepEqual(await trackers.testConnection(id), { ok: false, reason: "missing" });
  assert.equal(chamadas.length, 0);

  await assert.rejects(trackers.setSecret(id, "token-de-mentira"), /conexão Atlassian/);

  secrets.set("mcp/atlassian", "token-da-conexao");
  assert.equal((await trackers.list()).find((t) => t.id === id)?.stored, true);

  const teste = await trackers.testConnection(id);
  assert.equal(teste.ok, true);
  assert.equal(teste.ok && teste.count, 2);
  assert.equal(chamadas[0]?.server, "atlassian");

  // Remover o tracker não pode levar junto a autorização da Atlassian, que
  // serve a outras coisas além dele.
  assert.equal(await trackers.remove(id), true);
  assert.equal(secrets.has("mcp/atlassian"), true);
});
