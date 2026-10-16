import { test } from "node:test";
import assert from "node:assert/strict";
import { criarPorteiroDeAvisos, criarCicloDeLeitura, estadoAoLerDados, estadoAoFalharLeitura, type EstadoDeLeitura } from "../renderer/lib/leitura.js";

/** Releitura por invalidação troca os dados sem passar por "carregando". */

const carregando: EstadoDeLeitura<number[]> = { status: "loading", data: undefined, error: undefined };
const pronto = (data: number[]): EstadoDeLeitura<number[]> => ({ status: "ready", data, error: undefined });

test("dado igual ao que já está na tela mantém a mesma referência", () => {
  const atual = pronto([1, 2]);
  assert.equal(estadoAoLerDados(atual, [1, 2]), atual);
  const novo = estadoAoLerDados(atual, [1, 2, 3]);
  assert.deepEqual(novo.data, [1, 2, 3]);
});

test("falha na releitura marca stale sem apagar o dado; a próxima leitura boa limpa", () => {
  const falhou = estadoAoFalharLeitura(pronto([1]), new Error("x"));
  assert.equal(falhou.status, "ready");
  assert.deepEqual(falhou.data, [1]);
  assert.equal(falhou.status === "ready" && falhou.stale, true);
  const ok = estadoAoLerDados(falhou, [1]);
  assert.equal(ok.status === "ready" && ok.stale, undefined);
});

test("falha na primeira leitura vira erro, e em erro a falha seguinte continua erro", () => {
  const e1 = estadoAoFalharLeitura(carregando, new Error("x"));
  assert.equal(e1.status, "error");
  assert.equal(estadoAoFalharLeitura(e1, new Error("y")).status, "error");
});

test("de erro, a leitura que dá certo troca para pronto sem passar por carregando", () => {
  const e1 = estadoAoFalharLeitura(carregando, new Error("x"));
  assert.equal(estadoAoLerDados(e1, [1]).status, "ready");
});

test("leitura de 3 s com aviso a cada 1 s: no máximo uma em voo, o dado chega e sobra uma releitura", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let emVoo = 0;
  let maxEmVoo = 0;
  let leituras = 0;
  const aplicados: number[] = [];
  const ciclo = criarCicloDeLeitura<number>(
    () => {
      emVoo++;
      maxEmVoo = Math.max(maxEmVoo, emVoo);
      const n = ++leituras;
      return new Promise<number>((resolve) =>
        setTimeout(() => {
          emVoo--;
          resolve(n);
        }, 3000),
      );
    },
    (r) => r.ok && aplicados.push(r.data),
  );
  const passar = async (ms: number) => {
    t.mock.timers.tick(ms);
    await new Promise<void>((r) => setImmediate(r));
  };
  ciclo.pedir();
  await passar(1000);
  ciclo.pedir();
  await passar(1000);
  ciclo.pedir();
  assert.equal(leituras, 1);
  await passar(1000); // a primeira volta e e aplicada; ficou suja, relê uma vez
  assert.deepEqual(aplicados, [1]);
  assert.equal(leituras, 2);
  await passar(3000);
  assert.deepEqual(aplicados, [1, 2]);
  assert.equal(leituras, 2);
  assert.equal(maxEmVoo, 1);
});

test("aviso com a janela escondida espera ela voltar, e só então relê uma vez", () => {
  let visivel = false;
  let leituras = 0;
  const p = criarPorteiroDeAvisos(() => visivel, () => void leituras++);
  p.avisar();
  p.avisar();
  assert.equal(leituras, 0);
  visivel = true;
  p.voltou();
  p.voltou();
  assert.equal(leituras, 1);
});

test("aviso com a janela à vista relê na hora", () => {
  let leituras = 0;
  const p = criarPorteiroDeAvisos(() => true, () => void leituras++);
  p.avisar();
  assert.equal(leituras, 1);
});
