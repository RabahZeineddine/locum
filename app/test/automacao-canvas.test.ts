import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentSpec } from "../src/config/types.js";
import { renderPrompt } from "../src/executor/executor.js";
import {
  adicionarPasso,
  comNosDeReacao,
  faltaReacaoNoGatilho,
  arestas,
  desligar,
  FORMATOS,
  ligar,
  MODELOS,
  passoComAgent,
  passoSemAgent,
  PASSOS,
  LOGICA,
  caminhosDe,
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

test("seta de uma decisão grava o caminho, e desligar tira o caminho junto", () => {
  let r: Rascunho = rascunhoDoModelo("blank", "b", "B", null);
  const se = LOGICA.find((l) => l.id === "if")!.novo(r.spec);
  r = { ...r, spec: adicionarPasso(r, se, null) };
  const texto = LOGICA.find((l) => l.id === "text")!.novo(r.spec);
  r = { ...r, spec: adicionarPasso(r, texto, se.key) };
  assert.deepEqual(caminhosDe(r.spec.steps.find((p) => p.key === se.key)), ["true", "false"]);
  assert.deepEqual(r.spec.steps.find((p) => p.key === texto.key)?.when, { step: se.key, branch: "true" });

  const trocado = ligar(r.spec, se.key, texto.key, "false");
  assert.ok("spec" in trocado);
  assert.deepEqual(trocado.spec.steps.find((p) => p.key === texto.key)?.when, { step: se.key, branch: "false" });
  assert.equal(arestas({ ...r, spec: trocado.spec }).find((a) => a.target === texto.key && !a.fixa)?.sourceHandle, "false");

  const solto = desligar(trocado.spec, se.key, texto.key);
  assert.equal(solto.steps.find((p) => p.key === texto.key)?.when, undefined);
  assert.ok(AgentSpec.safeParse(trocado.spec).success);
});

test("o modelo de PR no Teams revisa e só responde depois de aprovar, sem nó que espere escolha", () => {
  const r = rascunhoDoModelo("teamsPrReview", "t", "T", null);
  assert.deepEqual(r.gatilhos.map((g) => g.config.kind), ["teams-inbox"]);
  assert.equal(r.gatilhos[0]!.config.kind === "teams-inbox" && r.gatilhos[0]!.config.prLinks, true);
  assert.deepEqual(r.spec.steps.map((p) => p.key), ["pegou", "revisar", "responder", "veredito"]);
  // A reação é nó do fluxo, com a ação do próprio Teams: não há ferramenta de app a escolher.
  assert.ok(r.spec.steps.every((p) => p.type !== "action" || p.action !== "mcp.call"));
  const resposta = r.spec.steps[2]!;
  assert.equal(resposta.type === "action" && resposta.action, "teams.post");
  assert.equal(resposta.type === "action" && resposta.mode, "approve");
  assert.deepEqual(resposta.needs, ["revisar"]);
});

test("o modelo de PR no Teams reage 👀 no começo, expõe o veredito e troca o 👀 pelo veredito no fim", () => {
  const r = rascunhoDoModelo("teamsPrReview", "t", "T", null);
  const [pegou, revisar, , veredito] = r.spec.steps;
  assert.deepEqual([pegou!.type === "action" && pegou!.action, pegou!.type === "action" && pegou!.mode, pegou!.needs], ["teams.react", "auto", []]);
  assert.deepEqual(pegou!.type === "action" && pegou!.params, { emoji: "👀", operacao: "set" });
  assert.deepEqual(revisar!.needs, ["pegou"]);
  const esquema = revisar!.type === "model" ? (revisar!.outputSchema as { required: string[]; properties: { verdict: { enum: string[] } } }) : null;
  assert.deepEqual(esquema?.required, ["text", "verdict"]);
  assert.deepEqual(esquema?.properties.verdict.enum, ["APPROVE", "REQUEST_CHANGES", "COMMENT"]);
  assert.deepEqual(veredito!.type === "action" && veredito!.params, {
    operacao: "set",
    tirar: "👀",
    porValor: { de: "{{steps.revisar.verdict}}", mapa: { APPROVE: "✅", REQUEST_CHANGES: "⚠️", COMMENT: "💬" }, padrao: "💬" },
  });
  assert.deepEqual(veredito!.needs, ["responder"]);
  assert.ok(AgentSpec.safeParse(r.spec).success);
});

test("automação gravada sem nó de reação ganha o aviso, e o botão insere os nós no rascunho sem tocar no gravado", () => {
  const antigo = rascunhoDoModelo("teamsPrReview", "t", "T", null);
  const gravado = { ...antigo, spec: { ...antigo.spec, steps: antigo.spec.steps.filter((p) => p.type !== "action" || p.action !== "teams.react").map((p) => ({ ...p, needs: p.needs.filter((n) => n !== "pegou") })) } };
  assert.equal(faltaReacaoNoGatilho(gravado), true);
  assert.equal(faltaReacaoNoGatilho(antigo), false);
  const sem = { ...gravado, gatilhos: [{ ...gravado.gatilhos[0]!, config: { ...gravado.gatilhos[0]!.config, prLinks: false } as never }] };
  assert.equal(faltaReacaoNoGatilho(sem), false);

  const novo = comNosDeReacao(gravado);
  assert.deepEqual(novo.spec.steps.map((p) => p.key), ["pegou", "revisar", "responder", "veredito"]);
  assert.deepEqual(novo.spec.steps.find((p) => p.key === "revisar")!.needs, ["pegou"]);
  assert.deepEqual(novo.spec.steps.find((p) => p.key === "veredito")!.needs, ["responder"]);
  assert.equal(faltaReacaoNoGatilho(novo), false);
  assert.ok(AgentSpec.safeParse(novo.spec).success);
  assert.equal(gravado.spec.steps.length, 2);
});

test("o modelo de PR no Teams monta o prompt com os PRs do evento e não exige servidor", () => {
  const r = rascunhoDoModelo("teamsPrReview", "t", "T", null);
  const revisar = r.spec.steps.find((x) => x.key === "revisar")!;
  assert.equal(revisar.type, "model");
  assert.deepEqual(revisar.type === "model" && revisar.requiresServers, []);
  assert.equal(r.spec.budget.perRunUsd, 0.5);
  const prompt = renderPrompt(
    revisar.type === "model" ? revisar.prompt : "",
    {
      repo: "acme/api", prNumber: 7, author: "ana", text: "olhem isso",
      prsTexto: "### PR 1 de 2: acme/api#7\nTítulo: Corrige o saldo\n\n### PR 2 de 2: acme/web#9\nTítulo: Ajusta o menu\nDiff:\n+b",
    } as unknown as Parameters<typeof renderPrompt>[1],
    new Map(),
  );
  assert.match(prompt, /Corrige o saldo/);
  assert.match(prompt, /acme\/web#9/);
  assert.match(prompt, /\+b/);
  assert.match(prompt, /uma seção por PR/);
  assert.doesNotMatch(prompt, /\{\{/);
});

test("o modelo de PR no GitHub comenta no PR só com aprovação", () => {
  const r = rascunhoDoModelo("githubPrReview", "g", "G", null);
  assert.equal(r.gatilhos[0]!.config.kind, "poll");
  const comentario = r.spec.steps.find((p) => p.type === "action");
  assert.equal(comentario?.type === "action" && comentario.action, "github.review_comment");
  assert.equal(comentario?.type === "action" && comentario.mode, "approve");
  assert.ok(r.spec.steps.every((p) => p.type !== "model" || p.requiresServers.length === 0));
});

test("em branco sugere o agent criado, e sem agent fica o passo de IA", () => {
  const com = rascunhoDoModelo("blank", "b", "B", null, ["revisor"]);
  assert.equal(com.spec.steps[0]!.type === "model" && com.spec.steps[0]!.profile, "revisor");
  const sem = rascunhoDoModelo("blank", "b", "B", null);
  assert.equal(sem.spec.steps[0]!.type === "model" && sem.spec.steps[0]!.profile, undefined);
});

test("o modelo de PR no Teams usa o agent de nome parecido com revisor, e sem ele fica o passo de IA", () => {
  const passo = (r: ReturnType<typeof rascunhoDoModelo>) => {
    const p = r.spec.steps.find((x) => x.key === "revisar")!;
    return p.type === "model" ? p.profile : undefined;
  };
  assert.equal(passo(rascunhoDoModelo("teamsPrReview", "t", "T", null, [{ id: "geral", name: "Geral" }, { id: "rev", name: "Revisor de código" }])), "rev");
  // O primeiro agent qualquer não é revisor: fica o passo de IA, como antes.
  assert.equal(passo(rascunhoDoModelo("teamsPrReview", "t", "T", null, [{ id: "geral", name: "Geral" }, { id: "outro", name: "Outro" }])), undefined);
  assert.equal(passo(rascunhoDoModelo("teamsPrReview", "t", "T", null)), undefined);
});

test("a revisão por link no Teams avisa que precisa do token do GitHub, com atalho, só quando falta", () => {
  const r = rascunhoDoModelo("teamsPrReview", "t", "T", null);
  const base = { slackConectado: true, teamsConectado: true, trackers: [] };
  const aviso = (githubComToken?: boolean) =>
    problemas(r, { ...base, ...(githubComToken === undefined ? {} : { githubComToken }) }).find((p) => p.chave === "automations.problems.githubTokenForDiff");
  assert.deepEqual(aviso(false)?.atalho, { rota: "connections", detalhe: "github" });
  assert.equal(aviso(false)?.bloqueia, false);
  assert.equal(aviso(true), undefined);
  assert.equal(aviso(undefined), undefined);
});

test("sem agent revisor, o modelo do Teams sugere criar um, com atalho para o agent novo", () => {
  const base = { slackConectado: true, teamsConectado: true, trackers: [] };
  const sem = rascunhoDoModelo("teamsPrReview", "t", "T", null, [{ id: "geral", name: "Geral" }]);
  const aviso = problemas(sem, { ...base, agents: ["geral"] }).find((p) => p.chave === "automations.problems.createReviewer");
  assert.deepEqual(aviso?.atalho, { rota: "agents", detalhe: "novo" });
  assert.equal(aviso?.bloqueia, false);
  const com = rascunhoDoModelo("teamsPrReview", "t", "T", null, [{ id: "rev", name: "Revisor" }]);
  assert.equal(problemas(com, { ...base, agents: ["rev"] }).some((p) => p.chave === "automations.problems.createReviewer"), false);
  assert.equal(problemas(sem, base).some((p) => p.chave === "automations.problems.createReviewer"), false, "sem a lista de agents não acusa");
});

test("escolher o agent não mexe no model do passo, que com profile é ignorado", () => {
  const passo = { type: "model" as const, key: "p", name: "Analisar", needs: [], optional: false, model: "claude-code/claude-opus-4", prompt: "Faça X", tools: [{ server: "github", tool: "*", class: "read" as const }], requiresServers: [], maxSteps: 8 };
  const com = passoComAgent(passo, { id: "revisor", name: "Revisor" });
  assert.equal(com.profile, "revisor");
  assert.equal(com.model, "claude-code/claude-opus-4");
  assert.equal(com.name, "Analisar", "nome escrito à mão fica");
  const acompanha = passoComAgent({ ...com, name: "Revisor" }, { id: "outro", name: "Outro" }, "Revisor");
  assert.equal(acompanha.name, "Outro", "o nome do agent antigo acompanha a troca");
  const outro = passoComAgent({ ...com, name: "Meu nome" }, { id: "outro", name: "Outro" }, "Revisor");
  assert.equal(outro.name, "Meu nome");
  assert.equal(outro.model, "claude-code/claude-opus-4");
});

test("ida e volta entre Agent e Instrução embutida preserva prompt, tools e model", () => {
  const passo = { type: "model" as const, key: "p", name: "Analisar", needs: [], optional: false, model: "claude-code/claude-opus-4", prompt: "Faça X", tools: [{ server: "github", tool: "*", class: "read" as const }], requiresServers: [], maxSteps: 8 };
  const volta = passoSemAgent(passoComAgent(passo, { id: "revisor", name: "Revisor" }));
  assert.equal(volta.profile, undefined);
  assert.equal("profile" in volta, false);
  assert.equal(volta.prompt, "Faça X");
  assert.deepEqual(volta.tools, passo.tools);
  assert.equal(volta.model, "claude-code/claude-opus-4");
});
