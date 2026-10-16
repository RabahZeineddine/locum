import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "../src/db/index.js";
import { AgentSpec } from "../src/config/types.js";
import { AgentService } from "../src/services/agent-service.js";
import { AutomationService } from "../src/services/automation-service.js";
import { EventoManual } from "../src/services/evento-manual.js";
import { ExecutionService } from "../src/services/execution-service.js";
import { TriggerService } from "../src/services/trigger-service.js";
import type { PrContext } from "../src/sources/github.js";
import { bancoDeTeste } from "./helpers/db.js";

/** "Executar com": o evento recente ou o link colado, montados como o gatilho montaria. */

const pr = (owner: string, repo: string, pull: number): PrContext => ({
  repo: `${owner}/${repo}`,
  owner,
  repoName: repo,
  pull,
  title: "Corrige o fechamento do lote",
  description: "Descrição do PR",
  headSha: "abc123",
  changedFiles: ["a.ts"],
  diff: "diff --git a/a.ts b/a.ts",
  author: "maria",
  baseBranch: "main",
  headBranch: "fix/lote",
  url: `https://github.com/${owner}/${repo}/pull/${pull}`,
  additions: 3,
  deletions: 1,
  fileCount: 1,
  draft: false,
});

function montar() {
  const db = bancoDeTeste();
  const agents = new AgentService(db);
  const triggers = new TriggerService(db);
  const iniciados: { eventId: string | null; agentId?: string }[] = [];
  const executions = {
    startForEvent: async (input: { eventId: string | null; agentId?: string }) => {
      iniciados.push(input);
      return { runId: `run-${iniciados.length}`, status: "queued" };
    },
  } as unknown as ExecutionService;
  const buscados: string[] = [];
  const fetchPr = async (owner: string, repo: string, pull: number) => {
    buscados.push(`${owner}/${repo}#${pull}`);
    return pr(owner, repo, pull);
  };
  const eventos = new EventoManual(db, fetchPr, new ExecutionService(db, agents));
  return { db, agents, automations: new AutomationService(agents, triggers, executions, eventos), eventos, iniciados, buscados };
}

const REVISAR = [
  { type: "model", key: "revisar", name: "revisar", model: "ollama/x", prompt: "Revise {{event.repo}}#{{event.prNumber}}\n{{event.diff}}" },
  { type: "action", key: "responder", name: "responder", action: "teams.post", mode: "approve", input: "revisar", needs: ["revisar"] },
];
const LIVRE = [{ type: "model", key: "resumo", name: "resumo", model: "ollama/x", prompt: "Resuma o dia" }];

async function salvar(agents: AgentService, steps: unknown[]) {
  const id = `auto-${randomUUID().slice(0, 8)}`;
  await agents.upsert(AgentSpec.parse({ id, name: "Revisar PRs", steps }), undefined, "human");
  return id;
}

