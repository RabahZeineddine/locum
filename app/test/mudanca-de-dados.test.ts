import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { abrirObservadorDoBanco, criarDetectorDeMudanca } from "../src/services/mudanca-de-dados.js";

/** O processo principal descobre que o banco mudou, venha a escrita de onde vier. */

test("versão que mudou emite um aviso", () => {
  let versao = 1;
  const avisos: string[][] = [];
  const d = criarDetectorDeMudanca({ lerVersao: () => versao, aoMudar: (areas) => avisos.push(areas) });
  versao = 2;
  d.verificar();
  assert.deepEqual(avisos, [["*"]]);
});

test("versão parada não emite nada", () => {
  const avisos: string[][] = [];
  const d = criarDetectorDeMudanca({ lerVersao: () => 7, aoMudar: (areas) => avisos.push(areas) });
  d.verificar();
  d.verificar();
  assert.equal(avisos.length, 0);
});

test("rajada entre duas conferências vira um aviso só, e o próximo ciclo parado não repete", () => {
  let versao = 1;
  let avisos = 0;
  const d = criarDetectorDeMudanca({ lerVersao: () => versao, aoMudar: () => void avisos++ });
  versao = 5;
  d.verificar();
  d.verificar();
  assert.equal(avisos, 1);
});

test("escrita de outra conexão do mesmo arquivo é vista; sem escrita, silêncio", () => {
  const pasta = mkdtempSync(join(tmpdir(), "locum-mudanca-"));
  try {
    const arquivo = join(pasta, "x.db");
    const escritor = new Database(arquivo);
    escritor.pragma("journal_mode = WAL");
    escritor.exec("create table t (a integer)");
    const observador = abrirObservadorDoBanco(arquivo);
    let avisos = 0;
    const d = criarDetectorDeMudanca({ lerVersao: observador.lerVersao, aoMudar: () => void avisos++ });
    d.verificar();
    assert.equal(avisos, 0);
    escritor.exec("insert into t values (1)");
    escritor.exec("insert into t values (2)");
    d.verificar();
    assert.equal(avisos, 1);
    d.verificar();
    assert.equal(avisos, 1);
    observador.fechar();
    escritor.close();
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
});

test("iniciar confere a cada intervalo e parar solta o relógio", () => {
  let versao = 1;
  let avisos = 0;
  const tarefas: Array<() => void> = [];
  let soltou = false;
  const d = criarDetectorDeMudanca({
    lerVersao: () => versao,
    aoMudar: () => void avisos++,
    agendar: (fn, ms) => {
      assert.equal(ms, 1000);
      tarefas.push(fn);
      return () => void (soltou = true);
    },
  });
  d.iniciar();
  versao = 2;
  tarefas[0]!();
  assert.equal(avisos, 1);
  d.parar();
  assert.equal(soltou, true);
});
