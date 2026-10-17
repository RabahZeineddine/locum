/**
 * Passado este tempo sem renovar, o dono da trava é dado como perdido, mesmo
 * que o pid exista (reaproveitado). O dono vivo renova a cada operação e num
 * batimento, e por isso não vence enquanto estiver ativo.
 */
export const VALIDADE_DA_TRAVA_MS = 15 * 60 * 1000;

export function pidVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A trava guardada (`{pid, em}`) é de um processo vivo que renovou há pouco: há uma volta ou um cartão em andamento. */
export function travaEmAndamento(valor: string | null | undefined, agora: number = Date.now()): boolean {
  if (valor === null || valor === undefined || valor === "") return false;
  try {
    const trava = JSON.parse(valor) as { pid?: number; em?: number } | null;
    if (trava === null || typeof trava.pid !== "number") return false;
    return agora - (trava.em ?? 0) <= VALIDADE_DA_TRAVA_MS && pidVivo(trava.pid);
  } catch {
    return false;
  }
}
