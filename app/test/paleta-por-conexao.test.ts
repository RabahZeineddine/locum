import { test } from "node:test";
import assert from "node:assert/strict";
import { casaBusca, humanizar, passoDeFerramenta, slug } from "../renderer/lib/paleta-conexoes.js";
import { adicionarPasso, problemas, type Rascunho } from "../renderer/lib/automacao.js";
import type { Step } from "../src/config/types.js";

test("casaBusca olha qualquer texto, sem acento nem caixa", () => {
  assert.equal(casaBusca("REAÇÃO", "Reagir no Teams", "reacao"), true);
  assert.equal(casaBusca("", "qualquer"), true);
  assert.equal(casaBusca("x", "abc", undefined), false);
});

test("humanizar tira _ e -, separa camelCase e põe a primeira maiúscula", () => {
  assert.equal(humanizar("add_reaction"), "Add reaction");
  assert.equal(humanizar("set-chat-message-reaction"), "Set chat message reaction");
  assert.equal(humanizar("getChannelHistory"), "Get channel history");
  assert.equal(humanizar("mcp__slack__add_reaction"), "Add reaction");
});

const VAZIO: Rascunho = { spec: { id: "a", name: "A", model: "m", steps: [] } as never, gatilhos: [] };

test("o passo nasce com servidor, ferramenta e nome legível; escrita em aprovação, leitura em automático", () => {
  const escrita = passoDeFerramenta(VAZIO.spec, "slack", { name: "add_reaction" });
  assert.equal(escrita.type, "action");
  assert.deepEqual(
    [escrita.name, escrita.action, escrita.mode, escrita.params],
    ["Add reaction", "mcp.call", "approve", { server: "slack", tool: "add_reaction", args: {} }],
  );
  const leitura = passoDeFerramenta(VAZIO.spec, "slack", { name: "get_channel_history", readOnlyHint: true });
  assert.equal(leitura.type === "action" && leitura.mode, "auto");
  const spec = adicionarPasso(VAZIO, escrita, null);
  assert.equal(passoDeFerramenta(spec, "slack", { name: "add_reaction" }).key, "add-reaction-2");
});

test("o nó criado pela paleta, sem argumentos, acusa o obrigatório pelo schema da conexão", () => {
  const passo = passoDeFerramenta(VAZIO.spec, "slack", { name: "add_reaction" });
  const r: Rascunho = { ...VAZIO, spec: { ...VAZIO.spec, steps: [passo] } };
  const schema = { type: "object", properties: { reaction: { type: "string" } }, required: ["reaction"] };
  const lista = problemas(r, { slackConectado: true, teamsConectado: true, trackers: [], esquemas: { "slack/add_reaction": schema } });
  assert.ok(lista.some((p) => p.chave === "automations.problems.argRequired" && p.no === passo.key && p.bloqueia));
});

test("problemas: tipo errado em valor fixo e referência a passo que não vem antes bloqueiam", () => {
  const schema = { type: "object", properties: { n: { type: "integer" }, texto: { type: "string" } } };
  const lendo: Step = { type: "action", key: "ler", name: "Ler", needs: [], optional: false, action: "mcp.call", mode: "auto", params: { server: "s", tool: "t", args: {} } };
  const depois = { ...passoDeFerramenta(VAZIO.spec, "s", { name: "enviar" }), key: "enviar", needs: ["ler"] } as Extract<Step, { type: "action" }>;
  const montar = (args: Record<string, unknown>, needs = ["ler"]): Rascunho => ({
    ...VAZIO,
    spec: { ...VAZIO.spec, steps: [lendo, { ...depois, needs, params: { server: "s", tool: "enviar", args } }] },
  });
  const ctx = { slackConectado: true, teamsConectado: true, trackers: [], esquemas: { "s/enviar": schema } };
  const chaves = (r: Rascunho) => problemas(r, ctx).filter((p) => p.no === "enviar").map((p) => `${p.chave}:${p.valores?.campo ?? p.valores?.ref}`);
  assert.deepEqual(chaves(montar({ n: "abc" })), ["automations.problems.argType:n"]);
  assert.deepEqual(chaves(montar({ n: "{{steps.ler.total}}", texto: "{{event.text}}" })), []);
  assert.deepEqual(chaves(montar({ texto: "{{steps.ler.x}}" }, [])), ["automations.problems.refNotBefore:steps.ler"]);
  assert.deepEqual(chaves(montar({ texto: "{{steps.fantasma.x}}" })), ["automations.problems.refNotBefore:steps.fantasma"]);
});

test("problemas: cache antigo sem schema não acusa argumento, só o que se sabe sem ele", () => {
  const passo = passoDeFerramenta(VAZIO.spec, "s", { name: "enviar" });
  const r: Rascunho = { ...VAZIO, spec: { ...VAZIO.spec, steps: [passo] } };
  const lista = problemas(r, { slackConectado: true, teamsConectado: true, trackers: [] });
  assert.deepEqual(lista.filter((p) => p.no === passo.key && p.chave.includes(".arg")), []);
});
