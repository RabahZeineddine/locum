/** Relógio injetável: a tela usa o da janela, o teste usa um que ele mesmo dispara. */
export interface Agenda {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  now(): number;
}

const DA_JANELA: Agenda = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export type Desfecho = "ok" | "erro" | "parou";

export function desfechoDe(status: string): Desfecho | null {
  if (status === "done") return "ok";
  if (status === "failed" || status === "cancelled") return "erro";
  if (status === "paused") return "parou";
  return null;
}

export const RELER_MS = 1500;
export const DESISTE_DE_SEGUIR_MS = 30 * 60_000;

/**
 * Segue um run até ele terminar, relendo a cada `RELER_MS`.
 *
 * `parar` encerra de vez: cancela a releitura agendada e descarta a que estava
 * em voo, para quem fechou o aviso não ter o desfecho entregue depois.
 */
export function seguirRun<R extends { status: string }>(opcoes: {
  ler: () => Promise<R | undefined>;
  aoTerminar: (run: R, desfecho: Desfecho) => void;
  aoDesistir: () => void;
  agenda?: Agenda;
  desisteMs?: number;
}): { parar: () => void } {
  const agenda = opcoes.agenda ?? DA_JANELA;
  const desisteMs = opcoes.desisteMs ?? DESISTE_DE_SEGUIR_MS;
  const comeco = agenda.now();
  let parado = false;
  let timer: unknown = null;

  const agendar = (ms: number): void => {
    timer = agenda.setTimeout(() => {
      timer = null;
      olhar();
    }, ms);
  };

  const olhar = (): void => {
    opcoes.ler().then(
      (run) => {
        if (parado) return;
        const desfecho = run === undefined ? null : desfechoDe(run.status);
        if (run === undefined || desfecho === null) {
          if (agenda.now() - comeco > desisteMs) return opcoes.aoDesistir();
          return agendar(RELER_MS);
        }
        opcoes.aoTerminar(run, desfecho);
      },
      () => {
        if (!parado) agendar(RELER_MS * 2);
      },
    );
  };
  olhar();

  return {
    parar: () => {
      parado = true;
      if (timer !== null) agenda.clearTimeout(timer);
      timer = null;
    },
  };
}
