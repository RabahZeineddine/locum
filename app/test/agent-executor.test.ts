import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { ApprovalGate } from "../src/approval/gate.js";
import { AgentSpec } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { Executor } from "../src/executor/executor.js";
import type { McpRegistry } from "../src/mcp/registry.js";
import type { Runtime, RuntimeRequest } from "../src/runtimes/types.js";
import { AgentService } from "../src/services/agent-service.js";
import { InitiativeService } from "../src/services/initiative-service.js";
import { LibraryService, type CatalogoDeConexoes } from "../src/services/library-service.js";
import { McpService } from "../src/services/mcp-service.js";
import { SkillsService } from "../src/services/skills-service.js";
import { claudeArgs } from "../src/runtimes/claude-code.js";
import { discoverSkills } from "../src/skills/loader.js";

/** Agent da biblioteca com conexões e orçamento, dentro do executor. */

before(() => {
  migrateDb();
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";
});

function runtimeQueRegistra(pedidos: RuntimeRequest[], tokens = 1): Runtime {
  return {
    id: "native",
    run: async (req) => {
      pedidos.push(req);
      return { text: "ok", promptTokens: tokens, completionTokens: 0, costUsd: 0, billable: true, toolsUsed: [] };
    },
  };
}

/** Registro que entrega o nome das ferramentas pedidas, sem subir servidor. */
const registroFalso = {
  missing: () => [],
  toolsFor: async (refs: { server: string; tool: string }[]) => ({
    tools: Object.fromEntries(refs.map((r) => [`${r.server}__${r.tool}`, {} as never])),
    release: () => undefined,
  }),
} as unknown as McpRegistry;

function catalogo(servidores: Record<string, string[]>, ferramentas: Record<string, string[]>): CatalogoDeConexoes {
  return {
    servidoresDe: async (id) => (servidores[id] ?? []).map((nome) => ({ nome, ligado: true })),
    ferramentasDe: async (s) => (ferramentas[s] ?? []).map((name) => ({ name })),
  };
}

async function fluxo(perfil: string, extra: Record<string, unknown> = {}) {
  const id = `fluxo-${randomUUID().slice(0, 8)}`;
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id,
      name: "Fluxo",
      steps: [{ type: "model", key: "tarefa", name: "tarefa", model: "ollama/x", prompt: "Resuma.", profile: perfil, ...extra }],
    }),
    undefined,
    "human",
  );
  return { id, versao };
}

const passo = async (runId: string, chave: string) =>
  (await db.select().from(schema.steps).where(and(eq(schema.steps.runId, runId), eq(schema.steps.stepKey, chave))))[0];

test("conexão sem servidor derruba o passo obrigatório, com o nome do agent e da conexão", async () => {
  const biblioteca = new LibraryService(db, catalogo({}, {}));
  const perfil = `sem-servidor-${randomUUID().slice(0, 8)}`;
  await biblioteca.saveProfile({ spec: { id: perfil, name: "Sem servidor", model: "ollama/x", connections: [{ connectionId: "jira" }] } });
  const pedidos: RuntimeRequest[] = [];
  const executor = new Executor({ mcp: registroFalso, runtimes: new Map([["native", runtimeQueRegistra(pedidos)]]), gate: new ApprovalGate(new Map()), machineId: "m", profiles: biblioteca });
  const { versao } = await fluxo(perfil);
  const runId = await executor.createRun(versao.id, null);
  assert.equal(await executor.execute(runId), "failed");
  const falho = await passo(runId, "tarefa");
  assert.equal(falho?.status, "failed");
  assert.match(falho?.error ?? "", new RegExp(`o agent "${perfil}" usa a conexão "jira", sem servidor ligado nesta máquina`));
  assert.equal(pedidos.length, 0);
});

test("o passo opcional é pulado com o motivo na atividade", async () => {
  const biblioteca = new LibraryService(db, catalogo({}, {}));
  const perfil = `opcional-${randomUUID().slice(0, 8)}`;
  await biblioteca.saveProfile({ spec: { id: perfil, name: "Opcional", model: "ollama/x", connections: [{ connectionId: "jira" }] } });
  const executor = new Executor({ mcp: registroFalso, runtimes: new Map([["native", runtimeQueRegistra([])]]), gate: new ApprovalGate(new Map()), machineId: "m", profiles: biblioteca });
  const { versao } = await fluxo(perfil, { optional: true });
  const runId = await executor.createRun(versao.id, null);
  assert.equal(await executor.execute(runId), "done");
  const pulado = await passo(runId, "tarefa");
  assert.equal(pulado?.status, "skipped");
  assert.match((pulado?.activity as { detalhe: string }[])[0]!.detalhe, /usa a conexão "jira"/);
});

