import { abrirServidorMcpLocal, type ServidorDeAprovacao } from "./servidor-de-aprovacao.js";
import type { FerramentaLocal } from "./nucleo.js";

/** O nome do servidor MCP local com que o Claude Code enxerga as ferramentas da conversa do run. */
export const SERVIDOR_LOCAL = "locum-conversa";

/** Resultado de uma ferramenta como texto, para o Claude Code. */
const comoTexto = (valor: unknown): string => (typeof valor === "string" ? valor : (JSON.stringify(valor, null, 2) ?? ""));

/**
 * As ferramentas da conversa servidas ao Claude Code por um servidor MCP local com token,
 * como o de aprovação. A definição é a mesma do caminho por API; erro vira resposta de
 * erro da ferramenta, para o modelo ler e seguir.
 */
export function abrirServidorLocal(ferramentas: FerramentaLocal[], sinal: AbortSignal): Promise<ServidorDeAprovacao> {
  return abrirServidorMcpLocal(SERVIDOR_LOCAL, (mcp) => {
    for (const f of ferramentas) {
      mcp.registerTool(f.nome, { description: f.descricao, inputSchema: f.entrada }, async (entrada: Record<string, unknown>) => {
        try {
          return { content: [{ type: "text" as const, text: comoTexto(await f.executar(entrada, sinal)) }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
        }
      });
    }
  });
}
