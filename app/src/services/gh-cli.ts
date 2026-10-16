import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * O vínculo com uma conta do `gh`: o que se guarda no lugar do token. O token
 * em si fica com o `gh` e é pedido na hora do uso, então logout, rotação e troca
 * de conta lá valem aqui sem ninguém copiar nada.
 */
export interface GhRef {
  origem: "gh";
  host: string;
  login: string;
  /** `GH_CONFIG_DIR` de quem mantém uma config separada para esta conta. */
  configDir?: string;
}

/**
 * O último resultado conhecido de falar com o gh, guardado junto do vínculo.
 * Não é o prazo de nova tentativa (isso é o cache em memória): é o que a tela
 * mostra enquanto não há resposta mais nova. Nunca carrega token.
 */
export interface GhUltimo {
  ok: boolean;
  /** Segundos desde a época em que o resultado mudou. */
  quando: number;
  erro?: string;
}

/** O que o cofre guarda: a referência e, quando já se sabe, o último resultado. */
export type GhVinculo = GhRef & { ultimo?: GhUltimo };

/** Uma conta que o `gh` conhece. Nunca carrega o token. */
export interface GhConta {
  host: string;
  login: string;
  active: boolean;
  /** Texto como o `gh` mostra, vazio quando não informa. */
  scopes: string;
}

/** Falha de falar com o `gh`. A mensagem é a que a tela mostra e nunca traz a saída dele. */
export class GhIndisponivelError extends Error {
  constructor(login: string, dica?: string) {
    super(dica ?? `a conta ${login} do gh não respondeu; rode gh auth login ou troque a conexão`);
    this.name = "GhIndisponivelError";
  }
}

export const GH_ANTIGO = "o Locum precisa do gh 2.40 ou mais novo (brew upgrade gh)";

/** App aberto pelo Finder herda um PATH curto, sem o diretório do Homebrew. */
const DIRETORIOS_EXTRAS = ["/opt/homebrew/bin", "/usr/local/bin"];
const PRAZO_MS = 5_000;
const TTL_PADRAO_MS = 5 * 60_000;

/** Quanto tempo uma falha do gh é lembrada, para uma conta deslogada não abrir um processo por leitura. */
const TTL_FALHA_MS = 60_000;

let diretoriosExtras = DIRETORIOS_EXTRAS;
let ttlMs = TTL_PADRAO_MS;
let ttlFalhaMs = TTL_FALHA_MS;
let semGh = false;

/** Para o exame trocar onde procurar e por quanto tempo lembrar; `semGh` finge que o gh não existe. */
export function configurarGh(opcoes: {
  diretoriosExtras?: string[];
  ttlMs?: number;
  ttlFalhaMs?: number;
  semGh?: boolean;
}): void {
  if (opcoes.diretoriosExtras !== undefined) diretoriosExtras = opcoes.diretoriosExtras;
  if (opcoes.ttlMs !== undefined) ttlMs = opcoes.ttlMs;
  if (opcoes.ttlFalhaMs !== undefined) ttlFalhaMs = opcoes.ttlFalhaMs;
  if (opcoes.semGh !== undefined) semGh = opcoes.semGh;
}

// Só em memória: o token do gh nunca vai para disco nem para log.
type Lembrado = { token: string; expiraEm: number } | { erro: GhIndisponivelError; expiraEm: number };
const cache = new Map<string, Lembrado>();

export function limparCacheDoGh(): void {
  cache.clear();
}

const chaveDe = (ref: GhRef): string => `${ref.host}\u0000${ref.login}\u0000${ref.configDir ?? ""}`;

/** O que o cache sabe da conta agora, sem abrir processo: o erro lembrado, ou nada. */
export function erroLembradoDoGh(ref: GhRef): GhIndisponivelError | undefined {
  const l = cache.get(chaveDe(ref));
  return l !== undefined && l.expiraEm > Date.now() && "erro" in l ? l.erro : undefined;
}

/** `~` vira a casa de quem usa; o resto precisa ser caminho absoluto. */
export function normalizarConfigDir(dir: string): string {
  const limpo = dir.trim();
  const expandido = limpo === "~" ? homedir() : limpo.startsWith("~/") ? join(homedir(), limpo.slice(2)) : limpo;
  if (!isAbsolute(expandido)) throw new Error("a pasta do GH_CONFIG_DIR precisa ser um caminho absoluto");
  return expandido;
}

function achar(): string | undefined {
  if (semGh) return undefined;
  // Entrada relativa do PATH é a pasta de onde o app foi aberto, e não é lugar de achar binário.
  const doPath = (process.env["PATH"] ?? "").split(delimiter).filter((d) => isAbsolute(d));
  for (const dir of [...doPath, ...diretoriosExtras]) {
    const candidato = join(dir, "gh");
    try {
      accessSync(candidato, constants.X_OK);
      return candidato;
    } catch {
      // próximo
    }
  }
  return undefined;
}

function ambienteDoGh(configDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
  if (configDir !== undefined && configDir.length > 0) env["GH_CONFIG_DIR"] = normalizarConfigDir(configDir);
  return env;
}

type Saida = { stdout: string; stderr: string; ok: boolean };

async function rodarAsync(bin: string, args: string[], configDir?: string): Promise<Saida> {
  try {
    const env = ambienteDoGh(configDir);
    const { stdout } = await execFileAsync(bin, args, { env, timeout: PRAZO_MS, encoding: "utf8" });
    return { stdout, stderr: "", ok: true };
  } catch (erro) {
    const e = erro as { stdout?: unknown; stderr?: unknown };
    return { stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? ""), ok: false };
  }
}

