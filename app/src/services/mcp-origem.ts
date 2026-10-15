import { execFile } from "node:child_process";
import nodeCrypto from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// A build ESM: a UMD, que é o "main" do pacote, não passa pelo esbuild.
import { parse, type ParseError } from "jsonc-parser/lib/esm/main.js";
import type { McpServerInput, McpSource } from "../config/types.js";
import type { PreRegisteredClient } from "./mcp-oauth-service.js";
import { CREDENTIAL_PLACEHOLDER } from "./secret-service.js";

/**
 * Leitura dos servidores MCP que a pessoa já configurou nas ferramentas desta
 * máquina: o Claude Code (os de usuário, em `~/.claude.json`, e os dos plugins
 * ligados), o opencode, o Cursor, o VS Code e o Claude Desktop. Cada uma tem
 * seu formato, e todas são lidas para o formato do Claude Code. Fica separado
 * da importação porque o cadastro também lê a origem na hora de conectar.
 */

export interface Candidato {
  name: string;
  /**
   * "usuário" para o Claude Code, o plugin de onde veio (como `akad@akad`), ou
   * o nome da outra ferramenta (`ORIGENS`).
   */
  origem: string;
  transport: "stdio" | "http" | "sse";
  /** Resumo para a tela: comando ou endereço, sem segredo. */
  destino: string;
  /** Variável que não se resolveu: o servidor entra, mas sem ela não conecta. */
  faltando: string[];
  /** http sem cabeçalho: a autorização sai pelo OAuth do Locum depois de importar. */
  oauth: boolean;
  jaCadastrado: boolean;
}

/** O que se grava; fica fora do que vai para a tela por carregar segredo. */
export interface Preparado extends Candidato {
  config: McpServerInput;
  segredo?: string;
  /** Variáveis que a origem cita e esta máquina não resolveu (sem o segredo descartado). */
  semValor: string[];
  /** App OAuth que o plugin declara, para autorizar sem registro automático. */
  cliente?: PreRegisteredClient;
}

export interface Entrada {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Como o Claude Code declara app OAuth já cadastrado no serviço. */
  oauth?: { clientId?: string; callbackPort?: number; scopes?: string[] | string };
}

/** Palavras que, num nome de variável ou cabeçalho, dizem que o valor é segredo. */
const PALAVRAS_DE_SEGREDO = new Set(["key", "apikey", "token", "secret", "password", "passwd", "pwd", "bearer", "cookie", "credential", "credentials", "authorization", "auth"]);
/** Palavras que dizem que o valor é um endereço, um nome ou uma lista, mesmo ao lado de "token" ou "auth". */
const PALAVRAS_DE_NAO_SEGREDO = new Set(["url", "uri", "host", "endpoint", "scope", "scopes", "file", "path", "dir", "name", "id", "type", "mode", "port", "domain", "realm", "authority", "server", "issuer"]);

/**
 * O nome pede cofre? Vale por palavra inteira (`MINHA_API_KEY`, `x-api-key`,
 * `clientSecret`), e não por trecho: `KEYCLOAK_URL`, `OAUTH_TOKEN_URL`,
 * `AUTH_SERVER_URL` e `*_OAUTH_SCOPES` são configuração, e comparam como tal.
 */
export function ehChaveDeSegredo(chave: string): boolean {
  const palavras = chave
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((p) => p !== "");
  if (palavras.some((p) => PALAVRAS_DE_NAO_SEGREDO.has(p))) return false;
  return palavras.some((p) => PALAVRAS_DE_SEGREDO.has(p)) || (palavras.includes("api") && palavras.includes("key"));
}

/** Endereço sem credencial embutida: nunca é o segredo, mesmo numa chave que pareça. */
function ehEndereco(valor: string): boolean {
  try {
    const u = new URL(valor);
    return (u.protocol === "http:" || u.protocol === "https:") && u.username === "" && u.password === "";
  } catch {
    return false;
  }
}
const VARIAVEL = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export function lerJson(caminho: string): unknown {
  try {
    return JSON.parse(readFileSync(caminho, "utf8"));
  } catch {
    return undefined;
  }
}

