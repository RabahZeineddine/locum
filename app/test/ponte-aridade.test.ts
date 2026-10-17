import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

/**
 * O TypeScript aceita um handler `() => servico.metodo()` onde o contrato pede
 * argumentos, e o argumento da tela se perde sem aviso. Aqui o handler tem de
 * declarar os parâmetros obrigatórios do contrato e todo parâmetro que a tela
 * passa de fato ao canal.
 */
function argumentosQueATelaPassa(raiz: string): Map<string, number> {
  const passa = new Map<string, number>();
  const ler = (pasta: string): void => {
    for (const e of readdirSync(pasta, { withFileTypes: true })) {
      const caminho = join(pasta, e.name);
      if (e.isDirectory()) ler(caminho);
      else if (/\.tsx?$/.test(e.name)) {
        for (const m of readFileSync(caminho, "utf8").matchAll(/\b(?:read|useRead|call)\(\s*"([\w.]+)"\s*,/g)) passa.set(m[1]!, Math.max(passa.get(m[1]!) ?? 0, 1));
      }
    }
  };
  ler(join(raiz, "renderer"));
  return passa;
}

/** Parâmetros sem `?` nem valor padrão, abrindo a tupla do `...args: Parameters<...>` do contrato. */
function parametrosObrigatorios(checker: ts.TypeChecker, assinatura: ts.Signature): number {
  const [primeiro] = assinatura.parameters;
  const declaracao = primeiro?.valueDeclaration;
  if (assinatura.parameters.length === 1 && declaracao !== undefined && ts.isParameter(declaracao) && declaracao.dotDotDotToken !== undefined) {
    const tipo = checker.getTypeOfSymbol(primeiro!);
    if (checker.isTupleType(tipo)) return (tipo as ts.TupleTypeReference).target.elementFlags.filter((f) => (f & ts.ElementFlags.Required) !== 0).length;
  }
  return assinatura.parameters.filter((p) => !(p.valueDeclaration !== undefined && ts.isParameter(p.valueDeclaration) && (p.valueDeclaration.questionToken !== undefined || p.valueDeclaration.initializer !== undefined))).length;
}

test("nenhum handler da ponte descarta argumento que o contrato do canal declara", () => {
  const raiz = resolve(import.meta.dirname, "..");
  const arquivo = resolve(raiz, "electron/bridge.ts");
  const config = ts.getParsedCommandLineOfConfigFile(resolve(raiz, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined })!;
  const programa = ts.createProgram([arquivo], config.options);
  const checker = programa.getTypeChecker();
  const fonte = programa.getSourceFile(arquivo)!;

  const passa = argumentosQueATelaPassa(raiz);
  const descartam: string[] = [];
  let conferidos = 0;
  const visitar = (no: ts.Node): void => {
    if (ts.isPropertyAssignment(no) && (ts.isArrowFunction(no.initializer) || ts.isFunctionExpression(no.initializer)) && ts.isStringLiteral(no.name)) {
      const assinatura = checker.getContextualType(no.initializer)?.getCallSignatures()[0];
      if (assinatura !== undefined) {
        conferidos++;
        const obrigatorios = parametrosObrigatorios(checker, assinatura);
        const exigidos = Math.max(obrigatorios, passa.get(no.name.text) ?? 0);
        if (no.initializer.parameters.length < exigidos) descartam.push(no.name.text);
      }
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonte);
  assert.ok(conferidos > 100, `conferiu só ${conferidos} handlers`);
  assert.deepEqual(descartam, []);
});
