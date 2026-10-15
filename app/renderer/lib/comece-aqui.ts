import { SERVIDOR_NATIVO } from "../../src/config/types.js";

/** O que o guia da Hoje precisa saber de uma conexão. */
export interface ConexaoParaOPasso {
  id: string;
  state: "connected" | "attention" | "error" | "off" | "available" | "soon";
  reason: string | null;
  custom: boolean;
}

export interface PassoDoComeco {
  id: "model" | "connection" | "agent" | "trigger";
  feito: boolean;
}

/**
 * Conexão de verdade: respondeu a um teste ou foi autorizada. O servidor
 * interno do Locum vem junto de qualquer perfil, e um servidor importado
 * desligado ou nunca testado ainda não trouxe trabalho de lugar nenhum.
 */
export function ehConexaoReal(c: ConexaoParaOPasso): boolean {
  if (c.id === SERVIDOR_NATIVO || c.state !== "connected") return false;
  return !(c.custom && c.reason === "untested");
}

/** Os passos do guia, na ordem em que fazem sentido. */
export function passosDoComeco(entrada: {
  modelo: boolean;
  conexoes: readonly ConexaoParaOPasso[];
  agents: number;
  gatilho: boolean;
}): PassoDoComeco[] {
  return [
    { id: "model", feito: entrada.modelo },
    { id: "connection", feito: entrada.conexoes.some(ehConexaoReal) },
    { id: "agent", feito: entrada.agents > 0 },
    { id: "trigger", feito: entrada.gatilho },
  ];
}