export function comoObjeto(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** JSON com comentário e vírgula sobrando, como o opencode e o VS Code aceitam. */
function lerJsonc(caminho: string): unknown {
  let texto: string;
  try {
    texto = readFileSync(caminho, "utf8");
  } catch {
    return undefined;
  }
  const erros: ParseError[] = [];
  const valor = parse(texto, erros, { allowTrailingComma: true }) as unknown;
  return erros.length === 0 ? valor : undefined;
}

/** O nome que a tela mostra para cada ferramenta além do Claude Code. */
export const ORIGENS = {
  opencode: "opencode",
  cursor: "Cursor",
  vscode: "VS Code",
  claudeDesktop: "Claude Desktop",
} as const;

/**
 * Uma origem lida: de onde, a pasta do plugin (só plugin), o arquivo que
 * declara os servidores e os servidores.
 */
export interface Fonte {
  origem: string;
  raiz?: string;
  arquivo?: string;
  servidores: Record<string, Entrada>;
}

/** A origem estruturada de um servidor, a partir da fonte onde ele foi lido. */
export function origemEstruturada(fonte: Fonte, server: string): McpSource {
  if (fonte.origem === "usuário") return { kind: "claude-user", server };
  const arroba = fonte.origem.indexOf("@");
  if (arroba > 0) {
    return { kind: "claude-plugin", plugin: fonte.origem.slice(0, arroba), marketplace: fonte.origem.slice(arroba + 1), server };
  }
  const kind = (Object.entries(ORIGENS).find(([, nome]) => nome === fonte.origem)?.[0] ?? "claudeDesktop") as keyof typeof ORIGENS;
  return { kind: { opencode: "opencode", cursor: "cursor", vscode: "vscode", claudeDesktop: "claude-desktop" }[kind], server } as McpSource;
}

/** O nome curto da origem, o mesmo que a lista de importação mostra. */
export function rotuloDaOrigem(source: McpSource): string {
  switch (source.kind) {
    case "claude-user":
      return "usuário";
    case "claude-plugin":
      return `${source.plugin}@${source.marketplace}`;
    case "opencode":
      return ORIGENS.opencode;
    case "cursor":
      return ORIGENS.cursor;
    case "vscode":
      return ORIGENS.vscode;
    case "claude-desktop":
      return ORIGENS.claudeDesktop;
  }
}

/**
 * Variável escrita do jeito de cada ferramenta (`${env:X}` no Cursor e no VS
 * Code, `{env:X}` no opencode, `${input:X}` no VS Code) vira `${X}`, que é o
 * que o `preparar` resolve. O `input` do VS Code é perguntado na hora pela
 * própria ferramenta; aqui ele só se resolve se houver variável com o nome, e
 * senão aparece como faltando.
 */
export function variavelDoClaude(texto: string): string {
  return texto
    .replace(/\$\{(?:env|input):([A-Za-z_][A-Za-z0-9_.-]*)\}/g, (_t, nome: string) => `\${${nome.replace(/[.-]/g, "_")}}`)
    .replace(/(?<!\$)\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_t, nome: string) => `\${${nome}}`);
}

function textos(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map(variavelDoClaude) : undefined;
}

function registro(v: unknown): Record<string, string> | undefined {
  const o = comoObjeto(v);
  const pares = Object.entries(o).filter((p): p is [string, string] => typeof p[1] === "string");
  return pares.length === 0 ? undefined : Object.fromEntries(pares.map(([k, x]) => [k, variavelDoClaude(x)]));
}

/** Servidor no formato do Claude Code (Cursor, VS Code, Claude Desktop), com a variável traduzida. */
function entradaParecida(v: unknown): Entrada | undefined {
  const o = comoObjeto(v);
  const url = typeof o.url === "string" ? variavelDoClaude(o.url) : undefined;
  const command = typeof o.command === "string" ? variavelDoClaude(o.command) : undefined;
  if (url === undefined && command === undefined) return undefined;
  const args = textos(o.args);
  const env = registro(o.env);
  const headers = registro(o.headers);
  return {
    ...(typeof o.type === "string" ? { type: o.type } : {}),
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    ...(env === undefined ? {} : { env }),
    ...(url === undefined ? {} : { url }),
    ...(headers === undefined ? {} : { headers }),
  };
}

function servidoresParecidos(v: unknown): Record<string, Entrada> {
  const out: Record<string, Entrada> = {};
  for (const [nome, bruto] of Object.entries(comoObjeto(v))) {
    const entrada = entradaParecida(bruto);
    if (entrada !== undefined) out[nome] = entrada;
  }
  return out;
}

/**
 * O `mcp` do opencode: `local` com o comando inteiro numa lista e o ambiente
 * em `environment`, `remote` com `url` e `headers`. Os dois arquivos globais
 * entram, `.json` e `.jsonc`, e o primeiro ganha no nome repetido.
 */
