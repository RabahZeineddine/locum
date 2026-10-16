import Database from "better-sqlite3";

/**
 * Descobre que o banco mudou, venha a escrita de onde vier.
 *
 * `PRAGMA data_version` muda numa conexão quando OUTRA conexão confirma uma
 * transação. Por isso o observador abre uma conexão só dele, de leitura: ela
 * enxerga a escrita do `Locum --mcp` (outro processo) e também a do scheduler e
 * do executor (outra conexão do mesmo processo). A leitura do pragma não toca
 * em tabela, então com o banco parado a conferência é quase de graça.
 *
 * Uma rajada de escritas entre duas conferências vira um aviso só. Ainda não
 * sabemos qual tabela mudou, então o aviso diz `*` (invalida tudo); o renderer
 * relê sem piscar, e quem quiser refinar por área troca só este valor.
 */
export const INTERVALO_DO_DETECTOR_MS = 1000;

export interface DetectorDeMudanca {
  /** Confere agora. Devolve se avisou. */
  verificar(): boolean;
  iniciar(): void;
  parar(): void;
}

export interface OpcoesDoDetector {
  lerVersao: () => number;
  aoMudar: (areas: string[]) => void;
  intervaloMs?: number;
  /** Agenda `fn` a cada `ms` e devolve quem cancela. Troca nos testes. */
  agendar?: (fn: () => void, ms: number) => () => void;
}

function agendarComTimer(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
}

export function criarDetectorDeMudanca({
  lerVersao,
  aoMudar,
  intervaloMs = INTERVALO_DO_DETECTOR_MS,
  agendar = agendarComTimer,
}: OpcoesDoDetector): DetectorDeMudanca {
  let ultima = lerVersao();
  let cancelar: (() => void) | null = null;

  const verificar = (): boolean => {
    let atual: number;
    try {
      atual = lerVersao();
    } catch {
      return false; // banco ocupado ou fechando: tenta no próximo ciclo
    }
    if (atual === ultima) return false;
    ultima = atual;
    aoMudar(["*"]);
    return true;
  };

  return {
    verificar,
    iniciar() {
      if (cancelar === null) cancelar = agendar(verificar, intervaloMs);
    },
    parar() {
      cancelar?.();
      cancelar = null;
    },
  };
}

export interface ObservadorDoBanco {
  lerVersao: () => number;
  fechar: () => void;
}

/** Conexão própria só para o `data_version`. */
export function abrirObservadorDoBanco(caminho: string, nativeBinding?: string): ObservadorDoBanco {
  const conexao = new Database(caminho, nativeBinding ? { nativeBinding } : {});
  conexao.pragma("busy_timeout = 250");
  return {
    lerVersao: () => conexao.pragma("data_version", { simple: true }) as number,
    fechar: () => conexao.close(),
  };
}