test("em iniciativa só entram as instâncias da conexão que estão nela, e sem nenhuma o passo falha", async () => {
  const mcp = new McpService();
  for (const name of ["ini-a", "ini-b"]) if (!(await mcp.get(name))) await mcp.register({ name, transport: "stdio", command: ["true"] });
  const iniciativas = new InitiativeService();
  const slug = `frente-${randomUUID().slice(0, 8)}`;
  await iniciativas.upsert({ slug, title: "T", objective: "o", doneCriteria: "d" });
  await iniciativas.setServers(slug, ["ini-a"]);

  const biblioteca = new LibraryService(db, catalogo({ grafana: ["ini-a", "ini-b"], outra: ["ini-b"] }, { "ini-a": ["query_x"], "ini-b": ["query_x"] }));
  const perfil = `frente-${randomUUID().slice(0, 8)}`;
  await biblioteca.saveProfile({
    spec: { id: perfil, name: "Da frente", model: "ollama/x", connections: [{ connectionId: "grafana" }] },
  });
  const sem = `frente-sem-${randomUUID().slice(0, 8)}`;
  await biblioteca.saveProfile({ spec: { id: sem, name: "Sem", model: "ollama/x", connections: [{ connectionId: "outra" }] } });

  const pedidos: RuntimeRequest[] = [];
  const executor = new Executor({ mcp: registroFalso, runtimes: new Map([["native", runtimeQueRegistra(pedidos)]]), gate: new ApprovalGate(new Map()), machineId: "m", profiles: biblioteca });

  const dentro = await fluxo(perfil);
  await iniciativas.linkAgent(dentro.id, slug);
  const runOk = await executor.createRun(dentro.versao.id, null);
  assert.equal(await executor.execute(runOk), "done");
  assert.deepEqual(Object.keys(pedidos[0]!.tools), ["ini-a__query_x"]);

  const fora = await fluxo(sem);
  await iniciativas.linkAgent(fora.id, slug);
  const runFalha = await executor.createRun(fora.versao.id, null);
  assert.equal(await executor.execute(runFalha), "failed");
  assert.equal((await passo(runFalha, "tarefa"))?.error, "outside_initiative");
});

test("o teto por run do agent segue contando depois que o run volta da fila", async () => {
  const biblioteca = new LibraryService(db, catalogo({}, {}));
  const perfil = `retoma-${randomUUID().slice(0, 8)}`;
  await biblioteca.saveProfile({ spec: { id: perfil, name: "Retoma", model: "ollama/x", budget: { perRunTokens: 100 } } });
  const gate = new ApprovalGate(new Map([["teste.publicar", { publish: async () => undefined }]]));
  const pedidos: RuntimeRequest[] = [];
  const executor = new Executor({ mcp: registroFalso, runtimes: new Map([["native", runtimeQueRegistra(pedidos, 120)]]), gate, machineId: "m", profiles: biblioteca });
  const id = `fluxo-${randomUUID().slice(0, 8)}`;
  const versao = await new AgentService().upsert(
    AgentSpec.parse({
      id,
      name: "Fluxo",
      steps: [
        { type: "model", key: "a", name: "a", model: "ollama/x", prompt: "um", profile: perfil },
        { type: "action", key: "publicar", name: "Publicar", action: "teste.publicar", needs: ["a"] },
        { type: "model", key: "b", name: "b", model: "ollama/x", prompt: "dois", profile: perfil, needs: ["publicar"] },
      ],
    }),
    undefined,
    "human",
  );
  const runId = await executor.createRun(versao.id, null);
  assert.equal(await executor.execute(runId), "paused");
  const [pendencia] = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId));
  const decisao = await executor.decide(pendencia!.id, "approved");
  assert.equal(decisao.run, "paused");
  assert.equal(pedidos.length, 1);
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
  assert.match(run!.error ?? "", /teto do agent "Retoma": para mudar, abra Agents > Retoma > Orçamento/);
});

/** Skills do agent: a do Locum chega como a da máquina, e a que sumiu derruba o passo com o nome. */

function skillsEmDisco(): { catalogo: () => ReturnType<typeof discoverSkills>; servico: SkillsService; daMaquina: (nome: string) => void } {
  const raiz = mkdtempSync(join(tmpdir(), "locum-exec-skills-"));
  const home = join(raiz, "home");
  const locumDir = join(raiz, "locum");
  const servico = new SkillsService({ home, cwd: join(raiz, "projeto"), locumDir, agentes: async () => [] });
  return {
    catalogo: () => discoverSkills(home, join(raiz, "projeto"), locumDir),
    servico,
    daMaquina: (nome) => {
      mkdirSync(join(home, ".claude", "skills", nome), { recursive: true });
      writeFileSync(join(home, ".claude", "skills", nome, "SKILL.md"), `---\nname: ${nome}\ndescription: d\n---\nCorpo da ${nome}`);
    },
  };
}

