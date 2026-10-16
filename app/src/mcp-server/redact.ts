import type { McpServerConfig } from "../config/types.js";
import type { McpServerEntry, McpVinculo } from "../services/mcp-service.js";
import { mascararArgs } from "../services/mcp-origem.js";
import { CREDENTIAL_PLACEHOLDER, secretService } from "../services/secret-service.js";

/**
 * O que aparece no lugar de um valor secreto na saída das ferramentas.
 *
 * Quem cadastra um token direto no `env` ou nos `headers`, sem passar pelo
 * cofre, não espera vê-lo na conversa de um modelo que só listou os servidores.
 * Referência não é segredo e sai como está: o marcador `${credential}`, o
 * `${VAR}` de uma origem e o template `{{steps.x.campo}}` de um passo.
 */
export const HIDDEN_VALUE = "<oculto>";

const REFERENCIA = /\{\{[^}]*\}\}|\$\{[^}]*\}/g;
const TEM_REFERENCIA = /\{\{[^}]*\}\}|\$\{[^}]*\}/;
const ESQUEMA_DE_AUTORIZACAO = /\b(?:Bearer|Basic|Digest|Token)\b/gi;

/** Valor feito só de referência (e do esquema de autorização, como `Bearer {{x}}`): não há literal a esconder. */
function ehReferencia(valor: string): boolean {
  return TEM_REFERENCIA.test(valor) && valor.replace(REFERENCIA, "").replace(ESQUEMA_DE_AUTORIZACAO, "").trim() === "";
}

/** Cabeçalho que nunca carrega credencial: sai como está, para o dado voltar igual. */
const CABECALHO_COMUM = new Set(["content-type", "accept", "accept-language", "accept-encoding", "user-agent", "content-length", "cache-control"]);

function ocultar(valores: Record<string, string>, comoCabecalho: boolean): Record<string, string> {
  return Object.fromEntries(
    Object.entries(valores).map(([chave, valor]) => {
      const comum = comoCabecalho && CABECALHO_COMUM.has(chave.toLowerCase()) && !/^(?:Bearer|Basic|Digest|Token)\s/i.test(valor);
      return [chave, valor === CREDENTIAL_PLACEHOLDER || ehReferencia(valor) || comum ? valor : HIDDEN_VALUE];
    }),
  );
}

/** O comando de um servidor com o valor dos argumentos secretos (`--api-key x`) oculto. */
function comandoOculto(command: string[]): string[] {
  return command.length === 0 ? command : [command[0]!, ...mascararArgs(command.slice(1))];
}

export function redactServerConfig<T extends McpServerConfig>(config: T): T {
  return {
    ...config,
    ...(config.command !== undefined ? { command: comandoOculto(config.command) } : {}),
    ...(config.env !== undefined ? { env: ocultar(config.env, false) } : {}),
    ...(config.headers !== undefined ? { headers: ocultar(config.headers, true) } : {}),
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
 * O comando de volta com o que estava oculto no lugar de cada argumento: onde
 * o novo é o mascarado do que já estava na mesma posição, vale o original.
 * Argumento oculto sem original recusa, porque cortá-lo deslocaria os outros.
 */
export function restoreCommand(atual: string[] | undefined, novo: string[]): string[] {
  const mascarado = atual === undefined ? [] : comandoOculto(atual);
  return novo.map((arg, i) => {
    if (!arg.includes(HIDDEN_VALUE)) return arg;
    if (atual !== undefined && mascarado[i] === arg && atual[i] !== undefined) return atual[i]!;
    throw new Error(`o argumento ${i} do comando veio oculto (${HIDDEN_VALUE}) e não há valor anterior na mesma posição; informe o valor`);
  });
}

/**
 * Um spec de volta, com o que estava oculto nos `headers` e no `env` dos
 * passos devolvido pelo passo de mesma chave da versão anterior. O que não tem
 * original cai fora, e `semValor` diz quais para a pessoa preencher.
 */
export function restoreSpec<T>(atual: unknown, novo: T): { spec: T; semValor: string[] } {
  const semValor: string[] = [];
  const passos = (novo as { steps?: unknown }).steps;
  if (!Array.isArray(passos)) return { spec: novo, semValor };
  const anteriores = new Map<string, Record<string, unknown>>();
  for (const p of ((atual as { steps?: unknown } | undefined)?.steps as unknown[] | undefined) ?? []) {
    const chave = (p as { key?: unknown }).key;
    if (typeof chave === "string") anteriores.set(chave, ((p as { params?: Record<string, unknown> }).params ?? {}) as Record<string, unknown>);
  }
  const steps = passos.map((passo) => {
    const params = (passo as { params?: unknown } | null)?.params;
    if (typeof params !== "object" || params === null) return passo;
    const antes = anteriores.get(String((passo as { key?: unknown }).key));
    const restaurados: Record<string, unknown> = { ...(params as Record<string, unknown>) };
    for (const campo of ["headers", "env"]) {
      const valores = restaurados[campo];
      if (typeof valores !== "object" || valores === null) continue;
      const refeito = restoreHidden(antes?.[campo] as Record<string, string> | undefined, valores as Record<string, string>) ?? {};
      for (const chave of Object.keys(valores)) {
        if ((valores as Record<string, string>)[chave] === HIDDEN_VALUE && refeito[chave] === undefined) {
          semValor.push(`${String((passo as { key?: unknown }).key)}.${campo}.${chave}`);
        }
      }
      restaurados[campo] = refeito;
    }
    return { ...(passo as object), params: restaurados };
  });
  return { spec: { ...(novo as object), steps } as T, semValor };
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

function mapaDeTexto(v: unknown): v is Record<string, string> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
}

/** Os valores guardados no cofre, para tirar da saída quem os repetir. Curto demais não é segredo, é palavra. */
function valoresDoCofre(): string[] {
  const valores: string[] = [];
  for (const ref of secretService.list()) {
    const valor = secretService.get(ref);
    if (valor !== undefined && valor.length >= 8) valores.push(valor);
  }
  return valores.sort((a, b) => b.length - a.length);
}

/**
 * Passa pelo valor inteiro, em profundidade, antes de ele sair numa ferramenta:
 * esconde o que é segredo de verdade, e nada além disso.
 *
 * - o valor que está no cofre, onde quer que apareça;
 * - o valor literal de `env` e `headers`, e o argumento de comando que segue
 *   uma opção de credencial; referência e template ficam.
 *
 * Texto livre (prompt, achado, instrução, conversa) passa inteiro: o ciclo ler,
 * editar e gravar de volta não pode gravar texto mutilado por heurística.
 */
export function redactSecrets<T>(valor: T): T {
  const cofre = valoresDoCofre();
  const passar = (v: unknown, chave?: string): unknown => {
    if (typeof v === "string") return cofre.reduce((texto, segredo) => texto.split(segredo).join(HIDDEN_VALUE), v);
    if (Array.isArray(v)) {
      const itens = chave === "command" && v.every((x) => typeof x === "string") ? comandoOculto(v as string[]) : v;
      return itens.map((x) => passar(x));
    }
    if (typeof v === "object" && v !== null) {
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [
          k,
          (k === "env" || k === "headers") && mapaDeTexto(x) ? passar(ocultar(x, k === "headers")) : passar(x, k),
        ]),
      );
    }
    return v;
  };
  return passar(valor) as T;
}
