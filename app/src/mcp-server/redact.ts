import type { McpServerConfig } from "../config/types.js";
import type { McpServerEntry, McpVinculo } from "../services/mcp-service.js";
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

/**
 * A origem de um servidor vinculado, para quem lê pela ferramenta: de onde a
 * configuração vem, o arquivo para editar, e se há mudança esperando aceite.
 * O comando de um vinculado não se edita por aqui, e o texto diz isso.
 */
export function origemParaLeitura(entrada: McpServerEntry, vinculo: McpVinculo | undefined) {
  if (entrada.source === null || vinculo === undefined) return { linked: false as const };
  return {
    linked: true as const,
    origin: {
      source: entrada.source,
      label: vinculo.rotulo,
      file: vinculo.arquivo,
      state: vinculo.estado,
      ...(vinculo.estado === "mudou"
        ? { note: "the origin changed and waits for a person to accept it in the app; the previous accepted configuration is in use" }
        : vinculo.estado === "sumiu"
          ? { note: "the origin no longer has this server; the last accepted configuration is in use" }
          : {}),
    },
    note: "linked: command, args, env and url come from the origin and cannot be edited here; edit the origin file or unlink in the app",
  };
}
