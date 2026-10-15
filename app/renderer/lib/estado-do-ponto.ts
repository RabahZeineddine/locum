/** Os mesmos estados do `StatusDot`; aqui à parte para a lógica rodar sem JSX. */
type Estado = "ok" | "aviso" | "erro" | "ocioso";

/**
 * O ponto de cada estado de execução. Ficam em aviso os que esperam uma
 * pessoa ou foram interrompidos; o que ainda não começou ou foi descartado
 * fica ocioso. Estado novo gravado no banco cai em ocioso em vez de quebrar.
 */
const PONTOS: Record<string, Estado> = {
  done: "ok",
  running: "ok",
  failed: "erro",
  paused: "aviso",
  awaiting_approval: "aviso",
  queued: "ocioso",
  pending: "ocioso",
  skipped: "ocioso",
  cancelled: "ocioso",
};

export function pontoDoEstado(estado: string): Estado {
  return PONTOS[estado] ?? "ocioso";
}
