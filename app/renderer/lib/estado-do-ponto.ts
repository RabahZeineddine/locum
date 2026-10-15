/** Os mesmos estados do `StatusDot`; aqui à parte para a lógica rodar sem JSX. */
type Estado = "ok" | "aviso" | "erro" | "ocioso";

/**
 * O ponto de cada estado de execução. Ficam em aviso os que esperam uma
 * pessoa ou foram interrompidos; o que ainda não começou ou foi descartado
 * fica ocioso. Estado novo gravado no banco cai em ocioso em vez de quebrar.
 */
export const PONTOS: Record<string, Estado> = {
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
  return Object.hasOwn(PONTOS, estado) ? PONTOS[estado]! : "ocioso";
}

/**
 * Provedor de modelo. `available` só diz que há chave ou assinatura, não que o
 * provedor responde: o ponto verde exige a lista de modelos lida e não vazia.
 * Ainda lendo é ocioso; erro ou lista vazia (Ollama parado, chave recusada) é erro.
 * Desligado pela pessoa e sem chave também são ociosos.
 */
export function pontoDoProvedor(
  p: { available: boolean; disabled: boolean },
  lidos: { modelos: string[]; erro?: string } | null,
): Estado {
  if (p.disabled || !p.available || lidos === null) return "ocioso";
  return lidos.modelos.length > 0 ? "ok" : "erro";
}

/** O Locum cadastrado numa ferramenta de código: ligado, apontando para outro lugar, ou ausente. */
export function pontoDaFerramenta(situacao: "connected" | "stale" | "absent" | null): Estado {
  if (situacao === "connected") return "ok";
  return situacao === "stale" ? "aviso" : "ocioso";
}
