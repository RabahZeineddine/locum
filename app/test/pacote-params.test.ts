import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSpec } from "../src/config/types.js";
import { buildGate } from "../src/executor/build.js";
import { AgentService } from "../src/services/agent-service.js";
import { AutomationService } from "../src/services/automation-service.js";
import { LibraryService } from "../src/services/library-service.js";
import { PacoteService, type AmbienteDoPacote } from "../src/services/pacote-service.js";
import { TriggerService } from "../src/services/trigger-service.js";
import { bancoDeTeste } from "./helpers/db.js";

/** Os params dos passos de ação viajam como a ação declara (`paramsDoPacote`), e um só código aplica a declaração. */

const HOME = "/Users/ana.souza";
const j = (...partes: string[]): string => partes.join("");
const TOKEN = j("gh", "p_abcdefghijklmnopqrstuvwxyz0123456789");
const EMAIL = "ana.souza@empresa.com.br";
const CHAT = "19:abcdef0123456789abcdef0123456789@thread.v2";

const ambiente = (parte: Partial<AmbienteDoPacote> = {}): AmbienteDoPacote => ({
  conexoes: async () => [],
  servidores: async () => [],
  guardadas: async () => null,
  skills: async () => [],
  provedores: async () => [{ provedor: "claude-code", disponivel: true, modelos: ["claude-sonnet-5"] }],
  ...parte,
});

function maquina(parte: Partial<AmbienteDoPacote> = {}) {
  const db = bancoDeTeste();
  const agents = new AgentService(db);
  const automations = new AutomationService(agents, new TriggerService(db), {} as never);
  const library = new LibraryService(db, { servidoresDe: async () => [], ferramentasDe: async () => [] });
  return { automations, pacotes: new PacoteService(agents, library, automations, ambiente(parte), HOME) };
}

const base = { needs: [] as string[], optional: false };
const passoDeIA = { ...base, type: "model" as const, key: "revisar", name: "Revisar", model: "claude-code/claude-sonnet-5", prompt: "Revise o PR {{event.prNumber}}.", requiresServers: [], maxSteps: 12 };

function reviewDoTeams(): AgentSpec {
  return {
    id: "review-teams", name: "Review do Teams", defaultTools: [], skills: [], budget: {},
    steps: [
      { ...base, type: "action", key: "pegou", name: "Pegou", action: "teams.react", mode: "auto", params: { emoji: "👀", operacao: "set" } },
      passoDeIA,
      {
        ...base, type: "action", key: "publicar", name: "Publicar", needs: ["revisar"], action: "github.review_comment", mode: "approve", input: "revisar",
        params: { owner: "{{event.prOwner}}", repo: "{{event.prRepo}}", pull: "{{event.prNumber}}" },
      },
      {
        ...base, type: "action", key: "veredito", name: "Veredito", needs: ["revisar"], action: "teams.react", mode: "approve",
        params: {
          operacao: "set", tirar: "👀",
          porValor: { de: "{{steps.revisar.verdict}}", mapa: { APPROVE: "✅", REQUEST_CHANGES: "⚠️" }, padrao: "💬" },
        },
      },
    ],
  } as AgentSpec;
}

async function ida(spec: AgentSpec, parte: Partial<AmbienteDoPacote> = {}, triggers: { config: unknown; enabled: boolean }[] = []) {
  const dono = maquina(parte);
  await dono.automations.save({ spec, triggers: triggers as never, note: "", create: true });
  const { texto, pacote } = await dono.pacotes.exportar(spec.id);
  const bruno = maquina(parte);
  const previa = await bruno.pacotes.previa(texto);
  const resultado = await bruno.pacotes.importar(texto);
  const importada = (await bruno.automations.get(spec.id))!.version.spec;
  const gatilhos = (await bruno.automations.get(spec.id))!.triggers.map((g) => g.config);
  return { texto, pacote, previa, resultado, importada, gatilhos };
}

