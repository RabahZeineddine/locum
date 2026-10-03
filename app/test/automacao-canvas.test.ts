import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentSpec } from "../src/config/types.js";
import {
  adicionarPasso,
  arestas,
  desligar,
  FORMATOS,
  ligar,
  MODELOS,
  PASSOS,
  posicoes,
  problemas,
  rascunhoDoModelo,
  removerPasso,
  variaveis,
  type Rascunho,
} from "../renderer/lib/automacao.js";

/** O canvas da automação: as funções puras que mexem no spec. */

const ctx = { slackConectado: true, teamsConectado: false, trackers: ["jira"] };

function slackJira(): Rascunho {
  return rascunhoDoModelo("slackJira", "suporte", "Suporte", "jira");
}

test("todo modelo de automação nova é um spec válido", () => {
  for (const modelo of MODELOS) {
    const r = rascunhoDoModelo(modelo, "x-1", "X", "jira");
    assert.doesNotThrow(() => AgentSpec.parse(r.spec), modelo);
    assert.equal(r.gatilhos.every((g) => g.enabled === false), true, modelo);
  }
});

test("gatilho aponta para os passos sem dependência, e a seta dele é fixa", () => {
  const r = slackJira();
  const lista = arestas(r);
  const fixas = lista.filter((a) => a.fixa);
  assert.deepEqual(fixas.map((a) => a.id), ["gatilho-1->analisar"]);
  assert.deepEqual(
    lista.filter((a) => !a.fixa).map((a) => a.id),
    ["analisar->abrir-tarefa", "abrir-tarefa->escrever", "escrever->responder"],
  );
});

test("o que foi arrastado vence o arranjo automático, e gatilho fica à esquerda", () => {
  const r = slackJira();
  const antes = posicoes(r);
  assert.equal(antes.get("gatilho-1")?.x, 0);
  assert.ok((antes.get("analisar")?.x ?? 0) > 0);

  r.spec = { ...r.spec, layout: { analisar: { x: 999, y: 7 } } };
  assert.deepEqual(posicoes(r).get("analisar"), { x: 999, y: 7 });
});

test("ligar recusa ciclo e seta para dentro de gatilho", () => {
  const r = slackJira();
  assert.deepEqual(ligar(r.spec, "responder", "analisar"), { erro: "automations.canvas.errors.cycle" });
  assert.deepEqual(ligar(r.spec, "analisar", "gatilho-1"), { erro: "automations.canvas.errors.intoTrigger" });

  const ok = ligar(r.spec, "analisar", "escrever");
  assert.ok("spec" in ok);
  assert.deepEqual(ok.spec.steps.find((p) => p.key === "escrever")?.needs, ["abrir-tarefa", "analisar"]);
});

test("desligar a seta de entrada de uma ação tira também o input", () => {
  const r = slackJira();
  const spec = desligar(r.spec, "escrever", "responder");
  const responder = spec.steps.find((p) => p.key === "responder");
  assert.deepEqual(responder?.needs, []);
  assert.equal(responder?.type === "action" ? responder.input : "x", undefined);
});

test("remover o passo do meio religa quem vinha antes com quem vinha depois", () => {
  const r = slackJira();
  const spec = removerPasso(r.spec, "abrir-tarefa");
  assert.deepEqual(spec.steps.find((p) => p.key === "escrever")?.needs, ["analisar"]);

  const semEscrever = removerPasso(r.spec, "escrever");
  const responder = semEscrever.steps.find((p) => p.key === "responder");
  assert.deepEqual(responder?.needs, ["abrir-tarefa"]);
  assert.equal(responder?.type === "action" ? responder.input : null, "abrir-tarefa");
  assert.doesNotThrow(() => AgentSpec.parse(semEscrever));
});

test("ação depois de IA sem formato ajusta o formato de saída da IA", () => {
  const r = rascunhoDoModelo("blank", "x-1", "X", null);
  r.gatilhos = [{ chave: "gatilho-1", config: { kind: "slack-channel", channels: ["C1"], everyMinutes: 5 }, enabled: false }];
  const slack = PASSOS.find((p) => p.id === "slack.post")!;
  const spec = adicionarPasso(r, slack.novo(r.spec), "analisar", { x: 10, y: 10 });
  const ia = spec.steps.find((p) => p.key === "analisar");
  assert.deepEqual(ia?.type === "model" ? ia.outputSchema : null, FORMATOS.respostaSlack);
  const novo = spec.steps.at(-1);
  assert.equal(novo?.type === "action" ? novo.input : null, "analisar");
  assert.deepEqual(spec.layout?.[novo!.key], { x: 10, y: 10 });
});

test("problemas: canal vazio e tracker ausente bloqueiam, app desligado só avisa", () => {
  const r = rascunhoDoModelo("slackJira", "s", "S", null);
  const lista = problemas(r, { ...ctx, slackConectado: false });
  const chaves = lista.map((p) => `${p.chave}:${p.bloqueia}`);
  assert.ok(chaves.includes("automations.problems.noChannels:true"));
  assert.ok(chaves.includes("automations.problems.noTracker:true"));
  assert.ok(chaves.includes("automations.problems.slackOff:false"));
});

test("variáveis do prompt vêm do gatilho e dos passos anteriores", () => {
  const r = slackJira();
  const doEscrever = variaveis(r, "escrever");
  assert.ok(doEscrever.includes("event.text"));
  assert.ok(doEscrever.includes("steps.analisar"));
  assert.ok(doEscrever.includes("steps.abrir-tarefa"));
  assert.ok(!variaveis(r, "analisar").some((v) => v.startsWith("steps.")));
});

test("ação em app e chamada de API: sem destino bloqueia, e não pedem IA antes", () => {
  const vazio: Rascunho = rascunhoDoModelo("blank", "b", "B", null);
  let r = vazio;
  for (const id of ["mcp.call", "http.request"]) {
    const passo = PASSOS.find((p) => p.id === id)!.novo(r.spec);
    r = { ...r, spec: adicionarPasso(r, passo, null) };
  }
  const chaves = problemas(r, ctx).map((p) => `${p.chave}:${p.bloqueia}`);
  assert.ok(chaves.includes("automations.problems.noTool:true"));
  assert.ok(chaves.includes("automations.problems.noUrl:true"));
  assert.ok(!chaves.some((c) => c.startsWith("automations.problems.actionWithoutAi")));

  const passos = r.spec.steps.map((p) =>
    p.type !== "action"
      ? p
      : p.action === "mcp.call"
        ? { ...p, params: { server: "slack", tool: "react", args: {} } }
        : { ...p, params: { method: "POST", url: "https://{{event.host}}/x" } },
  );
  const pronto = problemas({ ...r, spec: { ...r.spec, steps: passos } }, ctx).map((p) => p.chave);
  assert.ok(!pronto.includes("automations.problems.noTool"));
  assert.ok(!pronto.includes("automations.problems.noUrl"));
  assert.ok(AgentSpec.safeParse({ ...r.spec, steps: passos }).success);
});
