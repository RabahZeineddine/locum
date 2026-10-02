import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Roteamento da janela, por hash.
 *
 * Nao existe servidor por tras do renderer: a pagina e um arquivo no disco,
 * carregado por `file://`. Um caminho escrito pelo History API ate navegaria,
 * mas a primeira recarga pediria ao sistema de arquivos um
 * `dist/renderer/agents` que nunca existiu. O hash fica fora do caminho, entao
 * recarregar, abrir por deep link e voltar pelo historico levam todos ao mesmo
 * lugar sem nada atras respondendo.
 */

export interface Local<Id extends string> {
  /** O destino da barra lateral. */
  ativa: Id;
  /** O que veio depois dele, ou nulo. Ex: o identificador de um run. */
  detalhe: string | null;
}

/**
 * Pares de prefixo antigo e novo do hash, do mais longo para o mais curto.
 *
 * Os destinos tinham nome em português e passaram para inglês. Deep link,
 * notificação e janela restaurada de uma versão anterior ainda chegam com o
 * nome velho, e cair no padrão perderia o run ou a seção que a pessoa pediu.
 */
export type Antigos = readonly (readonly [string, string])[];

/**
 * Troca o prefixo antigo pelo novo e corrige a barra de endereço, para que o
 * voltar do histórico não reabra o nome velho.
 */
function traduzir(bruto: string, antigos: Antigos): string {
  for (const [velho, novo] of antigos) {
    if (bruto !== velho && !bruto.startsWith(`${velho}/`)) continue;
    const traduzido = novo + bruto.slice(velho.length);
    globalThis.history?.replaceState(null, "", `#/${traduzido}`);
    return traduzido;
  }
  return bruto;
}

/**
 * O hash cru vira destino mais detalhe.
 *
 * O primeiro segmento e o destino; o resto vai inteiro para `detalhe`, sem ser
 * quebrado de novo, porque identificador com barra dentro nao e problema do
 * roteador. Segmento que nao e destino conhecido cai no padrao e descarta o
 * resto: hash velho chega de deep link e de janela restaurada, e deixar a
 * janela em branco seria pior do que voltar para a inbox.
 */
function lerHash<Id extends string>(ids: readonly Id[], padrao: Id, antigos: Antigos = []): Local<Id> {
  const bruto = traduzir(globalThis.location?.hash.replace(/^#\/?/, "") ?? "", antigos);
  const corte = bruto.indexOf("/");
  const cabeca = corte === -1 ? bruto : bruto.slice(0, corte);
  const resto = corte === -1 ? "" : bruto.slice(corte + 1);

  if (!(ids as readonly string[]).includes(cabeca)) return { ativa: padrao, detalhe: null };
  return { ativa: cabeca as Id, detalhe: resto.length > 0 ? decodeURIComponent(resto) : null };
}

/**
 * Devolve o local ativo e a funcao que navega.
 *
 * Navegar escreve o hash e deixa o `hashchange` mandar de volta, em vez de
 * gravar o estado direto: assim o caminho e o mesmo para clique na barra,
 * botao de voltar e URL digitada, e a tela nunca discorda da barra de
 * endereco.
 */
export function useRota<Id extends string>(
  ids: readonly Id[],
  padrao: Id,
  antigos: Antigos = [],
): Local<Id> & { navegar: (id: Id, detalhe?: string) => void } {
  const [local, setLocal] = useState<Local<Id>>(() => lerHash(ids, padrao, antigos));

  // O catalogo entra por valor, pelo mesmo motivo do `useRead`: quem chama
  // passa a lista literal, que muda de referencia a cada render, e comparar
  // por identidade trocaria o ouvinte de `hashchange` sem necessidade.
  const chave = ids.join(",");
  const catalogo = useRef(ids);
  catalogo.current = ids;
  const traducoes = useRef(antigos);
  traducoes.current = antigos;

  useEffect(() => {
    const ouvir = () =>
      setLocal((antes) => {
        const agora = lerHash(catalogo.current, padrao, traducoes.current);
        // Gravar sempre um objeto novo faria toda tela remontar a cada
        // `hashchange`, inclusive o que so trocou o fragmento e voltou igual.
        return antes.ativa === agora.ativa && antes.detalhe === agora.detalhe ? antes : agora;
      });
    // A primeira leitura acontece antes do ouvinte existir, e o hash pode ter
    // mudado no meio. Reler aqui fecha essa fresta.
    ouvir();
    globalThis.addEventListener("hashchange", ouvir);
    return () => globalThis.removeEventListener("hashchange", ouvir);
  }, [chave, padrao]);

  const navegar = useCallback((id: Id, detalhe?: string) => {
    const cauda = detalhe === undefined ? "" : `/${encodeURIComponent(detalhe)}`;
    globalThis.location.hash = `#/${id}${cauda}`;
  }, []);

  return { ...local, navegar };
}