function rodar(bin: string, args: string[], configDir?: string): Saida {
  try {
    const env = ambienteDoGh(configDir);
    const stdout = execFileSync(bin, args, { env, timeout: PRAZO_MS, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { stdout, stderr: "", ok: true };
  } catch (erro) {
    // `gh auth status` sai com código diferente de zero quando alguma conta está ruim e ainda assim lista as outras.
    const e = erro as { stdout?: unknown; stderr?: unknown };
    return { stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? ""), ok: false };
  }
}

function dasContasJson(texto: string): GhConta[] | undefined {
  let lido: unknown;
  try {
    lido = JSON.parse(texto);
  } catch {
    return undefined;
  }
  const hosts = (lido as { hosts?: Record<string, unknown> } | null)?.hosts;
  if (hosts === null || typeof hosts !== "object") return undefined;

  const contas: GhConta[] = [];
  for (const [host, lista] of Object.entries(hosts)) {
    if (!Array.isArray(lista)) continue;
    for (const item of lista as Array<Record<string, unknown>>) {
      if (typeof item["login"] !== "string") continue;
      contas.push({
        host: typeof item["host"] === "string" ? item["host"] : host,
        login: item["login"],
        active: item["active"] === true,
        scopes: typeof item["scopes"] === "string" ? item["scopes"] : "",
      });
    }
  }
  return contas;
}

/**
 * As contas que o `gh` tem, por host. Vazio quando não há `gh` ou ninguém logado.
 * Nunca pede o token: nem `--show-token` nem `auth token`.
 *
 * Exige o `gh` 2.40+, que é quem tem `--json` e `auth token --user`: o antigo
 * vira o aviso de atualizar, e não uma lista que o Locum não saberia usar.
 */
export async function contasDoGh(configDir?: string): Promise<GhConta[]> {
  const bin = achar();
  if (bin === undefined) return [];
  if (configDir !== undefined && configDir.trim().length > 0) normalizarConfigDir(configDir);

  const r = await rodarAsync(bin, ["auth", "status", "--json", "hosts"], configDir);
  if (/unknown flag: --json/.test(r.stderr)) throw new GhIndisponivelError("", GH_ANTIGO);
  return dasContasJson(r.stdout) ?? [];
}

/**
 * O token da conta, pedido ao `gh` agora. Síncrono como o `githubToken`, e
 * lembrado por alguns minutos para a varredura a cada batida não abrir um
 * processo por chamada.
 */
export function tokenDoGh(ref: GhRef): string {
  const chave = chaveDe(ref);
  const lembrado = cache.get(chave);
  if (lembrado !== undefined && lembrado.expiraEm > Date.now()) {
    if ("erro" in lembrado) throw lembrado.erro;
    return lembrado.token;
  }

  try {
    const token = pedirToken(ref);
    cache.set(chave, { token, expiraEm: Date.now() + ttlMs });
    return token;
  } catch (erro) {
    if (erro instanceof GhIndisponivelError) cache.set(chave, { erro, expiraEm: Date.now() + ttlFalhaMs });
    throw erro;
  }
}

function pedirToken(ref: GhRef): string {
  const bin = achar();
  if (bin === undefined) throw new GhIndisponivelError(ref.login);

  let r: Saida;
  try {
    if (ref.configDir !== undefined) normalizarConfigDir(ref.configDir);
    r = rodar(bin, ["auth", "token", "--hostname", ref.host, "--user", ref.login], ref.configDir);
  } catch (erro) {
    // Pasta de configuração inválida: o gh nem chega a rodar, e a mensagem é a da pasta.
    throw new GhIndisponivelError(ref.login, erro instanceof Error ? erro.message : String(erro));
  }
  if (/unknown flag: --user/.test(r.stderr)) throw new GhIndisponivelError(ref.login, GH_ANTIGO);
  const token = r.stdout.trim();
  if (!r.ok || token.length === 0) throw new GhIndisponivelError(ref.login);
  return token;
}

/**
 * Lembra uma falha para esta conta pelo prazo de nova tentativa, sem esvaziar
 * o cache das outras: um 401 numa rajada de requests não pode abrir um
 * processo por request.
 */
export function lembrarFalhaDoGh(ref: GhRef, dica?: string): void {
  cache.set(chaveDe(ref), { erro: new GhIndisponivelError(ref.login, dica), expiraEm: Date.now() + ttlFalhaMs });
}

/** O token já lembrado e ainda válido, sem abrir processo. */
export function tokenLembradoDoGh(ref: GhRef): string | undefined {
  const l = cache.get(chaveDe(ref));
  return l !== undefined && l.expiraEm > Date.now() && "token" in l ? l.token : undefined;
}

const PREFIXO = "gh-ref:";

export function serializarRef(ref: GhVinculo): string {
  return PREFIXO + JSON.stringify(ref);
}

/** `undefined` quando o valor guardado é um token comum. */
export function lerRef(valor: string): GhVinculo | undefined {
  if (!valor.startsWith(PREFIXO)) return undefined;
  try {
    const r = JSON.parse(valor.slice(PREFIXO.length)) as Partial<GhVinculo>;
    if (r.origem !== "gh" || typeof r.host !== "string" || typeof r.login !== "string") return undefined;
    const u = r.ultimo;
    return {
      origem: "gh",
      host: r.host,
      login: r.login,
      ...(typeof r.configDir === "string" && r.configDir.length > 0 ? { configDir: r.configDir } : {}),
      ...(u !== undefined && typeof u.ok === "boolean" && typeof u.quando === "number"
        ? { ultimo: { ok: u.ok, quando: u.quando, ...(typeof u.erro === "string" ? { erro: u.erro } : {}) } }
        : {}),
    };
  } catch {
    return undefined;
  }
}