test("review de PR do Teams: os params dos passos voltam iguais", async () => {
  const spec = reviewDoTeams();
  const { importada, pacote } = await ida(spec);
  const params = (s: AgentSpec, k: string) => {
    const p = s.steps.find((x) => x.key === k);
    return p?.type === "action" ? p.params : undefined;
  };
  for (const k of ["pegou", "publicar", "veredito"]) assert.deepEqual(params(importada, k), params(spec, k), k);
  assert.ok(!pacote.omitidos.some((o) => o.codigo === "argumentos"), "nada ficou de fora");
});

test("destino fixo não viaja: vira destino a escolher na prévia e na importação; evento e novo viajam", async () => {
  const spec = reviewDoTeams();
  spec.steps.push(
    { ...base, type: "action", key: "fixo", name: "Fixo", needs: ["revisar"], action: "teams.post", mode: "approve", input: "revisar", params: { destino: { tipo: "fixo", conversa: { app: "teams", ref: `chat/${CHAT}`, rotulo: "Equipe" } } } },
    { ...base, type: "action", key: "novo", name: "Novo", needs: ["revisar"], action: "teams.post", mode: "approve", input: "revisar", params: { destino: { tipo: "novo" } } },
  );
  const { texto, previa, resultado, importada } = await ida(spec);
  assert.ok(!texto.includes(CHAT) && !texto.includes("Equipe"));
  assert.deepEqual(previa.omitidos.filter((o) => o.codigo === "destino-a-escolher"), [{ codigo: "destino-a-escolher", onde: "fixo", quantos: 1, params: ["destino"] }]);
  assert.deepEqual(resultado.pendencias.filter((p) => p.codigo === "destino-a-escolher"), [{ codigo: "destino-a-escolher", onde: "fixo", params: ["destino"] }]);
  const params = (k: string) => {
    const p = importada.steps.find((x) => x.key === k);
    return p?.type === "action" ? p.params : undefined;
  };
  assert.equal(params("fixo")?.destino, undefined);
  assert.deepEqual(params("novo"), { destino: { tipo: "novo" } });
});

test("mcp.call: marcador viaja, literal é limpo, credencial e argumento sensível do esquema saem por nome", async () => {
  const esquema = { type: "object", properties: { chave: { type: "string", writeOnly: true } } };
  const spec = reviewDoTeams();
  spec.steps.push({
    ...base, type: "action", key: "chamar", name: "Chamar", needs: ["revisar"], action: "mcp.call", mode: "approve",
    params: {
      server: "ms365", tool: "enviar",
      args: { texto: "{{steps.revisar.resumo}}", prioridade: 2, nota: `fale com ${EMAIL}`, token: `Bearer ${TOKEN}`, chave: "valor-qualquer", chat: CHAT, titulo: "Revisão pronta" },
      headers: { Authorization: `Bearer ${TOKEN}` },
    },
  });
  const { texto, pacote, resultado, importada } = await ida(spec, { guardadas: async () => [{ name: "enviar", inputSchema: esquema }] });
  for (const proibido of [TOKEN, EMAIL, CHAT, "valor-qualquer", HOME]) assert.ok(!texto.includes(proibido), `vazou ${proibido}`);
  const passo = importada.steps.find((p) => p.key === "chamar");
  assert.deepEqual(passo?.type === "action" && passo.params, {
    server: "ms365", tool: "enviar", args: { texto: "{{steps.revisar.resumo}}", prioridade: 2, titulo: "Revisão pronta" },
  });
  const omitido = pacote.omitidos.find((o) => o.onde === "chamar" && o.codigo === "argumentos");
  assert.deepEqual([...omitido!.params!].sort(), ["args.chat", "args.chave", "args.nota", "args.token", "headers"]);
  assert.ok(resultado.pendencias.some((p) => p.onde === "chamar" && p.params?.includes("args.token")));
});

