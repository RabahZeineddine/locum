import type { AgentProfile } from "../../src/config/types";

/** O quanto das instruções o painel do passo mostra. */
const LIMITE_DO_TRECHO = 280;

export interface ResumoDoAgent {
  /** O modelo sem o provedor: "claude-sonnet-5". */
  modelo: string;
  /** Cada conexão do agent e quantas ferramentas dela estão ligadas. */
  conexoes: { id: string; ferramentas: number }[];
  /** Ferramentas avulsas, fora de conexão e de toolset. */
  avulsas: number;
  toolsets: number;
  trecho: string;
  temMais: boolean;
}

/** O resumo só leitura de um agent da biblioteca, para o passo que o chama. */
export function resumoDoAgent(
  spec: Pick<AgentProfile, "model" | "instructions" | "connections" | "tools" | "toolsets">,
): ResumoDoAgent {
  const texto = spec.instructions.trim();
  const temMais = texto.length > LIMITE_DO_TRECHO;
  return {
    modelo: spec.model.split("/").at(-1) ?? spec.model,
    conexoes: spec.connections.map((c) => ({ id: c.connectionId, ferramentas: Object.values(c.tools).filter((v) => v !== false).length })),
    avulsas: spec.tools.length,
    toolsets: spec.toolsets.length,
    trecho: temMais ? `${texto.slice(0, LIMITE_DO_TRECHO)}…` : texto,
    temMais,
  };
}
