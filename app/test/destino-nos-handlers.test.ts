import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ApprovalGate } from "../src/approval/gate.js";
import { AgentSpec } from "../src/config/types.js";
import { db, schema } from "../src/db/index.js";
import { migrateDb } from "../src/db/migrate.js";
import { Executor } from "../src/executor/executor.js";
import { McpRegistry } from "../src/mcp/registry.js";
import { AgentService } from "../src/services/agent-service.js";
import { slackPostHandler } from "../src/slack/action.js";
import { slackReactHandler } from "../src/slack/react-action.js";
import { teamsPostHandler } from "../src/teams/action.js";
import { teamsReactHandler } from "../src/teams/react-action.js";
import { bancoDeTeste } from "./helpers/db.js";

/** O destino da resposta e da reação, pelos handlers e pelo executor. Sem rede: tudo falso. */

before(() => {
  migrateDb();
});

const lido = (banco: ReturnType<typeof bancoDeTeste>) =>
  banco.insert(schema.events).values({
    id: "ev1",
    source: "teams",
    externalId: "t:1",
    payload: { repo: "teams/19:dm", chatId: "19:dm", text: "pode olhar?", author: "Ana", webUrl: "https://x/1" },
  });

const fixo = (app: string, ref: string, rotulo: string) => ({ tipo: "fixo", conversa: { app, ref, rotulo } });

test("teams.post: destino fixo em chat não depende do gatilho ter lido a conversa, e a Fila mostra o rótulo", async () => {
  const handler = teamsPostHandler({ db: bancoDeTeste(), token: async () => "t" });
  const p = await handler.propose!({ text: "oi", destino: fixo("teams", "chat/19:time", "Time de plataforma") }, null);
  assert.deepEqual(p, {
    chatId: "19:time",
    text: "oi",
    subject: "",
    author: null,
    webUrl: null,
    destino: { tipo: "fixo", rotulo: "Time de plataforma" },
  });
});

test("teams.post: destino fixo em canal vira mensagem nova no canal, sem thread", async () => {
  const handler = teamsPostHandler({ db: bancoDeTeste(), token: async () => "t" });
  const p = (await handler.propose!({ text: "oi", destino: fixo("teams", "canal/T1/C1", "Equipe > Geral") }, null)) as {
    channel: object;
  };
  assert.deepEqual(p.channel, { teamId: "T1", channelId: "C1", label: "Equipe > Geral" });
});

test("teams.post: novo no canal do evento usa o mesmo canal e tira a thread; evento mantém a thread", async () => {
  const banco = bancoDeTeste();
  await banco.insert(schema.events).values({
    id: "c1",
    source: "teams",
    externalId: "t:c1",
    payload: { repo: "teams-channel/T1/C1/9", teamId: "T1", channelId: "C1", threadId: "9", channel: "Geral", text: "oi", author: "Ana" },
  });
  const handler = teamsPostHandler({ db: banco, token: async () => "t" });
  const evento = { repo: "teams-channel/T1/C1/9", text: "resposta" };

  const noFio = (await handler.propose!(evento, null)) as { channel: { threadId?: string }; destino: unknown };
  assert.equal(noFio.channel.threadId, "9");
  assert.deepEqual(noFio.destino, { tipo: "evento", rotulo: null });

  const novo = (await handler.propose!({ ...evento, destino: { tipo: "novo" } }, null)) as {
    channel: { threadId?: string; channelId: string };
  };
  assert.equal(novo.channel.threadId, undefined);
  assert.equal(novo.channel.channelId, "C1");
});

test("teams.post: sem o parâmetro responde como sempre, e destino de outro app é recusado", async () => {
  const banco = bancoDeTeste();
  await lido(banco);
  const handler = teamsPostHandler({ db: banco, token: async () => "t" });
  const p = await handler.propose!({ repo: "teams/19:dm", text: "ok" }, null);
  assert.equal((p as { subject: string }).subject, "pode olhar?");
  await assert.rejects(handler.propose!({ text: "x", destino: fixo("slack", "C1", "x") }, null), /fala com teams/);
});

const slackFalso = { get: async () => ({ server: "slack" }) } as never;
const lookup = async (_s: string, channel: string, threadTs: string) => ({ channel, threadTs, subject: "assunto", permalink: null });