export function servidoresDoOpencode(home: string): Record<string, Entrada> {
  const out: Record<string, Entrada> = {};
  for (const arquivo of ["opencode.json", "opencode.jsonc"]) {
    for (const [nome, bruto] of Object.entries(comoObjeto(comoObjeto(lerJsonc(join(home, ".config", "opencode", arquivo))).mcp))) {
      if (nome in out) continue;
      const o = comoObjeto(bruto);
      if (o.type === "remote" && typeof o.url === "string") {
        const headers = registro(o.headers);
        out[nome] = { type: "http", url: variavelDoClaude(o.url), ...(headers === undefined ? {} : { headers }) };
      } else if (o.type === "local") {
        const comando = textos(o.command) ?? [];
        if (comando.length === 0) continue;
        const env = registro(o.environment);
        out[nome] = { command: comando[0]!, args: comando.slice(1), ...(env === undefined ? {} : { env }) };
      }
    }
  }
  return out;
}

/** A pasta de configuração de um app de desktop: `Application Support` no Mac, `.config` no resto. */
function pastaDoApp(home: string, app: string): string {
  return process.platform === "darwin" ? join(home, "Library", "Application Support", app) : join(home, ".config", app);
}

/** O VS Code guarda em `mcp.json` (`servers`) e, nas versões antigas, em `settings.json` (`mcp.servers`). */
export function servidoresDoVscode(home: string): Record<string, Entrada> {
  const usuario = join(pastaDoApp(home, "Code"), "User");
  const antigos = comoObjeto(comoObjeto(lerJsonc(join(usuario, "settings.json")))["mcp"]).servers;
  return { ...servidoresParecidos(antigos), ...servidoresParecidos(comoObjeto(lerJsonc(join(usuario, "mcp.json"))).servers) };
}

/**
 * Todas as origens, na ordem em que o nome repetido se resolve: o Claude Code
 * primeiro, porque é de onde a importação nasceu e o plugin traz o app OAuth;
 * depois as outras ferramentas.
 */
export function fontes(home: string): Fonte[] {
  const candidatas: Fonte[] = [
    {
      origem: "usuário",
      arquivo: join(home, ".claude.json"),
      servidores: comoObjeto(comoObjeto(lerJsonCacheado(join(home, ".claude.json"))).mcpServers) as Record<string, Entrada>,
    },
    ...servidoresDosPlugins(home),
    {
      origem: ORIGENS.opencode,
      arquivo: join(home, ".config", "opencode", existsSync(join(home, ".config", "opencode", "opencode.json")) ? "opencode.json" : "opencode.jsonc"),
      servidores: servidoresDoOpencode(home),
    },
    {
      origem: ORIGENS.cursor,
      arquivo: join(home, ".cursor", "mcp.json"),
      servidores: servidoresParecidos(comoObjeto(lerJson(join(home, ".cursor", "mcp.json"))).mcpServers),
    },
    {
      origem: ORIGENS.vscode,
      arquivo: join(pastaDoApp(home, "Code"), "User", existsSync(join(pastaDoApp(home, "Code"), "User", "mcp.json")) ? "mcp.json" : "settings.json"),
      servidores: servidoresDoVscode(home),
    },
    {
      origem: ORIGENS.claudeDesktop,
      arquivo: join(pastaDoApp(home, "Claude"), "claude_desktop_config.json"),
      servidores: servidoresParecidos(comoObjeto(lerJson(join(pastaDoApp(home, "Claude"), "claude_desktop_config.json"))).mcpServers),
    },
  ];
  return candidatas.filter((f) => Object.keys(f.servidores).length > 0);
}

