import { StatusDot } from "@/components/ui/status-dot";
import { seguirRun } from "@/lib/acompanhar-run";
import { read } from "@/lib/bridge";
import { rotuloDoErroDeRun } from "@/lib/rotulos";
import { X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { RotaId } from "./rotas";

type Tom = "andando" | "ok" | "erro";

interface Aviso {
  id: string;
  tom: Tom;
  texto: string;
  /** Leva à execução. */
  runId?: string;
}

export interface Toasts {
  /** Mostra o que aconteceu com uma automação que acabou de ser pedida e segue o run até ele terminar. */
  acompanhar(run: { runId: string; nome: string; aviso?: string; aoTerminar?: () => void }): void;
  /** Um aviso que não é de run, como a recusa de começar. */
  recusar(texto: string): void;
  abrirRun(runId: string): void;
}

const SEM_TOASTS: Toasts = { acompanhar: () => undefined, recusar: () => undefined, abrirRun: () => undefined };
const Contexto = createContext<Toasts>(SEM_TOASTS);

/** O que a tela usa para dizer o resultado de "Executar agora" e levar ao run. */
export const useToasts = (): Toasts => useContext(Contexto);

/** Quanto o aviso de desfecho fica na tela. Erro fica mais, para dar tempo de ler. */
const FICA_MS = { ok: 8_000, erro: 20_000 } as const;

/**
 * Os avisos do canto da janela.
 *
 * "Executar agora" devolve o run assim que ele existe, e o desfecho vem minutos
 * depois. O aviso acompanha o run pela mesma leitura da tela de Execuções e
 * muda de "rodando" para "terminou" ou "falhou com o erro", e o clique nele
 * abre o run.
 */
export function ProvedorDeToasts({ children, navegar }: { children: ReactNode; navegar: (id: RotaId, detalhe?: string) => void }) {
  const { t } = useTranslation();
  const [avisos, setAvisos] = useState<Aviso[]>([]);
  const seguindo = useRef(new Map<string, { parar: () => void }>());
  const timers = useRef(new Map<string, number>());

  useEffect(() => {
    const acompanhamentos = seguindo.current;
    const abertos = timers.current;
    return () => {
      acompanhamentos.forEach((a) => a.parar());
      abertos.forEach((id) => window.clearTimeout(id));
    };
  }, []);

  const mostrar = useCallback((aviso: Aviso) => setAvisos((atuais) => [...atuais.filter((a) => a.id !== aviso.id), aviso]), []);
  // Só troca o que ainda está na tela: o aviso fechado não volta com o desfecho.
  const atualizar = useCallback((aviso: Aviso) => setAvisos((atuais) => atuais.map((a) => (a.id === aviso.id ? aviso : a))), []);
  const tirar = useCallback((id: string) => {
    seguindo.current.get(id)?.parar();
    seguindo.current.delete(id);
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
    setAvisos((atuais) => atuais.filter((a) => a.id !== id));
  }, []);
  const sumirDepois = useCallback(
    (id: string, ms: number) => {
      const anterior = timers.current.get(id);
      if (anterior !== undefined) window.clearTimeout(anterior);
      timers.current.set(
        id,
        window.setTimeout(() => {
          timers.current.delete(id);
          tirar(id);
        }, ms),
      );
    },
    [tirar],
  );

  const api = useMemo<Toasts>(() => {
    const abrirRun = (runId: string): void => navegar("runs", runId);

    const recusar = (texto: string): void => {
      const id = `recusa-${Date.now()}`;
      mostrar({ id, tom: "erro", texto });
      sumirDepois(id, FICA_MS.erro);
    };

    const acompanhar: Toasts["acompanhar"] = ({ runId, nome, aviso, aoTerminar }) => {
      if (seguindo.current.has(runId)) return;
      mostrar({ id: runId, tom: "andando", texto: `${t("toast.running", { name: nome })}${aviso === undefined ? "" : `. ${aviso}`}`, runId });
      seguindo.current.set(
        runId,
        seguirRun({
          ler: () => read("runs.get", runId),
          aoDesistir: () => tirar(runId),
          aoTerminar: (run, desfecho) => {
            seguindo.current.delete(runId);
            // Falha sem passo que falhou (a recusa de começar, um run cancelado)
            // também diz o erro do run, e não que "não começou".
            const motivo = rotuloDoErroDeRun(t, run.failedStep?.error ?? run.error ?? "");
            const texto =
              desfecho === "ok"
                ? t("toast.done", { name: nome })
                : desfecho === "parou"
                  ? t("toast.paused", { name: nome })
                  : motivo === ""
                    ? t("toast.failedBare", { name: nome })
                    : t("toast.failed", { name: nome, error: motivo });
            atualizar({ id: runId, tom: desfecho === "erro" ? "erro" : "ok", texto, runId });
            aoTerminar?.();
            sumirDepois(runId, desfecho === "erro" ? FICA_MS.erro : FICA_MS.ok);
          },
        }),
      );
    };

    return { acompanhar, recusar, abrirRun };
  }, [atualizar, mostrar, navegar, sumirDepois, t, tirar]);

  return (
    <Contexto.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2" data-locum-toasts={avisos.length}>
        {avisos.map((aviso) => (
          <div
            className="border-border bg-popover text-popover-foreground pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px] shadow-lg"
            data-locum-toast={aviso.tom}
            key={aviso.id}
            role="status"
          >
            <StatusDot className="mt-1.5" estado={aviso.tom === "erro" ? "erro" : aviso.tom === "ok" ? "ok" : "aviso"} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="line-clamp-3 break-words">{aviso.texto}</span>
              {aviso.runId === undefined ? null : (
                <button
                  className="text-primary w-fit cursor-pointer text-xs hover:underline"
                  data-locum-toast-abrir={aviso.runId}
                  onClick={() => {
                    navegar("runs", aviso.runId);
                    tirar(aviso.id);
                  }}
                  type="button"
                >
                  {t("toast.open")}
                </button>
              )}
            </div>
            <button
              aria-label={t("toast.dismiss")}
              className="text-muted-foreground hover:text-foreground cursor-pointer"
              onClick={() => tirar(aviso.id)}
              type="button"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </Contexto.Provider>
  );
}