test("slack.post: destino fixo manda para o canal escolhido, sem thread e sem conferir leitura", async () => {
  const handler = slackPostHandler({ slack: slackFalso, lookup: async () => null });
  const p = await handler.propose!({ text: "oi", destino: fixo("slack", "C9", "#geral") }, null);
  assert.deepEqual(p, {
    server: "slack",
    channel: "C9",
    text: "oi",
    destino: { tipo: "fixo", rotulo: "#geral" },
    subject: "",
    permalink: null,
  });
});

test("slack.post: novo fica no canal do evento fora do fio; evento exige o carimbo da thread", async () => {
  const handler = slackPostHandler({ slack: slackFalso, lookup });
  const evento = { repo: "slack/C1", text: "resposta" };
  const novo = (await handler.propose!({ ...evento, destino: { tipo: "novo" } }, null)) as { channel: string; threadTs?: string };
  assert.equal(novo.channel, "C1");
  assert.equal(novo.threadTs, undefined);
  await assert.rejects(handler.propose!(evento, null), /threadTs/);
  const noFio = (await handler.propose!({ ...evento, threadTs: "1.1" }, null)) as { threadTs: string };
  assert.equal(noFio.threadTs, "1.1");
});

test("reação só aceita a mensagem do evento", async () => {
  const campos = { emoji: "👀", teamsChatId: "19:a", teamsMessageId: "1", slackChannel: "C1", slackTs: "1.1" };
  await assert.rejects(
    teamsReactHandler({}).propose!({ ...campos, destino: { tipo: "novo" } }, null),
    /reação só cai na mensagem do evento/,
  );
  await assert.rejects(
    slackReactHandler({ slack: slackFalso }).propose!({ ...campos, destino: fixo("slack", "C2", "x") }, null),
    /reação só cai na mensagem do evento/,
  );
  const ok = await teamsReactHandler({}).propose!({ ...campos, destino: { tipo: "evento" } }, null);
  assert.equal((ok as { emoji: string }).emoji, "👀");
});

const registroFalso = { missing: () => [], toolsFor: async () => ({ tools: {}, release: () => undefined }) } as unknown as McpRegistry;

async function rodar(params: Record<string, unknown> | undefined, saida: Record<string, unknown> = {}) {
  const gate = new ApprovalGate(new Map([["teams.post", teamsPostHandler({ db, token: async () => "t" })]]));
  const executor = new Executor({ mcp: registroFalso, runtimes: new Map(), gate, machineId: "m" });
  const passo = {
    type: "action",
    key: "responder",
    name: "Responder",
    action: "teams.post",
    mode: "approve",
    ...(params === undefined ? {} : { params }),
  };
  const versao = await new AgentService().upsert(
    AgentSpec.parse({ id: `dest-${randomUUID().slice(0, 8)}`, name: "Destino", steps: [passo] }),
    undefined,
    "human",
  );
  const eventoId = randomUUID();
  await db.insert(schema.events).values({ id: eventoId, source: "manual", externalId: `m:${eventoId}`, payload: { ...saida } });
  const runId = await executor.createRun(versao.id, eventoId);
  const estado = await executor.execute(runId);
  const [linha] = await db.select().from(schema.steps).where(eq(schema.steps.runId, runId));
  return { estado, passo: linha! };
}

test("gravar: marcador de passo no destino é recusado, e reação com destino que não seja o evento também", async () => {
  await assert.rejects(rodar({ text: "oi", destino: fixo("teams", "{{steps.revisar.chat}}", "x") }), /não aceita marcador/);
  await assert.rejects(
    new AgentService().upsert(
      AgentSpec.parse({
        id: `dest-${randomUUID().slice(0, 8)}`,
        name: "Reação",
        steps: [{ type: "action", key: "r", name: "r", action: "slack.react", mode: "approve", params: { emoji: "👀", destino: { tipo: "novo" } } }],
      }),
      undefined,
      "human",
    ),
    /reação só cai na mensagem do evento/,
  );
});

test("executor: destino fixo gravado no passo chega ao handler e a pendência mostra o rótulo", async () => {
  const { passo } = await rodar({ text: "oi", destino: fixo("teams", "chat/19:time", "Time") });
  assert.equal(passo.status, "awaiting_approval");
  const [pendencia] = await db.select().from(schema.approvals).where(eq(schema.approvals.stepId, passo.id));
  const payload = pendencia!.payload as { destino: { tipo: string; rotulo: string }; chatId: string };
  assert.equal(payload.chatId, "19:time");
  assert.deepEqual(payload.destino, { tipo: "fixo", rotulo: "Time" });
});