test("a skill do Locum e a da máquina chegam inteiras no system, e o claude-code a recebe pelo mesmo texto", async () => {
  const { catalogo, servico, daMaquina } = skillsEmDisco();
  await servico.criar({ name: "so-do-locum", description: "d", body: "Corpo criada no Locum" });
  daMaquina("da-maquina");
  const biblioteca = new LibraryService(db, catalogo2());
  const perfil = `skills-${randomUUID().slice(0, 8)}`;
  await biblioteca.saveProfile({ spec: { id: perfil, name: "Com skills", model: "ollama/x", skills: ["so-do-locum", "da-maquina"] } });
  const pedidos: RuntimeRequest[] = [];
  const executor = new Executor({ mcp: registroFalso, runtimes: new Map([["native", runtimeQueRegistra(pedidos)]]), gate: new ApprovalGate(new Map()), machineId: "m", profiles: biblioteca, skills: catalogo() });
  const { versao } = await fluxo(perfil);
  const runId = await executor.createRun(versao.id, null);
  assert.equal(await executor.execute(runId), "done");
  const system = pedidos[0]!.system ?? "";
  assert.match(system, /## Skill: so-do-locum\n\nArquivos desta skill em: .*\n\nCorpo criada no Locum/);
  assert.match(system, /## Skill: da-maquina\n\nArquivos desta skill em: .*\n\nCorpo da da-maquina/);
  const usadas = (await passo(runId, "tarefa"))?.skillsUsed as { name: string }[];
  assert.deepEqual(usadas.map((s) => s.name).sort(), ["da-maquina", "so-do-locum"]);
  // O claude-code roda sem as configurações da máquina: o mesmo `system` vai no argumento, e é só por ele que a skill chega.
  const args = claudeArgs({ ...pedidos[0]!, provider: "claude-code", model: "claude-sonnet-5" });
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], system);
});

function catalogo2(): CatalogoDeConexoes {
  return catalogo({}, {});
}

test("skill que o agent usa e sumiu da máquina derruba o passo obrigatório com o nome, sem chamar o modelo", async () => {
  const { catalogo } = skillsEmDisco();
  const biblioteca = new LibraryService(db, catalogo2());
  const perfil = `sem-skill-${randomUUID().slice(0, 8)}`;
  await biblioteca.saveProfile({ spec: { id: perfil, name: "Sem skill", model: "ollama/x", skills: ["sumiu"] } });
  const pedidos: RuntimeRequest[] = [];
  const executor = new Executor({ mcp: registroFalso, runtimes: new Map([["native", runtimeQueRegistra(pedidos)]]), gate: new ApprovalGate(new Map()), machineId: "m", profiles: biblioteca, skills: catalogo() });
  const { versao } = await fluxo(perfil);
  const runId = await executor.createRun(versao.id, null);
  assert.equal(await executor.execute(runId), "failed");
  const falho = await passo(runId, "tarefa");
  assert.equal(falho?.status, "failed");
  assert.match(falho?.error ?? "", new RegExp(`o agent "${perfil}" usa a skill "sumiu", que não existe mais nesta máquina`));
  assert.equal(pedidos.length, 0);
});

test("skill ausente de uma regra que não casa com o evento não derruba o passo", async () => {
  const { catalogo } = skillsEmDisco();
  const biblioteca = new LibraryService(db, catalogo2());
  const perfil = `regra-fora-${randomUUID().slice(0, 8)}`;
  await biblioteca.saveProfile({ spec: { id: perfil, name: "Regra fora", model: "ollama/x", skills: [{ skill: "sumiu", when: { filesMatch: ["**/*.cs"] } }] } });
  const pedidos: RuntimeRequest[] = [];
  const executor = new Executor({ mcp: registroFalso, runtimes: new Map([["native", runtimeQueRegistra(pedidos)]]), gate: new ApprovalGate(new Map()), machineId: "m", profiles: biblioteca, skills: catalogo() });
  const { versao } = await fluxo(perfil);
  const runId = await executor.createRun(versao.id, null);
  assert.equal(await executor.execute(runId), "done");
  assert.equal(pedidos.length, 1);
});

test("o passo opcional com skill ausente é pulado com o motivo", async () => {
  const { catalogo } = skillsEmDisco();
  const biblioteca = new LibraryService(db, catalogo2());
  const perfil = `opc-skill-${randomUUID().slice(0, 8)}`;
  await biblioteca.saveProfile({ spec: { id: perfil, name: "Opc", model: "ollama/x", skills: ["sumiu"] } });
  const executor = new Executor({ mcp: registroFalso, runtimes: new Map([["native", runtimeQueRegistra([])]]), gate: new ApprovalGate(new Map()), machineId: "m", profiles: biblioteca, skills: catalogo() });
  const { versao } = await fluxo(perfil, { optional: true });
  const runId = await executor.createRun(versao.id, null);
  assert.equal(await executor.execute(runId), "done");
  assert.equal((await passo(runId, "tarefa"))?.status, "skipped");
});
