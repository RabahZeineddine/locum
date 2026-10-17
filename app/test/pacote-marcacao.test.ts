import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionStep, AgentProfile, AgentSpec, LogicStep, ModelStep, TriggerConfig } from "../src/config/types.js";
import { Pacote } from "../src/pacote/formato.js";
import { MARCAS_DO_AGENT, MARCAS_DO_PASSO_DE_ACAO, MARCAS_DO_SPEC, MARCAS_DOS_GATILHOS, ehLocal, temFilhos, type MapaDeMarcas, type Marca } from "../src/pacote/marcacao.js";

/** Campo novo num esquema sem marcação faz um destes testes falhar: nada some em silêncio no pacote. */

const chaves = (o: object): string[] => Object.keys(o).sort();

test("todo tipo de gatilho tem marcação, e ela cobre exatamente os campos do esquema", () => {
  const esquemas = (TriggerConfig as unknown as { options: { shape: { kind: { value: string } } & Record<string, unknown> }[] }).options;
  assert.deepEqual(chaves(MARCAS_DOS_GATILHOS), esquemas.map((e) => e.shape.kind.value).sort());
  for (const e of esquemas) {
    const marcas: MapaDeMarcas = MARCAS_DOS_GATILHOS[e.shape.kind.value as keyof typeof MARCAS_DOS_GATILHOS];
    assert.deepEqual(chaves(marcas), chaves(e.shape), `gatilho ${e.shape.kind.value}`);
  }
});

test("a marcação dos filhos cobre os campos do objeto marcado", () => {
  const poll = (TriggerConfig as unknown as { options: { shape: Record<string, { unwrap(): { shape: object } }> }[] }).options.find((o) => "filters" in o.shape)!;
  const marca = MARCAS_DOS_GATILHOS.poll.filters;
  assert.ok(temFilhos(marca));
  assert.deepEqual(chaves(marca.filhos), chaves(poll.shape.filters!.unwrap().shape));
});

test("agent, spec e passos têm marcação que cobre o esquema", () => {
  assert.deepEqual(chaves(MARCAS_DO_AGENT), chaves(AgentProfile.shape));
  assert.deepEqual(chaves(MARCAS_DO_SPEC), chaves(AgentSpec.shape));
  assert.deepEqual(chaves(MARCAS_DO_PASSO_DE_ACAO), chaves(ActionStep.shape));
  assert.ok(ModelStep && LogicStep);
});

test("o formato do pacote carrega os campos portáveis e só tira o que é local ou dobrado", () => {
  const formato = Pacote.shape.automacao.shape.gatilhos.element as unknown as { options: { shape: Record<string, unknown> }[] };
  for (const opcao of formato.options) {
    const kind = (opcao.shape.kind as { value: string }).value as keyof typeof MARCAS_DOS_GATILHOS;
    for (const [campo, marca] of Object.entries(MARCAS_DOS_GATILHOS[kind] as MapaDeMarcas)) {
      const fica = campo in opcao.shape;
      assert.equal(fica, !(marca === "dobrado" || ehLocal(marca)), `${kind}.${campo}`);
    }
  }
  const viaja = (marca: Marca): boolean => !(marca === "dobrado" || marca === "seguro" || ehLocal(marca));
  const agent = (Pacote.shape.agents.element as unknown as { shape: Record<string, unknown> }).shape;
  for (const [campo, marca] of Object.entries(MARCAS_DO_AGENT)) assert.equal(campo in agent, viaja(marca), `agent.${campo}`);
  // O id do spec é o da automação, e fora ele o pacote carrega exatamente o que a marcação diz.
  const spec = (Pacote.shape.automacao.shape.spec as unknown as { shape: Record<string, unknown> }).shape;
  for (const [campo, marca] of Object.entries(MARCAS_DO_SPEC)) assert.equal(campo in spec, campo !== "id" && viaja(marca), `spec.${campo}`);
});
