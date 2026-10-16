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
  const env = ambienteDoGh(configDir);
  try {
    const { stdout } = await execFileAsync(bin, args, { env, timeout: PRAZO_MS, encoding: "utf8" });
    return { stdout, stderr: "", ok: true };
  } catch (erro) {
    const e = erro as { stdout?: unknown; stderr?: unknown };
    return { stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? ""), ok: false };
  }
}

function rodar(bin: string, args: string[], configDir?: string): Saida {
  const env = ambienteDoGh(configDir);
  try {
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

function dasContasTexto(texto: string): GhConta[] {
  const contas: GhConta[] = [];
  let atual: GhConta | undefined;
  for (const linha of texto.split("\n")) {
    const entrou = /Logged in to (\S+) (?:account|as) (\S+)/.exec(linha);
    if (entrou !== null) {
      atual = { host: entrou[1]!, login: entrou[2]!, active: false, scopes: "" };
      contas.push(atual);
      continue;
    }
    if (atual === undefined) continue;
    // A linha "Token:" é mascarada e nem é lida.
    const ativa = /Active account:\s*(true|false)/.exec(linha);
    if (ativa !== null) atual.active = ativa[1] === "true";
    const escopos = /Token scopes:\s*(.*)$/.exec(linha);
    if (escopos !== null) {
      atual.scopes = escopos[1]!
        .split(",")
        .map((e) => e.trim().replace(/^'|'$/g, ""))
        .filter((e) => e.length > 0)
        .join(", ");
    }
  }
  return contas;
}

/**
 * As contas que o `gh` tem, por host. Vazio quando não há `gh` ou ninguém logado.
 * Nunca pede o token: nem `--show-token` nem `auth token`.
 */
export async function contasDoGh(configDir?: string): Promise<GhConta[]> {
  const bin = achar();
  if (bin === undefined) return [];

  const json = await rodarAsync(bin, ["auth", "status", "--json", "hosts"], configDir);
  const doJson = dasContasJson(json.stdout);
  if (doJson !== undefined) return doJson;

  const texto = await rodarAsync(bin, ["auth", "status"], configDir);
  return dasContasTexto(`${texto.stdout}\n${texto.stderr}`);
}

/** O mesmo, síncrono, só para o caminho raro do gh antigo dentro do `tokenDoGh`. */
function contasDoGhSync(bin: string, configDir?: string): GhConta[] {
  const json = rodar(bin, ["auth", "status", "--json", "hosts"], configDir);
  const doJson = dasContasJson(json.stdout);
  if (doJson !== undefined) return doJson;
  const texto = rodar(bin, ["auth", "status"], configDir);
  return dasContasTexto(`${texto.stdout}\n${texto.stderr}`);
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

  const base = ["auth", "token", "--hostname", ref.host];
  let r = rodar(bin, [...base, "--user", ref.login], ref.configDir);
  // gh anterior à 2.40 não conhece --user e só entrega o token da conta ativa.
  if (!r.ok && /unknown flag: --user/.test(r.stderr)) {
    const ativa = contasDoGhSync(bin, ref.configDir).find((c) => c.host === ref.host && c.active);
    if (ativa?.login.toLowerCase() !== ref.login.toLowerCase()) {
      throw new GhIndisponivelError(ref.login, `atualize o gh (2.40+) ou torne ${ref.login} a conta ativa de ${ref.host}`);
    }
    r = rodar(bin, base, ref.configDir);
  }
  const token = r.stdout.trim();
  if (!r.ok || token.length === 0) throw new GhIndisponivelError(ref.login);
  return token;
}

const PREFIXO = "gh-ref:";

export function serializarRef(ref: GhRef): string {
  return PREFIXO + JSON.stringify(ref);
}

/** `undefined` quando o valor guardado é um token comum. */
export function lerRef(valor: string): GhRef | undefined {
  if (!valor.startsWith(PREFIXO)) return undefined;
  try {
    const r = JSON.parse(valor.slice(PREFIXO.length)) as Partial<GhRef>;
    if (r.origem !== "gh" || typeof r.host !== "string" || typeof r.login !== "string") return undefined;
    return {
      origem: "gh",
      host: r.host,
      login: r.login,
      ...(typeof r.configDir === "string" && r.configDir.length > 0 ? { configDir: r.configDir } : {}),
    };
  } catch {
    return undefined;
  }
}