test("http.request: só a origem viaja, o resto fica a preencher por nome", async () => {
  const spec = reviewDoTeams();
  spec.steps.push({
    ...base, type: "action", key: "hook", name: "Hook", needs: ["revisar"], action: "http.request", mode: "approve",
    params: { method: "POST", url: "https://api.exemplo.com/v1/x?token=abc", headers: { "X-Key": "k" }, body: `{"a":"${EMAIL}"}` },
  });
  const { texto, previa, pacote } = await ida(spec);
  assert.ok(!texto.includes(EMAIL) && !texto.includes("token=abc") && !texto.includes('"X-Key"'));
  assert.deepEqual(previa.urlsAPreencher, [{ passo: "hook", origem: "https://api.exemplo.com" }]);
  const passo = pacote.automacao.spec.steps.find((p) => p.key === "hook");
  assert.equal(passo?.type === "action" && passo.params?.method, "POST");
  assert.deepEqual(pacote.omitidos.find((o) => o.onde === "hook" && o.codigo === "argumentos")?.params, ["headers"]);
});

test("pacote mexido à mão: o que a ação não deixa viajar não entra na importação", async () => {
  const dono = maquina();
  await dono.automations.save({ spec: reviewDoTeams(), triggers: [], note: "", create: true });
  const pacote = JSON.parse((await dono.pacotes.exportar("review-teams")).texto);
  pacote.automacao.spec.steps[2].params.owner = "empresa-ana";
  pacote.automacao.spec.steps[0].params.destino = { tipo: "fixo", conversa: { app: "teams", ref: "chat/x" } };
  const bruno = maquina();
  const r = await bruno.pacotes.importar(JSON.stringify(pacote));
  const spec = (await bruno.automations.get("review-teams"))!.version.spec;
  const de = (k: string) => spec.steps.find((p) => p.key === k);
  const params = (k: string) => { const p = de(k); return p?.type === "action" ? p.params : undefined; };
  assert.equal(params("publicar")?.owner, undefined);
  assert.equal(params("publicar")?.repo, "{{event.prRepo}}");
  assert.ok(r.pendencias.some((p) => p.onde === "publicar" && p.params?.includes("owner")));
  assert.equal(params("pegou")?.destino, undefined);
  assert.ok(r.pendencias.some((p) => p.onde === "pegou" && p.params?.includes("destino")));
});

test("toda ação registrada declara como seus params viajam", () => {
  const sem = buildGate().describe().filter((a) => a.paramsDoPacote === undefined).map((a) => a.kind);
  assert.deepEqual(sem, []);
});

test("gatilho mcp-poll: marcador e literal limpo viajam, credencial sai por nome, e o que é da pessoa (canal do Slack) vira a escolher", async () => {
  const gatilhos = [
    { config: { kind: "mcp-poll", server: "feed", tool: "listar", args: { q: "{{event.termo}}", limite: 5, token: `Bearer ${TOKEN}`, dono: EMAIL }, everyMinutes: 15 }, enabled: true },
    { config: { kind: "slack-channel", channels: ["C0123ABCD45"], everyMinutes: 5 }, enabled: true },
  ];
  const { texto, pacote, gatilhos: importados, resultado } = await ida(reviewDoTeams(), {}, gatilhos);
  for (const proibido of [TOKEN, EMAIL, "C0123ABCD45"]) assert.ok(!texto.includes(proibido), `vazou ${proibido}`);
  assert.deepEqual(importados.find((g) => g.kind === "mcp-poll"), { kind: "mcp-poll", server: "feed", tool: "listar", args: { q: "{{event.termo}}", limite: 5 }, everyMinutes: 15 });
  assert.deepEqual(pacote.omitidos.find((o) => o.onde === "gatilho:0" && o.codigo === "argumentos")?.params?.sort(), ["args.dono", "args.token"]);
  assert.deepEqual(pacote.omitidos.find((o) => o.codigo === "canais"), { codigo: "canais", onde: "gatilho:1", quantos: 1, params: ["channels"] });
  assert.ok(resultado.pendencias.some((p) => p.codigo === "gatilho-sem-canal" && p.onde === "gatilho:1"));
});
