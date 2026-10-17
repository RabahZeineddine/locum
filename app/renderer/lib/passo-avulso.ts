import { camposDoSchema, validarArgs, valorDoTexto, type Campo } from "./formulario-de-schema";
import type { PassoDoGrafo } from "./grafo";

/** O passo da tabela `steps`, no que o grafo e o formulário precisam dele. */
interface PassoDoRun {
  stepKey: string;
  origem: string;
  input: unknown;
}

/**
 * Os passos que o grafo desenha: os do spec e, depois deles, os avulsos da
 * tabela `steps` (a decisão olha a origem, nunca o tipo da ação). O avulso liga
 * ao passo de que deriva, quando ele disse de qual.
 */
export function passosDoGrafo(doSpec: readonly PassoDoGrafo[], doRun: readonly PassoDoRun[]): PassoDoGrafo[] {
  const avulsos = doRun
    .filter((p) => p.origem === "avulso")
    .map((p) => {
      const deriva = (p.input as { derivaDe?: unknown } | null)?.derivaDe;
      return { key: p.stepKey, needs: typeof deriva === "string" && doSpec.some((s) => s.key === deriva) ? [deriva] : [] };
    });
  return [...doSpec, ...avulsos];
}

export type ErroDoFormulario = { campo: string; motivo: "obrigatorio" | "tipo" | "json" };

function propriedades(schema: unknown): Record<string, { default?: unknown }> {
  const props = (schema as { properties?: unknown } | null)?.properties;
  return props !== null && typeof props === "object" ? (props as Record<string, { default?: unknown }>) : {};
}

/** O texto que cada campo mostra ao abrir: o `default` do esquema, quando há. */
export function valoresIniciais(schema: unknown): Record<string, string> {
  const valores: Record<string, string> = {};
  for (const [nome, prop] of Object.entries(propriedades(schema))) {
    const padrao = prop?.default;
    if (padrao === undefined) continue;
    valores[nome] = typeof padrao === "string" ? padrao : JSON.stringify(padrao);
  }
  return valores;
}

/** Campos que a pessoa escreve como JSON: o que o formulário não desdobra em controle próprio. */
export const escritoComoJson = (c: Pick<Campo, "tipo">): boolean => c.tipo === "json" || c.tipo === "object";

/**
 * O que a pessoa digitou, no tipo de cada campo do esquema. Vazio tira o
 * campo. Só o conteúdo: o alvo da ação vem do evento do run e não passa por aqui.
 */
export function montarConteudo(
  schema: unknown,
  textos: Record<string, string>,
): { conteudo: Record<string, unknown>; erros: ErroDoFormulario[] } {
  const campos = camposDoSchema(schema);
  const conteudo: Record<string, unknown> = {};
  const erros: ErroDoFormulario[] = [];
  for (const campo of campos) {
    const texto = textos[campo.nome] ?? "";
    if (texto.trim() === "") continue;
    if (escritoComoJson(campo)) {
      try {
        conteudo[campo.nome] = JSON.parse(texto);
      } catch {
        if (campo.aceitaTexto === true) conteudo[campo.nome] = texto;
        else erros.push({ campo: campo.nome, motivo: "json" });
      }
    } else if (campo.tipo === "enum") {
      conteudo[campo.nome] = campo.opcoes?.find((o) => String(o) === texto) ?? texto;
    } else {
      conteudo[campo.nome] = valorDoTexto(texto, campo);
    }
  }
  for (const e of validarArgs(campos, conteudo)) {
    if (!erros.some((x) => x.campo === e.caminho)) erros.push({ campo: e.caminho, motivo: e.motivo });
  }
  // Obrigatório com padrão no esquema (`findings: []`) já veio preenchido pelo valor inicial.
  return { conteudo, erros };
}
