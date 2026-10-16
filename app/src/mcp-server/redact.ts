import type { McpServerConfig } from "../config/types.js";
import type { McpServerEntry, McpVinculo } from "../services/mcp-service.js";
import { limparSegredos, ocultarCredencialDeUrl } from "../pacote/limpeza.js";
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
 * O segredo é do programa a que foi cadastrado, e por isso só volta se o resto
 * do comando (tudo fora das posições ocultas) for o que já estava. Argumento
 * oculto sem original recusa, porque cortá-lo deslocaria os outros.
 */
export function restoreCommand(atual: string[] | undefined, novo: string[]): string[] {
  if (!novo.some((arg) => arg.includes(HIDDEN_VALUE))) return novo;
  const mascarado = atual === undefined ? [] : comandoOculto(atual);
  const mesmoDestino =
    atual !== undefined && atual.length === novo.length && novo.every((arg, i) => arg.includes(HIDDEN_VALUE) || arg === atual[i]);
  return novo.map((arg, i) => {
    if (!arg.includes(HIDDEN_VALUE)) return arg;
    if (mesmoDestino && mascarado[i] === arg) return atual![i]!;
    throw new Error(
      atual === undefined || mesmoDestino
        ? `o argumento ${i} do comando veio oculto (${HIDDEN_VALUE}) e não há valor anterior na mesma posição; informe o valor`
        : `o comando mudou e o argumento ${i} veio oculto (${HIDDEN_VALUE}): o valor guardado não vai para outro comando; informe o valor`,
    );
  });
}

