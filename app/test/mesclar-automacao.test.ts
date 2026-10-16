import { test } from "node:test";
import assert from "node:assert/strict";
import { rascunhoDoModelo, type Rascunho } from "../renderer/lib/automacao.js";
import { gatilhosParaGravar, mesclar } from "../renderer/lib/mesclar-automacao.js";

/** O que o Salvar manda e como o rascunho se junta ao que está gravado agora. */

const comIds = (r: Rascunho): Rascunho => ({ ...r, gatilhos: r.gatilhos.map((g, i) => ({ ...g, id: `g${i}` })) });
const v1 = (): Rascunho => comIds(rascunhoDoModelo("teamsPrReview", "revisar-pr", "Revisar PR", null));
const nomeDoPasso = (r: Rascunho, key: string, name: string): Rascunho => ({
  ...r,
  spec: { ...r.spec, steps: r.spec.steps.map((p) => (p.key === key ? { ...p, name } : p)) },
});
const comNome = (r: Rascunho, name: string): Rascunho => ({ ...r, spec: { ...r.spec, name } });

/* ---------------------------------------------------------------- payload */

test("gatilho com id não manda enabled, e o novo manda o dele", () => {
  const gravado = v1();
  const novo = { chave: "gatilho-9", config: gravado.gatilhos[0]!.config, enabled: false };
  const payload = gatilhosParaGravar([{ ...gravado.gatilhos[0]!, enabled: false }, novo], gravado.gatilhos);
  assert.equal("enabled" in payload[0]!, false);
  assert.equal(payload[0]!.id, "g0");
  assert.equal(payload[1]!.enabled, false);
  assert.equal("id" in payload[1]!, false);
});

test("zerar a pendência de chats sem escolher nenhum manda valerParaTodosOsChats", () => {
  const gravado = v1();
  const config = gravado.gatilhos[0]!.config as object;
  const pendente = { ...gravado.gatilhos[0]!, config: { ...config, chatsPendentes: 2, chats: [] } as never };
  const zerado = { ...pendente, config: { ...config, chatsPendentes: 0, chats: [] } as never };
  assert.equal(gatilhosParaGravar([zerado], [pendente])[0]!.valerParaTodosOsChats, true);
  assert.equal("valerParaTodosOsChats" in gatilhosParaGravar([pendente], [pendente])[0]!, false);
});

/* ------------------------------------------------------------------ mescla */

test("sem mudança de fora, o rascunho sai como está", () => {
  const base = v1();
  const meu = nomeDoPasso(comNome(base, "Meu nome"), "revisar", "Meu passo");
  const { rascunho, conflitos } = mesclar(base, meu, base);
  assert.deepEqual(rascunho, meu);
  assert.deepEqual(conflitos, []);
});

test("orçamento, skills e ferramentas padrão vêm do gravado, e o desenho só o que a pessoa moveu", () => {
  const base = v1();
  const gravado: Rascunho = {
    ...base,
    spec: { ...base.spec, budget: { perRunUsd: 9, perDayUsd: 90 }, skills: [], defaultTools: [], layout: { revisar: { x: 1, y: 1 }, responder: { x: 5, y: 5 } } },
  };
  const meu: Rascunho = { ...base, spec: { ...base.spec, name: "Novo", layout: { revisar: { x: 1, y: 1 }, responder: { x: 7, y: 7 } } } };
  const { rascunho } = mesclar(base, meu, gravado);
  assert.deepEqual(rascunho.spec.budget, { perRunUsd: 9, perDayUsd: 90 });
  assert.equal(rascunho.spec.name, "Novo");
  assert.deepEqual(rascunho.spec.layout, { revisar: { x: 1, y: 1 }, responder: { x: 7, y: 7 } });
});

