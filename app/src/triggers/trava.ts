/**
 * Trava em memória por chave: quem chega com a chave ocupada espera a vez.
 *
 * Existe para o `tick` manual da tela não correr junto com a batida agendada
 * do mesmo gatilho, e para ler e gravar o registro de descartes sem que duas
 * escritas se atropelem. Vale dentro de um processo; a escrita condicional do
 * cursor continua sendo quem protege contra o `locum tick` de outro processo.
 */
const filas = new Map<string, Promise<unknown>>();

export async function comTrava<T>(chave: string, trabalho: () => Promise<T>): Promise<T> {
  const anterior = filas.get(chave) ?? Promise.resolve();
  const minha = anterior.then(trabalho, trabalho);
  const cauda = minha.catch(() => undefined);
  filas.set(chave, cauda);
  try {
    return await minha;
  } finally {
    if (filas.get(chave) === cauda) filas.delete(chave);
  }
}
