import { test } from "node:test";
import assert from "node:assert/strict";
import { prReviewSpec, slackReplySpec } from "../src/examples/agents.js";
import {
  AgentBuilder,
  sistemaDoCriador,
  validarRascunho,
  type CatalogoDoCriador,
} from "../src/services/agent-builder.js";

const catalogo: CatalogoDoCriador = {
  modelos: [
    { provedor: "claude-code", modelos: ["opus", "sonnet", "haiku"] },
    { provedor: "openai", modelos: ["gpt-5"] },
  ],
  servidores: [{ nome: "github", ferramentas: [{ nome: "get_file", descricao: "lê um arquivo" }] }],
  trackers: [{ id: "jira-time", rotulo: "Jira do time" }],
  exemplos: [prReviewSpec, slackReplySpec],
};

function rascunho(sobre: Record<string, unknown> = {}) {
  return {
    id: "resumo-de-pr",
    name: "Resumo de PR",
    steps: [
      {
        type: "model",
        key: "resumo",
        name: "Resumir",
        model: "claude-code/sonnet",
        prompt: "Resuma {{event.title}}",
      },
      {
        type: "action",
        key: "postar",
        name: "Postar",
        needs: ["resumo"],
        action: "slack.post",
        mode: "auto",
        input: "resumo",
      },
    ],
    ...sobre,
  };
}

test("rascunho válido passa e a ação volta para approve", () => {
  const { spec, problemas } = validarRascunho(rascunho(), catalogo, new Set());
  assert.deepEqual(problemas, []);
  const acao = spec!.steps.find((s) => s.type === "action");
  assert.equal(acao?.type === "action" && acao.mode, "approve");
});

test("modelo, servidor, ferramenta e ação inventados viram problema", () => {
  const { spec, problemas } = validarRascunho(
    rascunho({
      steps: [
        {
          type: "model",
          key: "a",
          name: "A",
          model: "mistral/large",
          prompt: "x",
          tools: [{ server: "github", tool: "delete_repo" }],
          requiresServers: ["argocd"],
        },
        { type: "model", key: "b", name: "B", model: "openai/gpt-9", prompt: "x", needs: ["fantasma"] },
        { type: "action", key: "c", name: "C", action: "email.send", input: "z" },
      ],
    }),
    catalogo,
    new Set(),
  );
  assert.equal(spec, undefined);
  const texto = problemas.join("\n");
  for (const trecho of ["mistral/large", "delete_repo", "argocd", "gpt-9", "fantasma", "email.send", "\"z\""]) {
    assert.match(texto, new RegExp(trecho.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("tracker.create_issue exige um target do catálogo", () => {
  const passos = (target?: string) =>
    rascunho({
      steps: [
        { type: "model", key: "m", name: "M", model: "claude-code/haiku", prompt: "x" },
        { type: "action", key: "t", name: "T", needs: ["m"], action: "tracker.create_issue", input: "m", target },
      ],
    });
  assert.match(validarRascunho(passos(), catalogo, new Set()).problemas.join(), /jira-time/);
  assert.deepEqual(validarRascunho(passos("jira-time"), catalogo, new Set()).problemas, []);
});

test("ciclo e forma errada viram problema, id repetido ganha sufixo", () => {
  const ciclo = validarRascunho(
    rascunho({
      steps: [
        { type: "model", key: "a", name: "A", model: "claude-code/opus", prompt: "x", needs: ["b"] },
        { type: "model", key: "b", name: "B", model: "claude-code/opus", prompt: "x", needs: ["a"] },
      ],
    }),
    catalogo,
    new Set(),
  );
  assert.match(ciclo.problemas.join(), /ciclo/);

  assert.ok(validarRascunho({ id: "x" }, catalogo, new Set()).problemas.length > 0);

  const repetido = validarRascunho(rascunho(), catalogo, new Set(["resumo-de-pr", "resumo-de-pr-2"]));
  assert.equal(repetido.spec?.id, "resumo-de-pr-3");
});

test("o sistema leva só o catálogo e o idioma", () => {
  const sistema = sistemaDoCriador(catalogo, "Escreva em português.");
  assert.match(sistema, /claude-code\/sonnet/);
  assert.match(sistema, /github:\n {2}- get_file/);
  assert.match(sistema, /jira-time/);
  assert.match(sistema, /Escreva em português\./);
  assert.match(sistema, /"id":"pr-review"/);
});

test("a segunda tentativa recebe os problemas da primeira", async () => {
  const pedidos: string[] = [];
  const respostas = [
    "não é json",
    JSON.stringify(rascunho({ steps: [{ type: "model", key: "a", name: "A", model: "x/y", prompt: "p" }] })),
    "```json\n" + JSON.stringify(rascunho()) + "\n```",
  ];
  const builder = new AgentBuilder({
    gerador: async () => ({
      modelo: "claude-code/sonnet",
      gerar: async (_sistema, pedido) => {
        pedidos.push(pedido);
        return respostas.shift()!;
      },
    }),
    catalogo: async () => catalogo,
    existentes: async () => [],
    idioma: () => "",
  });

  const resultado = await builder.criar("resume cada PR novo e posta no Slack");
  assert.equal(resultado.tentativas, 3);
  assert.equal(resultado.spec.id, "resumo-de-pr");
  assert.match(pedidos[1]!, /JSON/);
  assert.match(pedidos[2]!, /"x\/y"/);
  assert.match(pedidos[2]!, /resume cada PR novo/);
});

test("sem gerador e com descrição curta, recusa antes de chamar modelo", async () => {
  const semGerador = new AgentBuilder({
    gerador: async () => null,
    catalogo: async () => catalogo,
    existentes: async () => [],
    idioma: () => "",
  });
  await assert.rejects(semGerador.criar("revisa os PRs do time de pagamentos"), /nenhum modelo/);
  await assert.rejects(semGerador.criar("oi"), /pelo menos uma frase/);
});

test("três tentativas ruins desistem com os problemas", async () => {
  const builder = new AgentBuilder({
    gerador: async () => ({ modelo: "m/m", gerar: async () => "{}" }),
    catalogo: async () => catalogo,
    existentes: async () => [],
    idioma: () => "",
  });
  await assert.rejects(builder.criar("um agent qualquer que resume coisas"), /não passou na validação/);
});
