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
      else if (/\.tsx?$/.test(e.name)) contar(ts.createSourceFile(caminho, readFileSync(caminho, "utf8"), ts.ScriptTarget.Latest, true), passa);
    }
  };
  ler(join(raiz, "renderer"));
  return passa;
}

/** Toda chamada read/useRead/call (com genérico ou não), com o canal literal ou numa constante do arquivo que o resolve. */
function contar(fonte: ts.SourceFile, passa: Map<string, number>): void {
  const constantes = new Map<string, string>();
  const colher = (no: ts.Node): void => {
    if (ts.isVariableDeclaration(no) && ts.isIdentifier(no.name) && no.initializer !== undefined) {
      const valor = ts.isAsExpression(no.initializer) ? no.initializer.expression : no.initializer;
      if (ts.isStringLiteralLike(valor)) constantes.set(no.name.text, valor.text);
    }
    ts.forEachChild(no, colher);
  };
  colher(fonte);
  const visitar = (no: ts.Node): void => {
    if (ts.isCallExpression(no)) {
      const f = no.expression;
      const nome = ts.isIdentifier(f) ? f.text : ts.isPropertyAccessExpression(f) ? f.name.text : "";
      const [canal, ...resto] = no.arguments;
      if (["read", "useRead", "call"].includes(nome) && canal !== undefined) {
        const literal = ts.isStringLiteralLike(canal) ? canal.text : ts.isIdentifier(canal) ? constantes.get(canal.text) : undefined;
        if (literal !== undefined) passa.set(literal, Math.max(passa.get(literal) ?? 0, resto.length));
      }
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonte);
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
    if (ts.isPropertyAssignment(no) && ts.isStringLiteral(no.name) && (ts.isArrowFunction(no.initializer) || ts.isFunctionExpression(no.initializer) || ts.isIdentifier(no.initializer) || ts.isPropertyAccessExpression(no.initializer))) {
      const assinatura = checker.getContextualType(no.initializer)?.getCallSignatures()[0];
      if (assinatura !== undefined) {
        conferidos++;
        // Handler por referência: vale o que o método declara.
        const declarados = ts.isArrowFunction(no.initializer) || ts.isFunctionExpression(no.initializer) ? no.initializer.parameters.length : (checker.getTypeAtLocation(no.initializer).getCallSignatures()[0]?.parameters.length ?? Number.MAX_SAFE_INTEGER);
        const obrigatorios = parametrosObrigatorios(checker, assinatura);
        const exigidos = Math.max(obrigatorios, passa.get(no.name.text) ?? 0);
        if (declarados < exigidos) descartam.push(no.name.text);
      }
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonte);
  assert.ok(conferidos > 100, `conferiu só ${conferidos} handlers`);
  assert.deepEqual(descartam, []);
});