function origemDe(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Para onde o passo manda o que tem: a ação, a origem da url, o server e o comando. */
function destinoDoPasso(passo: unknown, params: Record<string, unknown>): string {
  const p = passo as { type?: unknown; action?: unknown };
  return JSON.stringify([p.type ?? null, p.action ?? null, typeof params.url === "string" ? origemDe(params.url) : null, params.server ?? null, params.command ?? null]);
}

/** A url de um passo com o que é credencial (usuário, senha, token na query, webhook) oculto. */
export function mascararUrl(url: string): string {
  const usuario = /^([a-z][a-z0-9+.-]*:\/\/)[^\s/@?#]*@/i.exec(url);
  const resto = usuario === null ? url : usuario[1] + url.slice(usuario[0].length);
  const limpa = ocultarCredencialDeUrl(resto, HIDDEN_VALUE);
  return usuario === null ? limpa : limpa.replace(usuario[1]!, `${usuario[1]}${HIDDEN_VALUE}@`);
}

/** Recusa o que sobrou de `<oculto>` fora de onde ele sabe voltar: texto livre gravado com o marcador seria texto mutilado. */
function recusarOculto(valor: unknown, caminho: string): void {
  if (typeof valor === "string") {
    if (valor.includes(HIDDEN_VALUE)) {
      throw new Error(`${caminho} traz o marcador ${HIDDEN_VALUE}, que só vale em header, env, comando e url de passo; escreva o texto de verdade`);
    }
  } else if (Array.isArray(valor)) valor.forEach((x, i) => recusarOculto(x, `${caminho}[${i}]`));
  else if (typeof valor === "object" && valor !== null) {
    for (const [k, x] of Object.entries(valor)) recusarOculto(x, `${caminho}.${k}`);
  }
}

/**
 * Um spec de volta, com o que estava oculto nos `headers` e no `env` dos
 * passos devolvido pelo passo de mesma chave da versão anterior. O que não tem
 * original cai fora, e `semValor` diz quais para a pessoa preencher.
 */
export function restoreSpec<T>(atual: unknown, novo: T): { spec: T; semValor: string[] } {
  const semValor: string[] = [];
  const passos = (novo as { steps?: unknown }).steps;
  if (!Array.isArray(passos)) {
    recusarOculto(novo, "o spec");
    return { spec: novo, semValor };
  }
  const anteriores = new Map<string, { passo: unknown; params: Record<string, unknown> }>();
  for (const p of ((atual as { steps?: unknown } | undefined)?.steps as unknown[] | undefined) ?? []) {
    const chave = (p as { key?: unknown }).key;
    if (typeof chave === "string") anteriores.set(chave, { passo: p, params: ((p as { params?: Record<string, unknown> }).params ?? {}) as Record<string, unknown> });
  }
  const steps = passos.map((passo) => {
    const params = (passo as { params?: unknown } | null)?.params;
    if (typeof params !== "object" || params === null) return passo;
    const chavePasso = String((passo as { key?: unknown }).key);
    const anterior = anteriores.get(chavePasso);
    // O valor guardado é do destino a que foi cadastrado: com outro destino não volta.
    const antes = anterior !== undefined && destinoDoPasso(anterior.passo, anterior.params) === destinoDoPasso(passo, params as Record<string, unknown>) ? anterior.params : undefined;
    const restaurados: Record<string, unknown> = { ...(params as Record<string, unknown>) };
    for (const campo of ["headers", "env"]) {
      const valores = restaurados[campo];
      if (typeof valores !== "object" || valores === null) continue;
      const refeito = restoreHidden(antes?.[campo] as Record<string, string> | undefined, valores as Record<string, string>) ?? {};
      for (const chave of Object.keys(valores)) {
        if ((valores as Record<string, string>)[chave] === HIDDEN_VALUE && refeito[chave] === undefined) {
          semValor.push(`${chavePasso}.${campo}.${chave}`);
        }
      }
      restaurados[campo] = refeito;
    }
    const url = restaurados.url;
    if (typeof url === "string" && url.includes(HIDDEN_VALUE)) {
      const guardada = antes?.url;
      if (typeof guardada !== "string" || mascararUrl(guardada) !== url) {
        throw new Error(`a url do passo ${chavePasso} veio com valor oculto (${HIDDEN_VALUE}) que não bate com a url cadastrada na mesma origem; informe a url completa`);
      }
      restaurados.url = guardada;
    }
    return { ...(passo as object), params: restaurados };
  });
  const spec = { ...(novo as object), steps } as T;
  recusarOculto(spec, "o spec");
  return { spec, semValor };
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

/**
 * Os valores guardados no cofre, para tirar da saída quem os repetir. Curto
 * demais não é segredo, é palavra. O que o OAuth guarda leva o esquema
 * (`Bearer x`), e o token aparece sozinho em erro e em log: sai das duas formas.
 *
 * Com segredo guardado e sem keychain neste processo, não há como saber o que
 * esconder, e a leitura falha em vez de devolver o que talvez seja segredo.
 */
function valoresDoCofre(): string[] {
  const refs = secretService.list();
  if (refs.length > 0 && !secretService.available) {
    throw new Error("o cofre tem segredos e o keychain não está disponível neste processo, então a saída não pode ser conferida; abra o Locum pelo aplicativo");
  }
  const valores = new Set<string>();
  for (const ref of refs) {
    const valor = secretService.get(ref);
    if (valor === undefined) continue;
    for (const v of [valor, valor.replace(/^(?:Bearer|Basic|Digest|Token)\s+/i, "")]) if (v.length >= 8) valores.add(v);
  }
  return [...valores].sort((a, b) => b.length - a.length);
}

/** Campos de leitura que nunca voltam numa escrita: texto de fora (erro de API, saída de passo) que pode trazer token colado. */
function ehLeituraSuja(chave: string, pai: Record<string, unknown>): boolean {
  return chave === "error" || chave === "lastError" || (chave === "output" && typeof pai.stepKey === "string");
}

/**
 * Passa pelo valor inteiro, em profundidade, antes de ele sair numa ferramenta:
 * esconde o que é segredo de verdade, e nada além disso.
 *
 * - o valor que está no cofre, onde quer que apareça;
 * - o valor literal de `env` e `headers`, o argumento de comando que segue
 *   uma opção de credencial, e a credencial da `url` de passo http;
 *   referência e template ficam;
 * - nos campos que só se leem (erro, saída de passo), a heurística de segredo.
 *
 * Texto livre (prompt, achado, instrução, conversa) passa inteiro: o ciclo ler,
 * editar e gravar de volta não pode gravar texto mutilado por heurística.
 */
export function redactSecrets<T>(valor: T): T {
  const cofre = valoresDoCofre();
  const passar = (v: unknown, chave?: string, limpar = false): unknown => {
    if (typeof v === "string") return cofre.reduce((texto, segredo) => texto.split(segredo).join(HIDDEN_VALUE), limpar ? limparSegredos(v) : v);
    if (Array.isArray(v)) {
      const itens = chave === "command" && v.every((x) => typeof x === "string") ? comandoOculto(v as string[]) : v;
      return itens.map((x) => passar(x, undefined, limpar));
    }
    if (typeof v === "object" && v !== null) {
      const objeto = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(objeto).map(([k, x]) => {
          if ((k === "env" || k === "headers") && mapaDeTexto(x)) return [k, passar(ocultar(x, k === "headers"))];
          if (k === "params" && objeto.action === "http.request" && typeof x === "object" && x !== null && typeof (x as { url?: unknown }).url === "string") {
            return [k, passar({ ...x, url: mascararUrl((x as { url: string }).url) })];
          }
          return [k, passar(x, k, limpar || ehLeituraSuja(k, objeto))];
        }),
      );
    }
    return v;
  };
  return passar(valor) as T;
}
