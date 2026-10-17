import { lerErroComCodigo } from "../../src/services/erro-com-codigo";

/** O erro de serviço com código, no idioma do app; sem código, a mensagem como veio. */
export function traduzirErroDoServico(
  t: (chave: string, variaveis?: Record<string, unknown>) => string,
  mensagem: string,
  /** Como escrever o argumento de cada código (o rótulo de uma ação, por exemplo). Ausente, ele vai cru. */
  argumento: (codigo: string, valor: string) => string = (_, valor) => valor,
): string {
  const lido = lerErroComCodigo(mensagem);
  return lido === null ? mensagem : t(`erroDoServico.${lido.codigo}`, { argumento: argumento(lido.codigo, lido.argumento) });
}

/** O erro diz que o que a pessoa viu mudou: a saída é ler de novo, e não tentar outra vez. */
export function pedeRecarregar(mensagem: string): boolean {
  return lerErroComCodigo(mensagem)?.codigo === "pendencia_mudou";
}