/** Servidores declarados pelos plugins ligados, com a pasta de cada plugin. */
export function servidoresDosPlugins(home: string): (Fonte & { raiz: string })[] {
  const ajustes = comoObjeto(lerJson(join(home, ".claude", "settings.json")));
  const ligados = comoObjeto(ajustes.enabledPlugins);
  const instalados = comoObjeto(comoObjeto(lerJson(join(home, ".claude", "plugins", "installed_plugins.json"))).plugins);

  const saida: (Fonte & { raiz: string })[] = [];
  for (const [origem, registro] of Object.entries(instalados)) {
    if (ligados[origem] !== true) continue;
    // O Claude Code guarda uma entrada por escopo; a de usuário é a que vale
    // em toda pasta, e na falta dela a primeira.
    const entradas = Array.isArray(registro) ? registro : [registro];
    const primeiro = comoObjeto(entradas.find((e) => comoObjeto(e).scope === "user") ?? entradas[0]);
    const raiz = typeof primeiro.installPath === "string" ? primeiro.installPath : undefined;
    if (raiz === undefined || !existsSync(raiz)) continue;

    const arquivoDoManifesto = join(raiz, ".claude-plugin", "plugin.json");
    const manifesto = comoObjeto(lerJson(arquivoDoManifesto));
    let declarado: unknown = manifesto.mcpServers;
    let arquivo = arquivoDoManifesto;
    if (typeof declarado === "string") {
      arquivo = join(raiz, declarado);
      declarado = lerJson(arquivo);
    }
    if (declarado === undefined) {
      arquivo = join(raiz, ".mcp.json");
      declarado = lerJson(arquivo);
    }
    const objeto = comoObjeto(declarado);
    const servidores = comoObjeto(objeto.mcpServers ?? objeto) as Record<string, Entrada>;
    if (Object.keys(servidores).length > 0) saida.push({ origem, raiz, arquivo, servidores });
  }
  return saida;
}

/** Nomes de variável citados num servidor, fora o `CLAUDE_PLUGIN_ROOT`. */
export function variaveisCitadas(entrada: Entrada): string[] {
  const textos = [entrada.command ?? "", entrada.url ?? "", ...(entrada.args ?? []), ...Object.values(entrada.env ?? {}), ...Object.values(entrada.headers ?? {})];
  const nomes = new Set<string>();
  for (const texto of textos) for (const m of texto.matchAll(VARIAVEL)) if (m[1] !== "CLAUDE_PLUGIN_ROOT") nomes.add(m[1]!);
  return [...nomes];
}

/** O app OAuth que o Claude Code declara para o servidor (`oauth.clientId` e `callbackPort`). */
export function clienteDeclarado(entrada: Entrada): PreRegisteredClient | undefined {
  const declarado = entrada.oauth;
  if (typeof declarado?.clientId !== "string" || typeof declarado.callbackPort !== "number") return undefined;
  return {
    clientId: declarado.clientId,
    redirectUri: `http://localhost:${declarado.callbackPort}/callback`,
    ...(declarado.scopes === undefined
      ? {}
      : { scope: Array.isArray(declarado.scopes) ? declarado.scopes.join(" ") : declarado.scopes }),
  };
}

/**
 * Monta o cadastro do Locum a partir do que o Claude Code declara.
 *
 * Valor com cara de segredo, em `env` ou `headers`, vai para o cofre: o
 * cadastro fica com `${credential}` no lugar. O Locum guarda uma credencial
 * por servidor, então o segundo segredo do mesmo servidor fica como faltando.
 */
export function preparar(
  name: string,
  origem: string,
  entrada: Entrada,
  raiz: string | undefined,
  ambiente: Record<string, string>,
  cadastrados: ReadonlySet<string>,
): Preparado {
  const faltando = new Set<string>();
  const semValor = new Set<string>();
  const expandir = (texto: string): string =>
    texto.replace(VARIAVEL, (inteiro, nome: string, padrao: string | undefined) => {
      if (nome === "CLAUDE_PLUGIN_ROOT" && raiz !== undefined) return raiz;
      const valor = ambiente[nome] ?? padrao;
      if (valor === undefined) {
        faltando.add(nome);
        semValor.add(nome);
        return inteiro;
      }
      return valor;
    });

  let segredo: string | undefined;
  const separar = (registro: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (registro === undefined) return undefined;
    const out: Record<string, string> = {};
    for (const [chave, bruto] of Object.entries(registro)) {
      const valor = expandir(bruto);
      if (!ehChaveDeSegredo(chave) || valor.length === 0 || valor.includes("${") || ehEndereco(valor)) {
        out[chave] = valor;
      } else if (segredo === undefined) {
        segredo = valor;
        out[chave] = CREDENTIAL_PLACEHOLDER;
      } else {
        faltando.add(chave);
      }
    }
    return out;
  };

  const transport = entrada.type === "http" || entrada.type === "sse" ? entrada.type : entrada.url !== undefined ? "http" : "stdio";
  const env = separar(entrada.env);
  const headers = separar(entrada.headers);
  const config: McpServerInput =
    transport === "stdio"
      ? { name, transport, command: [expandir(entrada.command ?? ""), ...(entrada.args ?? []).map(expandir)], ...(env ? { env } : {}), scope: "write" }
      : { name, transport, url: expandir(entrada.url ?? ""), ...(headers ? { headers } : {}), scope: "write" };

  const cliente = transport === "stdio" ? undefined : clienteDeclarado(entrada);

  return {
    name,
    origem,
    transport,
    destino: transport === "stdio" ? (config.command ?? []).join(" ").replace(raiz ?? "\u0000", "<plugin>") : (config.url ?? ""),
    faltando: [...faltando],
    semValor: [...semValor],
    oauth: transport !== "stdio" && Object.keys(entrada.headers ?? {}).length === 0,
    jaCadastrado: cadastrados.has(name),
    config,
    ...(segredo === undefined ? {} : { segredo }),
    ...(cliente === undefined ? {} : { cliente }),
  };
}