test("passo mexido só por mim e passo mexido só por fora convivem", () => {
  const base = v1();
  const meu = nomeDoPasso(base, "revisar", "Meu");
  const gravado = nomeDoPasso(base, "responder", "De fora");
  const { rascunho, conflitos } = mesclar(base, meu, gravado);
  assert.equal(rascunho.spec.steps.find((p) => p.key === "revisar")!.name, "Meu");
  assert.equal(rascunho.spec.steps.find((p) => p.key === "responder")!.name, "De fora");
  assert.deepEqual(conflitos, []);
});

test("o mesmo passo mexido por mim e por fora é conflito, e a escolha decide qual fica", () => {
  const base = v1();
  const meu = nomeDoPasso(base, "revisar", "Meu");
  const gravado = nomeDoPasso(base, "revisar", "De fora");
  const padrao = mesclar(base, meu, gravado);
  assert.deepEqual(padrao.conflitos.map((c) => [c.chave, c.tipo]), [["passo:revisar", "passo"]]);
  assert.equal(padrao.rascunho.spec.steps.find((p) => p.key === "revisar")!.name, "Meu");
  const fora = mesclar(base, meu, gravado, { "passo:revisar": "de-fora" });
  assert.equal(fora.rascunho.spec.steps.find((p) => p.key === "revisar")!.name, "De fora");
});

test("passo novo de fora entra, e passo que removi some se ninguém mexeu nele", () => {
  const base = v1();
  const extra = { ...base.spec.steps[1]!, key: "extra", name: "Extra", needs: ["revisar"] };
  const gravado: Rascunho = { ...base, spec: { ...base.spec, steps: [...base.spec.steps, extra] } };
  const meu: Rascunho = { ...base, spec: { ...base.spec, steps: base.spec.steps.filter((p) => p.key !== "responder") } };
  const { rascunho } = mesclar(base, meu, gravado);
  assert.deepEqual(rascunho.spec.steps.map((p) => p.key), ["revisar", "extra"]);
});

test("gatilho que existe no gravado e não no rascunho vem do gravado, se não estava na base", () => {
  const base = v1();
  const deFora = { chave: "gatilho-2", id: "g9", config: base.gatilhos[0]!.config, enabled: true };
  const gravado: Rascunho = { ...base, gatilhos: [...base.gatilhos, deFora] };
  const { rascunho } = mesclar(base, base, gravado);
  assert.deepEqual(rascunho.gatilhos.map((g) => g.id), ["g0", "g9"]);
  assert.equal(rascunho.gatilhos[1]!.enabled, true);
});

test("gatilho que eu removi continua removido, e o ligado vem sempre do gravado", () => {
  const base = v1();
  const gravado: Rascunho = { ...base, gatilhos: base.gatilhos.map((g) => ({ ...g, enabled: true })) };
  assert.equal(mesclar(base, base, gravado).rascunho.gatilhos[0]!.enabled, true);
  const { rascunho } = mesclar(base, { ...base, gatilhos: [] }, gravado);
  assert.deepEqual(rascunho.gatilhos, []);
});

test("gatilho mexido dos dois lados é conflito, e o mexido por mim sobre o intocado fora entra", () => {
  const base = v1();
  const config = (r: Rascunho, everyMinutes: number): Rascunho => ({
    ...r,
    gatilhos: r.gatilhos.map((g) => ({ ...g, config: { ...g.config, everyMinutes } as never })),
  });
  const so = mesclar(base, config(base, 10), base);
  assert.deepEqual(so.conflitos, []);
  assert.equal((so.rascunho.gatilhos[0]!.config as { everyMinutes: number }).everyMinutes, 10);
  const dois = mesclar(base, config(base, 10), config(base, 15));
  assert.deepEqual(dois.conflitos.map((c) => c.chave), ["gatilho:g0"]);
  const fora = mesclar(base, config(base, 10), config(base, 15), { "gatilho:g0": "de-fora" });
  assert.equal((fora.rascunho.gatilhos[0]!.config as { everyMinutes: number }).everyMinutes, 15);
});
