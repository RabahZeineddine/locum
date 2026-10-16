import { z } from "zod";
import { limparSegredos } from "../pacote/limpeza.js";
import { redactSecrets } from "./redact.js";

/**
 * Resposta de ferramenta no formato do protocolo.
 *
 * Erro que sobe de dentro de uma ferramenta viraria falha de transporte, e o
 * cliente so veria "a chamada quebrou". Passando por aqui ele recebe a mensagem
 * como resultado marcado com `isError`, que e o que o modelo do outro lado
 * consegue ler e corrigir sozinho.
 *
 * O registro em si continua em cada ferramenta, e nao num embrulho generico,
 * porque e dali que sai a inferencia de tipo do schema de entrada.
 */
export async function respond(produce: () => Promise<unknown>) {
  try {
    // Toda saída passa pela redação: nenhuma ferramenta devolve credencial,
    // mesmo a que lê texto livre (payload da fila, erro de gatilho, conversa).
    const value = redactSecrets(await produce());
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value ?? null, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: limparSegredos(describe(err)) }],
      isError: true,
    };
  }
}

/**
 * Falha de validacao sai com o caminho de cada campo em vez do JSON cru que o
 * zod poe no `message`. Quem le do outro lado e um modelo tentando consertar a
 * propria chamada, e o caminho e o que diz onde mexer.
 */
function describe(err: unknown): string {
  if (err instanceof z.ZodError) return `entrada invalida:\n${z.prettifyError(err)}`;
  return err instanceof Error ? err.message : String(err);
}
