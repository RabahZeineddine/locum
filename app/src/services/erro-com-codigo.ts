/**
 * Códigos dos erros de serviço que a tela traduz. A mensagem segue legível para o MCP e
 * o log (`<código>:<argumento>: <texto>`); a tela lê o código e escreve no idioma do app.
 */
export const CODIGOS_DE_ERRO = [
  "proposta_recusada",
  "pendencia_mudou",
  "pendencia_nao_encontrada",
  "pendencia_de_outro_run",
  "pendencia_resolvida",
  "run_nao_encontrado",
  "run_em_andamento",
  "run_de_ensaio",
  "modelo_inexistente",
  "acao_sem_esquema",
  "acao_sem_approve",
  "conteudo_invalido",
  "derivacao_invalida",
  "alvo_no_conteudo",
] as const;

export type CodigoDeErro = (typeof CODIGOS_DE_ERRO)[number];

/** O argumento não leva `:` nem espaço: é um id, uma chave de passo ou o tipo da ação. */
export function erroComCodigo(codigo: CodigoDeErro, argumento: string, texto: string): Error {
  return new Error(`${codigo}:${argumento}: ${texto}`);
}

/** O código e o argumento de uma mensagem de erro de serviço, ou nulo quando ela não leva código. */
export function lerErroComCodigo(mensagem: string): { codigo: CodigoDeErro; argumento: string } | null {
  const achado = /(?:^|\s)([a-z]+(?:_[a-z]+)*):([^:\s]*): /.exec(mensagem);
  const codigo = achado?.[1];
  return codigo !== undefined && (CODIGOS_DE_ERRO as readonly string[]).includes(codigo) ? { codigo: codigo as CodigoDeErro, argumento: achado![2]! } : null;
}
