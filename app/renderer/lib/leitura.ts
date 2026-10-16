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
  /** `stale`: a última releitura falhou e o dado na tela é o anterior. */
  | { status: "ready"; data: T; error: undefined; stale?: boolean }
  | { status: "error"; data: undefined; error: E };

export function estadoDeCarregando<T, E>(): EstadoDeLeitura<T, E> {
  return { status: "loading", data: undefined, error: undefined };
}

/** Dado igual ao da tela devolve o mesmo estado, sem render nem efeito novo. */
export function estadoAoLerDados<T, E>(atual: EstadoDeLeitura<T, E>, data: T): EstadoDeLeitura<T, E> {
  if (atual.status === "ready" && atual.stale !== true && JSON.stringify(atual.data) === JSON.stringify(data)) return atual;
  return { status: "ready", data, error: undefined };
}

/** Com dados na tela, a falha de uma releitura os mantém e só marca `stale`. */
export function estadoAoFalharLeitura<T, E>(atual: EstadoDeLeitura<T, E>, error: E): EstadoDeLeitura<T, E> {
  if (atual.status === "ready") return atual.stale === true ? atual : { ...atual, stale: true };
  return { status: "error", data: undefined, error };
}

export type ResultadoDeLeitura<T> = { ok: true; data: T } | { ok: false; erro: unknown };

/**
 * A leitura em voo nunca é cancelada nem duplicada: um pedido com leitura em
 * andamento só marca "suja", e quando a atual volta ela é aplicada e, se ficou
 * suja, relê uma vez. Assim, com leitura lenta e avisos frequentes, há no
 * máximo uma leitura por vez e o dado chega.
 */
export function criarCicloDeLeitura<T>(ler: () => Promise<T>, aplicar: (r: ResultadoDeLeitura<T>) => void) {
  let emVoo = false;
  let suja = false;
  let descartado = false;
  const iniciar = (): void => {
    emVoo = true;
    suja = false;
    ler().then(
      (data) => concluir({ ok: true, data }),
      (erro: unknown) => concluir({ ok: false, erro }),
    );
  };
  const concluir = (r: ResultadoDeLeitura<T>): void => {
    emVoo = false;
    if (descartado) return;
    aplicar(r);
    if (suja) iniciar();
  };
  return {
    pedir(): void {
      if (descartado) return;
      if (emVoo) suja = true;
      else iniciar();
    },
    descartar(): void {
      descartado = true;
    },
  };
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
