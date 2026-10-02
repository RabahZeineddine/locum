import type { McpServerConfig } from "../config/types.js";
import { CREDENTIAL_PLACEHOLDER } from "../services/secret-service.js";

/**
 * O que aparece no lugar de um valor de `env` ou `headers` na saída das
 * ferramentas.
 *
 * Quem cadastra um token direto no `env`, sem passar pelo cofre, não espera
 * vê-lo na conversa de um modelo que só listou os servidores. O marcador
 * `${credential}` sai como está, porque não é segredo: é o lugar onde o cofre
 * entra.
 */
export const HIDDEN_VALUE = "<oculto>";

function ocultar(valores: Record<string, string> | undefined): Record<string, string> | undefined {
  if (valores === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(valores).map(([chave, valor]) => [chave, valor === CREDENTIAL_PLACEHOLDER ? valor : HIDDEN_VALUE]),
  );
}

export function redactServerConfig<T extends McpServerConfig>(config: T): T {
  return {
    ...config,
    ...(config.env !== undefined ? { env: ocultar(config.env) } : {}),
    ...(config.headers !== undefined ? { headers: ocultar(config.headers) } : {}),
  };
}

/**
 * Devolve o valor cadastrado onde quem atualiza mandou de volta o marcador.
 *
 * Um modelo que lista, muda uma chave e manda o mapa inteiro de volta
 * gravaria `<oculto>` por cima de cada token. Chave marcada que não existia
 * antes cai fora, porque não há valor nenhum a manter.
 */
export function restoreHidden(
  atual: Record<string, string> | undefined,
  novo: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (novo === undefined) return undefined;
  const saida: Record<string, string> = {};
  for (const [chave, valor] of Object.entries(novo)) {
    if (valor !== HIDDEN_VALUE) saida[chave] = valor;
    else if (atual?.[chave] !== undefined) saida[chave] = atual[chave];
  }
  return saida;
}
