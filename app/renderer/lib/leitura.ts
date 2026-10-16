/**
 * A lógica de estado do `useRead`, sem React, para poder ser testada.
 *
 * Regra do ao-vivo: só a primeira leitura (ou a de outro argumento) mostra
 * "carregando". Releitura por invalidação mantém os dados na tela até os novos
 * chegarem, para o contador não piscar nem a tela perder formulário, rolagem e
 * seleção.
 */
export type EstadoDeLeitura<T, E = Error> =
  | { status: "loading"; data: undefined; error: undefined }
  | { status: "ready"; data: T; error: undefined }
  | { status: "error"; data: undefined; error: E };

export function estadoAoComecarLeitura<T, E>(atual: EstadoDeLeitura<T, E>, porInvalidacao: boolean): EstadoDeLeitura<T, E> {
  if (porInvalidacao && atual.status === "ready") return atual;
  return { status: "loading", data: undefined, error: undefined };
}

/** Dado igual ao da tela devolve o mesmo estado, sem render nem efeito novo. */
export function estadoAoLerDados<T, E>(atual: EstadoDeLeitura<T, E>, data: T): EstadoDeLeitura<T, E> {
  if (atual.status === "ready" && JSON.stringify(atual.data) === JSON.stringify(data)) return atual;
  return { status: "ready", data, error: undefined };
}

/** Com dados na tela, a falha de uma releitura espera a próxima em vez de apagá-los. */
export function estadoAoFalharLeitura<T, E>(atual: EstadoDeLeitura<T, E>, error: E): EstadoDeLeitura<T, E> {
  if (atual.status === "ready") return atual;
  return { status: "error", data: undefined, error };
}

/**
 * Aviso de mudança com a janela escondida ou minimizada não relê: fica
 * pendente e vira uma releitura só quando a janela volta.
 */
export function criarPorteiroDeAvisos(visivel: () => boolean, invalidar: () => void) {
  let pendente = false;
  return {
    avisar(): void {
      if (visivel()) invalidar();
      else pendente = true;
    },
    voltou(): void {
      if (!pendente || !visivel()) return;
      pendente = false;
      invalidar();
    },
  };
}