/* ------------------------------------------------------------- resolução */

/** O que a origem diz hoje de um servidor, pronto para o cadastro. */
export interface Resolvido {
  /** Comando, args, url, env e headers, com o segredo no lugar do marcador. */
  config: McpServerInput;
  /** O segredo que a origem traz literal, para o cofre ou para a conexão. */
  segredo?: string;
  cliente?: PreRegisteredClient;
  faltando: string[];
  /**
   * A origem cita variável que esta máquina não resolveu agora (o shell de
   * login pode ter falhado ou estourado o tempo). Não se aceita assim: o
   * `${X}` literal não é a configuração que a pessoa quis.
   */
  incompleto: boolean;
  /** Pasta do plugin na versão instalada e ligada agora. */
  raiz?: string;
  /** O arquivo que declara o servidor, para "editar na origem". */
  arquivo?: string;
  /** Impressão da configuração, igual enquanto só a versão do plugin muda. */
  hash: string;
}

export interface OrigemDeps {
  home: string;
  /** Variáveis do shell de login, que o app aberto pelo Finder não herda. */
  ambiente: (nomes: string[]) => Promise<Record<string, string>>;
  /** Quanto vale o que se leu da origem; o uso seguido não relê arquivo. */
  ttlMs?: number;
  agora?: () => number;
}

const TTL_PADRAO_MS = 5_000;
const TTL_DO_AMBIENTE_MS = 60_000;
export const RAIZ_DO_PLUGIN = "${CLAUDE_PLUGIN_ROOT}";

