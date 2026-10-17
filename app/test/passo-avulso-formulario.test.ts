import { test } from "node:test";
import assert from "node:assert/strict";
import { ENTRADA_DA_REVIEW } from "../src/sources/github.js";
import { montarConteudo, passosDoGrafo, valoresIniciais } from "../renderer/lib/passo-avulso.js";

test("o formulário nasce do esquema: o padrão do esquema vira o valor inicial", () => {
  assert.deepEqual(valoresIniciais(ENTRADA_DA_REVIEW), { findings: "[]" });
});

test("aprovar sem comentário: só o veredito, e o conteúdo bate com o esquema", () => {
  const { conteudo, erros } = montarConteudo(ENTRADA_DA_REVIEW, { ...valoresIniciais(ENTRADA_DA_REVIEW), verdict: "APPROVE", summary: "" });
  assert.deepEqual(erros, []);
  assert.deepEqual(conteudo, { verdict: "APPROVE", findings: [] });
});

test("campo obrigatório vazio e JSON quebrado voltam como erro, sem gravar o campo", () => {
  const { conteudo, erros } = montarConteudo(ENTRADA_DA_REVIEW, { findings: "[{" });
  assert.deepEqual(erros.map((e) => [e.campo, e.motivo]).sort(), [["findings", "json"], ["verdict", "obrigatorio"]]);
  assert.equal("findings" in conteudo, false);
});

test("achados digitados como JSON entram no conteúdo", () => {
  const achado = { severity: "high", problem: "falta teste", file: "a.ts", line: 3 };
  const { conteudo } = montarConteudo(ENTRADA_DA_REVIEW, { verdict: "COMMENT", findings: JSON.stringify([achado]) });
  assert.deepEqual(conteudo.findings, [achado]);
});

test("o grafo ganha os avulsos depois dos passos do fluxo, ligados ao passo de que derivam", () => {
  const passos = passosDoGrafo(
    [{ key: "ler", needs: [] }, { key: "revisar", needs: ["ler"] }],
    [
      { stepKey: "ler", origem: "fluxo", input: null },
      { stepKey: "avulso-1", origem: "avulso", input: { derivaDe: "revisar" } },
      { stepKey: "avulso-2", origem: "avulso", input: { derivaDe: null } },
    ],
  );
  assert.deepEqual(passos, [
    { key: "ler", needs: [] },
    { key: "revisar", needs: ["ler"] },
    { key: "avulso-1", needs: ["revisar"] },
    { key: "avulso-2", needs: [] },
  ]);
});
