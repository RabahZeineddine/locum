import { createContext, useContext, useMemo, useRef } from "react";
import type { ReactNode } from "react";

/**
 * A iniciativa atual, para paleta e assistente.
 *
 * A fonte muda por contexto: dentro de `#/initiatives/<slug>` e sempre a rota,
 * fora dela e a ultima visitada, guardada so em memoria (sem persistir em
 * disco nem em `settings`). O provider recebe `ativa`/`detalhe` do unico
 * `useRota` do `Layout`, e nao chama `useRota` de novo: dois ouvintes de
 * `hashchange` discordariam por um quadro na troca de destino.
 */
interface CurrentInitiativeValue {
  /** O slug da iniciativa atual, ou nulo se nenhuma foi visitada ainda. */
  slug: string | null;
}

const CurrentInitiativeContext = createContext<CurrentInitiativeValue>({ slug: null });

function slugDaRota(ativa: string, detalhe: string | null): string | null {
  if (ativa !== "initiatives" || detalhe === null) return null;
  const corte = detalhe.indexOf("/");
  const slug = corte === -1 ? detalhe : detalhe.slice(0, corte);
  return slug.length > 0 ? slug : null;
}

export function CurrentInitiativeProvider({
  ativa,
  children,
  detalhe,
}: {
  ativa: string;
  children: ReactNode;
  detalhe: string | null;
}) {
  const daRota = slugDaRota(ativa, detalhe);
  const ultimaVisitada = useRef<string | null>(null);
  if (daRota !== null) ultimaVisitada.current = daRota;

  const valor = useMemo<CurrentInitiativeValue>(
    () => ({ slug: daRota ?? ultimaVisitada.current }),
    [daRota],
  );

  return (
    <CurrentInitiativeContext.Provider value={valor}>{children}</CurrentInitiativeContext.Provider>
  );
}

export function useCurrentInitiative(): CurrentInitiativeValue {
  return useContext(CurrentInitiativeContext);
}