test("o link colado vira o evento enriquecido como o gatilho do Teams monta, sem campos de conversa", async () => {
  const { db, eventos, buscados } = montar();
  const { eventId } = await eventos.doLink("https://github.com/akad/pagamentos/pull/482", "auto-x");
  assert.deepEqual(buscados, ["akad/pagamentos#482"]);

  const [linha] = await db.select().from(schema.events).where(eq(schema.events.id, eventId));
  assert.equal(linha!.source, "manual");
  const p = linha!.payload as Record<string, unknown>;
  assert.equal(p.repo, "akad/pagamentos");
  assert.equal(p.prOwner, "akad");
  assert.equal(p.prRepo, "pagamentos");
  assert.equal(p.prNumber, 482);
  assert.equal(p.title, "Corrige o fechamento do lote");
  assert.equal(p.description, "Descrição do PR");
  assert.equal(p.diff, "diff --git a/a.ts b/a.ts");
  assert.equal(p.semConversa, true);
  assert.equal(p.chatId, null);
  assert.equal(p.messageId, null);
  assert.equal(p.text, "");
  // O evento colado leva a lista de um PR, como o do gatilho, e o texto pronto para o prompt.
  const prs = p.prs as { prNumber: number; title: string }[];
  assert.deepEqual(prs.map((x) => [x.prNumber, x.title]), [[482, "Corrige o fechamento do lote"]]);
  assert.match(String(p.prsTexto), /akad\/pagamentos#482[\s\S]*diff --git a\/a\.ts/);
});

test("link que não é de pull request do GitHub é recusado sem buscar nada", async () => {
  const { eventos, buscados } = montar();
  await assert.rejects(eventos.doLink("https://example.com/x", "auto-x"), /link de um pull request do GitHub/);
  assert.deepEqual(buscados, []);
});

test("Executar agora sem evento recusa antes do primeiro passo, com a mensagem clara", async () => {
  const { agents, automations, iniciados } = montar();
  const id = await salvar(agents, REVISAR);
  await assert.rejects(
    automations.runNow(id),
    /esta automação precisa de um evento \(usa \{\{event\.repo\}\}\); escolha um evento recente ou cole um link/,
  );
  assert.deepEqual(iniciados, []);
});

test("automação que não depende de evento roda sem ele", async () => {
  const { agents, automations, iniciados } = montar();
  const id = await salvar(agents, LIVRE);
  await automations.runNow(id);
  assert.equal(iniciados[0]!.eventId, null);
});

test("prUrl monta o evento e dispara o run apontando para ele; eventId existente também vale", async () => {
  const { agents, automations, iniciados, db } = montar();
  const id = await salvar(agents, REVISAR);
  const { runId } = await automations.runNow(id, { prUrl: "https://github.com/akad/pagamentos/pull/9" });
  assert.equal(runId, "run-1");
  const eventId = iniciados[0]!.eventId!;
  assert.ok((await db.select().from(schema.events).where(eq(schema.events.id, eventId))).length === 1);

  await automations.runNow(id, { eventId });
  assert.equal(iniciados[1]!.eventId, eventId);

  await assert.rejects(automations.runNow(id, { eventId: "nao-existe" }), /evento nao-existe nao encontrado/);
  await assert.rejects(automations.runNow(id, { eventId, prUrl: "https://github.com/a/b/pull/1" }), /eventId ou prUrl/);
});

test("eventId só vale para evento que já virou run desta automação ou evento colado para ela", async () => {
  const { db, agents, automations, eventos, iniciados } = montar();
  const id = await salvar(agents, REVISAR);
  const outra = await salvar(agents, REVISAR);
  const versao = (await agents.getLatestVersion(id))!;

  // Evento de um gatilho que abriu run nesta automação: vale.
  const dela = randomUUID();
  await db.insert(schema.events).values({ id: dela, source: "teams", externalId: dela, payload: { repo: "o/r" } });
  await db.insert(schema.runs).values({ id: randomUUID(), agentVersionId: versao.id, eventId: dela, status: "done" });
  await automations.runNow(id, { eventId: dela });
  assert.equal(iniciados[0]!.eventId, dela);

  // Evento que nunca virou run dela, de outra fonte: recusa.
  const alheio = randomUUID();
  await db.insert(schema.events).values({ id: alheio, source: "teams", externalId: alheio, payload: { repo: "o/r" } });
  await assert.rejects(automations.runNow(id, { eventId: alheio }), /não é um evento desta automação/);

  // Evento colado para outra automação: recusa; para esta: vale.
  const colado = (await eventos.doLink("https://github.com/o/r/pull/5", outra)).eventId;
  await assert.rejects(automations.runNow(id, { eventId: colado }), /não é um evento desta automação/);
  const meu = (await eventos.doLink("https://github.com/o/r/pull/5", id)).eventId;
  assert.notEqual(meu, colado);
  await automations.runNow(id, { eventId: meu });
  assert.equal(iniciados.at(-1)!.eventId, meu);
  assert.equal(iniciados.length, 2);
});

test("eventsForRun diz se a automação depende de evento e lista os recentes do gatilho, sem os colados", async () => {
  const { db, agents, automations, eventos } = montar();
  const id = await salvar(agents, REVISAR);
  const versao = (await agents.getLatestVersion(id))!;
  const grava = async (source: string, payload: object, depois: number) => {
    const eventId = randomUUID();
    await db.insert(schema.events).values({ id: eventId, source, externalId: eventId, payload, receivedAt: 1_000 + depois });
    await db.insert(schema.runs).values({ id: randomUUID(), agentVersionId: versao.id, eventId, status: "done", createdAt: 1_000 + depois });
    return eventId;
  };
  const antigo = await grava("teams", { repo: "o/r", prNumber: 1, teamsAuthor: "Ana", text: "olha esse PR https://github.com/o/r/pull/1" }, 1);
  const recente = await grava("github", { repo: "o/api", pull: 2, title: "Ajusta timeout", author: "bia" }, 2);
  await eventos.doLink("https://github.com/o/r/pull/3", id);
  await grava("manual", { repo: "o/r", pull: 3, author: "x" }, 3);

  const ctx = await automations.eventsForRun(id);
  assert.deepEqual(ctx.precisaDeEvento, { codigo: "marcador", marcador: "{{event.repo}}" });
  assert.deepEqual(ctx.recentes.map((e) => e.id), [recente, antigo]);
  assert.deepEqual(
    { source: ctx.recentes[0]!.source, author: ctx.recentes[0]!.author, trecho: ctx.recentes[0]!.trecho, at: ctx.recentes[0]!.at },
    { source: "github", author: "bia", trecho: "Ajusta timeout", at: 1_002 },
  );
  assert.equal(ctx.recentes[1]!.author, "Ana");
  assert.match(ctx.recentes[1]!.trecho, /olha esse PR/);

  const livre = await salvar(agents, LIVRE);
  assert.equal((await automations.eventsForRun(livre)).precisaDeEvento, null);

  // Ação em modo auto: o diálogo avisa que o evento recente publica de verdade.
  assert.deepEqual(ctx.acoesAuto, []);
  const auto = await salvar(agents, [REVISAR[0]!, { ...REVISAR[1]!, mode: "auto" }]);
  assert.deepEqual((await automations.eventsForRun(auto)).acoesAuto, ["teams.post"]);
});