function escapar(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Troca a pasta do plugin, em qualquer versão, pelo marcador. É o que faz a
 * versão nova do mesmo plugin dar a mesma impressão, e o que deixa uma cópia
 * antiga, com o caminho de uma versão que já saiu, ser comparada com a origem.
 */
export function semVersaoDoPlugin(texto: string, source: McpSource | undefined, raiz: string | undefined): string {
  let saida = texto;
  if (source?.kind === "claude-plugin") {
    const cache = new RegExp(`[^\\s"']*?/plugins/cache/${escapar(source.marketplace)}/${escapar(source.plugin)}/[^/\\s"']+`, "g");
    saida = saida.replace(cache, RAIZ_DO_PLUGIN);
  }
  return raiz === undefined ? saida : saida.split(raiz).join(RAIZ_DO_PLUGIN);
}

function ordenado(registro: Record<string, string> | undefined): [string, string][] | null {
  return registro === undefined ? null : Object.entries(registro).sort(([a], [b]) => a.localeCompare(b));
}

/**
 * A configuração que importa para dizer "mudou": o que sobe o processo ou abre
 * a conexão. Fora dela só ficam o valor que foi para o cofre e o marcador de
 * credencial do Locum, que aparecem como `<segredo>`; todo o resto compara,
 * inclusive endereço e escopo.
 */
function essencial(config: McpServerInput, source: McpSource | undefined, raiz: string | undefined) {
  const limpo = (t: string): string => semVersaoDoPlugin(t, source, raiz);
  const valor = (v: string): string => (v === CREDENTIAL_PLACEHOLDER ? "<segredo>" : limpo(v));
  return {
    transport: config.transport,
    command: config.command?.map(limpo) ?? null,
    url: config.url === undefined ? null : limpo(config.url),
    env: ordenado(config.env)?.map(([k, v]) => [k, valor(v)]) ?? null,
    headers: ordenado(config.headers)?.map(([k, v]) => [k, valor(v)]) ?? null,
  };
}

/** Impressão da configuração, sem o que é do Locum nem a versão do plugin. */
export function impressao(config: McpServerInput, source?: McpSource, raiz?: string): string {
  return nodeCrypto.createHash("sha256").update(JSON.stringify(essencial(config, source, raiz))).digest("hex").slice(0, 16);
}

/**
 * Tira da cópia o marcador de credencial que o Locum pôs (o OAuth, por
 * exemplo) onde a origem não tem a chave: isso é do Locum, e não conta na
 * impressão da cópia.
 */
export function semMarcadorDoLocum(copia: McpServerInput, origem: McpServerInput): McpServerInput {
  const filtrar = (c: Record<string, string> | undefined, o: Record<string, string> | undefined) => {
    if (c === undefined) return undefined;
    const saida = Object.fromEntries(Object.entries(c).filter(([k, v]) => !(v === CREDENTIAL_PLACEHOLDER && o?.[k] === undefined)));
    return Object.keys(saida).length === 0 ? undefined : saida;
  };
  const { env: _e, headers: _h, ...resto } = copia;
  const env = filtrar(copia.env, origem.env);
  const headers = filtrar(copia.headers, origem.headers);
  return { ...resto, ...(env === undefined ? {} : { env }), ...(headers === undefined ? {} : { headers }) };
}

/** Uma diferença entre a configuração aceita e a da origem, com segredo mascarado. */
export interface Mudanca {
  campo: "transport" | "command" | "args" | "url" | "env" | "headers";
  /** Nome da variável ou do cabeçalho, quando o campo é um mapa. */
  chave?: string;
  antes: string | null;
  depois: string | null;
  /** O valor mudou, mas é protegido: os dois lados saem mascarados e iguais. */
  protegido?: boolean;
}

export const VALOR_OCULTO = "<oculto>";

/** Este valor, nesta chave, é segredo de fato (e não endereço, escopo ou variável por resolver)? */
function ehSegredoDeFato(chave: string, valor: string): boolean {
  return ehChaveDeSegredo(chave) && valor.length > 0 && valor !== CREDENTIAL_PLACEHOLDER && !valor.includes("${") && !ehEndereco(valor);
}

/** Valor de `env` ou `headers`: o que parece segredo não sai daqui. */
function mascarar(chave: string, valor: string): string {
  return ehSegredoDeFato(chave, valor) ? VALOR_OCULTO : valor;
}

/**
 * `--token=abc` e `--token abc` viram `--token=<oculto>` e `--token <oculto>`.
 * O resto dos argumentos passa como está.
 */
export function mascararArgs(args: string[]): string[] {
  const saida: string[] = [];
  let mascararOProximo = false;
  for (const arg of args) {
    if (mascararOProximo && !arg.startsWith("-")) {
      saida.push(VALOR_OCULTO);
      mascararOProximo = false;
      continue;
    }
    mascararOProximo = false;
    const igual = /^(-{1,2}[A-Za-z0-9_.-]+)=(.*)$/.exec(arg);
    if (igual !== null) {
      saida.push(ehSegredoDeFato(igual[1]!.replace(/^-+/, ""), igual[2]!) ? `${igual[1]}=${VALOR_OCULTO}` : arg);
    } else {
      saida.push(arg);
      mascararOProximo = /^-{1,2}[A-Za-z0-9_.-]+$/.test(arg) && ehChaveDeSegredo(arg.replace(/^-+/, ""));
    }
  }
  return saida;
}

/** A configuração como a tela mostra: segredo mascarado, o resto inteiro. */
export function configMascarada(config: McpServerInput): McpServerInput {
  const mapa = (r: Record<string, string> | undefined) =>
    r === undefined ? undefined : Object.fromEntries(Object.entries(r).map(([k, v]) => [k, mascarar(k, v)]));
  const env = mapa(config.env);
  const headers = mapa(config.headers);
  return {
    ...config,
    ...(config.command === undefined ? {} : { command: [config.command[0]!, ...mascararArgs(config.command.slice(1))] }),
    ...(env === undefined ? {} : { env }),
    ...(headers === undefined ? {} : { headers }),
  };
}

/**
 * O que a origem mudou em relação ao que foi aceito. A versão do diretório do
 * plugin não conta: os dois lados passam por `semVersaoDoPlugin`. A comparação
 * é pelo valor de verdade; só a saída sai mascarada, e a mudança num valor
 * protegido aparece como tal em vez de sumir.
 */
export function diferencas(aceita: McpServerInput, nova: McpServerInput, source?: McpSource, raiz?: string): Mudanca[] {
  const limpo = (t: string): string => semVersaoDoPlugin(t, source, raiz);
  const saida: Mudanca[] = [];
  if (aceita.transport !== nova.transport) saida.push({ campo: "transport", antes: aceita.transport, depois: nova.transport });

  const ca = aceita.command?.map(limpo);
  const cn = nova.command?.map(limpo);
  if ((ca?.[0] ?? null) !== (cn?.[0] ?? null)) saida.push({ campo: "command", antes: ca?.[0] ?? null, depois: cn?.[0] ?? null });
  const ra = ca?.slice(1).join(" ") ?? "";
  const rn = cn?.slice(1).join(" ") ?? "";
  if (ra !== rn) {
    const ma = mascararArgs(ca?.slice(1) ?? []).join(" ");
    const mn = mascararArgs(cn?.slice(1) ?? []).join(" ");
    saida.push({ campo: "args", antes: ma === "" ? null : ma, depois: mn === "" ? null : mn, ...(ma === mn ? { protegido: true } : {}) });
  }

  const ua = aceita.url === undefined ? null : limpo(aceita.url);
  const un = nova.url === undefined ? null : limpo(nova.url);
  if (ua !== un) saida.push({ campo: "url", antes: ua, depois: un });

  for (const campo of ["env", "headers"] as const) {
    const antes = aceita[campo] ?? {};
    const depois = nova[campo] ?? {};
    for (const chave of [...new Set([...Object.keys(antes), ...Object.keys(depois)])].sort()) {
      // O que é do Locum, como o marcador de OAuth, não vem da origem.
      if (antes[chave] === CREDENTIAL_PLACEHOLDER && depois[chave] === undefined) continue;
      const va = antes[chave] === undefined ? null : limpo(antes[chave]);
      const vn = depois[chave] === undefined ? null : limpo(depois[chave]);
      if (va === vn) continue;
      const ma = va === null ? null : mascarar(chave, va);
      const mn = vn === null ? null : mascarar(chave, vn);
      saida.push({ campo, chave, antes: ma, depois: mn, ...(ma !== null && ma === mn ? { protegido: true } : {}) });
    }
  }
  return saida;
}

/** Por que a origem não tem mais o servidor, para a tela dizer o certo. */
export type MotivoDoSumico = "plugin-desligado" | "plugin-removido" | "ausente";

/** Cache do `~/.claude.json`, que é grande e o Claude Code reescreve a cada sessão: vale enquanto o arquivo não muda. */
const lidosPorMtime = new Map<string, { mtimeNs: bigint; size: bigint; valor: unknown }>();
export function lerJsonCacheado(caminho: string): unknown {
  try {
    const st = statSync(caminho, { bigint: true });
    const guardado = lidosPorMtime.get(caminho);
    if (guardado !== undefined && guardado.mtimeNs === st.mtimeNs && guardado.size === st.size) return guardado.valor;
    const valor = lerJson(caminho);
    lidosPorMtime.set(caminho, { mtimeNs: st.mtimeNs, size: st.size, valor });
    return valor;
  } catch {
    lidosPorMtime.delete(caminho);
    return undefined;
  }
}

/**
 * Lê a origem de um servidor na hora do uso. Guarda o resultado por pouco
 * tempo, para a conexão, a listagem de ferramentas e o teste, que vêm em
 * seguida, não relerem os mesmos arquivos nem abrirem um shell de login cada.
 */
export class OrigemResolver {
  private lidos = new Map<string, { at: number; valor: Resolvido | undefined }>();
  private ambientes = new Map<string, { at: number; valor: Record<string, string> }>();
  private lidas: { at: number; valor: Fonte[] } | undefined;

  constructor(private readonly deps: OrigemDeps) {}

  get home(): string {
    return this.deps.home;
  }

  /** Esquece o que se leu dos arquivos. O que o shell de login respondeu fica: abrir outro custa segundos. */
  esquecer(): void {
    this.lidos.clear();
    this.lidas = undefined;
  }

  /** As fontes, lidas uma vez por rodada. */
  private fontesAgora(): Fonte[] {
    const agora = (this.deps.agora ?? Date.now)();
    if (this.lidas !== undefined && agora - this.lidas.at < (this.deps.ttlMs ?? TTL_PADRAO_MS)) return this.lidas.valor;
    const valor = fontes(this.deps.home);
    this.lidas = { at: agora, valor };
    return valor;
  }

  /** A fonte onde a origem mora hoje, ou nada quando sumiu (plugin desligado, arquivo apagado). */
  fonteDe(source: McpSource): Fonte | undefined {
    const rotulo = rotuloDaOrigem(source);
    return this.fontesAgora().find((f) => f.origem === rotulo && source.server in f.servidores);
  }

  /** Onde editar: o arquivo que declara o servidor, mesmo se a origem sumiu. */
  arquivoDe(source: McpSource): string | undefined {
    return this.fonteDe(source)?.arquivo ?? this.fontesAgora().find((f) => f.origem === rotuloDaOrigem(source))?.arquivo;
  }

  /** Para a origem que sumiu: o plugin está desligado no Claude Code, foi removido, ou só não declara mais o servidor. */
  motivoDoSumico(source: McpSource): MotivoDoSumico {
    if (source.kind !== "claude-plugin") return "ausente";
    const chave = rotuloDaOrigem(source);
    const ajustes = comoObjeto(lerJson(join(this.deps.home, ".claude", "settings.json")));
    if (comoObjeto(ajustes.enabledPlugins)[chave] === false) return "plugin-desligado";
    const instalados = comoObjeto(comoObjeto(lerJson(join(this.deps.home, ".claude", "plugins", "installed_plugins.json"))).plugins);
    return chave in instalados ? "ausente" : "plugin-removido";
  }

  /** `undefined` quando a origem não tem mais o servidor. */
  async resolver(source: McpSource, nome: string): Promise<Resolvido | undefined> {
    const agora = (this.deps.agora ?? Date.now)();
    const chave = JSON.stringify([source, nome]);
    const guardado = this.lidos.get(chave);
    if (guardado !== undefined && agora - guardado.at < (this.deps.ttlMs ?? TTL_PADRAO_MS)) return guardado.valor;

    const fonte = this.fonteDe(source);
    const entrada = fonte?.servidores[source.server];
    let valor: Resolvido | undefined;
    if (fonte !== undefined && entrada !== undefined) {
      const ambiente = await this.ambiente(variaveisCitadas(entrada), agora);
      const p = preparar(nome, fonte.origem, entrada, fonte.raiz, ambiente, new Set());
      valor = {
        config: p.config,
        ...(p.segredo === undefined ? {} : { segredo: p.segredo }),
        ...(p.cliente === undefined ? {} : { cliente: p.cliente }),
        faltando: p.faltando,
        incompleto: p.semValor.length > 0,
        ...(fonte.raiz === undefined ? {} : { raiz: fonte.raiz }),
        ...(fonte.arquivo === undefined ? {} : { arquivo: fonte.arquivo }),
        hash: impressao(p.config, source, fonte.raiz),
      };
    }
    this.lidos.set(chave, { at: agora, valor });
    return valor;
  }

  private async ambiente(nomes: string[], agora: number): Promise<Record<string, string>> {
    const faltam = nomes.filter((n) => process.env[n] === undefined);
    let doShell: Record<string, string> = {};
    if (faltam.length > 0) {
      const chave = [...faltam].sort().join(",");
      const guardado = this.ambientes.get(chave);
      if (guardado !== undefined && agora - guardado.at < TTL_DO_AMBIENTE_MS) doShell = guardado.valor;
      else {
        doShell = await this.deps.ambiente(faltam);
        // Resposta incompleta (shell que falhou ou estourou o tempo) não fica
        // guardada: a próxima leitura tenta de novo.
        if (faltam.every((n) => doShell[n] !== undefined)) this.ambientes.set(chave, { at: agora, valor: doShell });
      }
    }
    return { ...doShell, ...Object.fromEntries(Object.entries(process.env).filter((p): p is [string, string] => p[1] !== undefined)) };
  }
}

/**
 * Onde moram os arquivos das outras ferramentas. A fumaça e as capturas
 * apontam para uma pasta de rascunho com `LOCUM_FERRAMENTAS_HOME`, para não
 * ler nem depender da casa de quem roda.
 */
export function homeDasFerramentas(): string {
  return process.env.LOCUM_FERRAMENTAS_HOME ?? homedir();
}

export function shellDeLogin(nomes: string[]): Promise<Record<string, string>> {
  if (nomes.length === 0) return Promise.resolve({});
  const marca = "__LOCUM_ENV__";
  const script = nomes.map((n) => `printf '${marca}%s=%s\\n' ${n} "$${n}"`).join("; ");
  return new Promise((resolve) => {
    const filho = execFile("/bin/zsh", ["-ilc", script], { timeout: 5_000, encoding: "utf8" }, (erro, stdout) => {
      const out: Record<string, string> = {};
      if (!erro) {
        for (const linha of stdout.split("\n")) {
          if (!linha.startsWith(marca)) continue;
          const [nome, ...resto] = linha.slice(marca.length).split("=");
          const valor = resto.join("=");
          if (nome && valor.length > 0) out[nome] = valor;
        }
      }
      resolve(out);
    });
    filho.stdin?.end();
  });
}

