import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeBinary } from "../runtimes/claude-binary.js";
import { decidirRegistro, esteEOInstalado, type AmbienteDoApp, type MotivoDoRegistro } from "../native-tools/comando-do-locum.js";

/** Nome com que o Locum aparece nas sessões do Claude Code. */
export const CLAUDE_CODE_SERVER = "locum";

/** Como subir o servidor MCP deste Locum: o binário e o que vem antes de `--mcp`. */
export interface McpLauncher {
  command: string;
  args: string[];
}

export interface ClaudeCodeStatus {
  /** Caminho do `claude` desta máquina, ou nulo quando ele não foi achado. */
  cli: string | null;
  /** Existe um `locum` no escopo de usuário do Claude Code. */
  registered: boolean;
  /** O cadastrado sobe este aplicativo, e não outra cópia ou o de desenvolvimento. */
  current: boolean;
  /**
   * O `locum` do Claude Code aponta para binário que sumiu ou para outra cópia,
   * e este é o app instalado: a tela avisa e oferece corrigir. Nulo quando está
   * certo, quando não há cadastro e sempre fora do app instalado.
   */
  desatualizado: Exclude<MotivoDoRegistro, "sem-registro"> | null;
  /** A linha que o botão roda, para quem preferir colar no terminal. */
  command: string;
}

export type Run = (command: string, args: string[]) => Promise<void>;

export interface ClaudeCodeServiceDeps {
  /** Onde o Claude Code guarda o escopo de usuário. */
  configPath: string;
  resolveClaude: () => Promise<string | undefined>;
  run: Run;
}

const RUN_TIMEOUT_MS = 20_000;

function defaultRun(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const filho = execFile(command, args, { timeout: RUN_TIMEOUT_MS, encoding: "utf8" }, (erro, _stdout, stderr) => {
      if (erro) reject(new Error(stderr.trim() || erro.message));
      else resolve();
    });
    filho.stdin?.end();
  });
}

/** Aspas de shell só onde precisa, para a linha mostrada continuar legível. */
function quote(parte: string): string {
  return /^[\w@%+=:,./-]+$/.test(parte) ? parte : `'${parte.replaceAll("'", `'\\''`)}'`;
}

/**
 * Liga o Locum ao Claude Code, para que qualquer sessão enxergue agents, runs
 * e a fila sem a pessoa editar arquivo de configuração.
 *
 * O cadastro vai pelo próprio `claude mcp add`, e não escrevendo no
 * `~/.claude.json`: o arquivo é do Claude Code, ele o reescreve a cada sessão,
 * e duas mãos no mesmo JSON perdem dado. Ler o arquivo, para mostrar o estado,
 * não tem esse risco.
 *
 * O escopo é o de usuário, que vale em toda pasta. Um `.mcp.json` de projeto
 * com outro `locum` continua ganhando dentro daquele projeto, que é a regra do
 * Claude Code e não cabe ao Locum contornar.
 */
export class ClaudeCodeService {
  private launcher: McpLauncher | null = null;
  private ambiente: AmbienteDoApp | null = null;
  private readonly deps: ClaudeCodeServiceDeps;

  constructor(deps: Partial<ClaudeCodeServiceDeps> = {}) {
    this.deps = {
      configPath: join(homedir(), ".claude.json"),
      resolveClaude: () => claudeBinary(),
      run: defaultRun,
      ...deps,
    };
  }

  /** O processo principal diz como ele mesmo sobe, porque só ele sabe. */
  useLauncher(launcher: McpLauncher): void {
    this.launcher = launcher;
  }

  /** Como este processo roda, para saber se ele é o app instalado. */
  useAmbiente(ambiente: AmbienteDoApp): void {
    this.ambiente = ambiente;
  }

  async status(): Promise<ClaudeCodeStatus> {
    const launcher = this.requireLauncher();
    const cli = (await this.deps.resolveClaude()) ?? null;
    const cadastrado = this.registered();
    const esperado = [launcher.command, ...launcher.args, "--mcp"];
    return {
      cli,
      registered: cadastrado !== null,
      current:
        cadastrado !== null &&
        cadastrado.command === launcher.command &&
        JSON.stringify(cadastrado.args) === JSON.stringify(esperado.slice(1)),
      desatualizado: this.desatualizado(cadastrado),
      command: ["claude", ...this.addArgs(launcher)].map(quote).join(" "),
    };
  }

  /**
   * Cadastra, ou recadastra quando o aplicativo mudou de lugar. Remover antes
   * é o que faz o segundo clique valer: o `add` recusa nome que já existe. Se o
   * `add` falha depois do `remove`, o comando que estava cadastrado volta: o
   * Claude Code não fica sem o Locum por causa de um clique que não deu certo.
   */
  async connect(): Promise<ClaudeCodeStatus> {
    const launcher = this.requireLauncher();
    const cli = await this.deps.resolveClaude();
    if (cli === undefined) {
      throw new Error("não achei o claude nesta máquina; instale o Claude Code e tente de novo");
    }
    const anterior = this.registered();
    if (anterior !== null) {
      await this.deps.run(cli, ["mcp", "remove", "--scope", "user", CLAUDE_CODE_SERVER]);
    }
    try {
      await this.deps.run(cli, this.addArgs(launcher));
    } catch (erro) {
      if (anterior !== null) {
        try {
          await this.deps.run(cli, this.addArgsDe(anterior));
        } catch (falhaDoRollback) {
          const comoRecolocar = ["claude", ...this.addArgsDe(anterior, true)].map(quote).join(" ");
          throw new Error(
            `o Claude Code ficou sem o "${CLAUDE_CODE_SERVER}": o cadastro novo falhou (${mensagem(erro)}) e não deu para recolocar o anterior (${mensagem(falhaDoRollback)}). ` +
              `Para recolocar, rode: ${comoRecolocar}${anterior.env === undefined ? "" : " (e as variáveis de ambiente dele, que não saem aqui)"}`,
            { cause: erro },
          );
        }
      }
      throw erro;
    }
    return this.status();
  }

  /** O `add` que recoloca a entrada como estava, com o tipo, o endereço e o ambiente. */
  private addArgsDe(e: EntradaDoClaude, semSegredo = false): string[] {
    const env = Object.entries(e.env ?? {}).flatMap(([k, v]) => ["-e", semSegredo ? `${k}=<valor>` : `${k}=${v}`]);
    if (e.url !== undefined) {
      const header = Object.entries(e.headers ?? {}).flatMap(([k, v]) => ["-H", `${k}: ${semSegredo ? "<valor>" : v}`]);
      return ["mcp", "add", "--scope", "user", "--transport", e.type === "sse" ? "sse" : "http", ...header, CLAUDE_CODE_SERVER, e.url];
    }
    return ["mcp", "add", "--scope", "user", ...env, CLAUDE_CODE_SERVER, "--", e.command, ...e.args];
  }

  /** Só o app instalado avisa, e só quando o Claude Code já tinha o Locum cadastrado. */
  private desatualizado(cadastrado: { command: string; args: string[] } | null): ClaudeCodeStatus["desatualizado"] {
    if (this.ambiente === null || cadastrado === null || !esteEOInstalado(this.ambiente)) return null;
    const decisao = decidirRegistro(this.ambiente, [cadastrado.command, ...cadastrado.args], "--mcp");
    return decisao.acao === "gravar" && decisao.motivo !== "sem-registro" ? decisao.motivo : null;
  }

  private addArgs(launcher: McpLauncher): string[] {
    return ["mcp", "add", "--scope", "user", CLAUDE_CODE_SERVER, "--", launcher.command, ...launcher.args, "--mcp"];
  }

  private requireLauncher(): McpLauncher {
    if (this.launcher === null) throw new Error("o processo principal não disse como subir o servidor MCP");
    return this.launcher;
  }

  /** O `locum` do escopo de usuário, como o Claude Code o gravou. */
  private registered(): EntradaDoClaude | null {
    let texto: string;
    try {
      texto = readFileSync(this.deps.configPath, "utf8");
    } catch {
      return null;
    }
    try {
      const config = JSON.parse(texto) as { mcpServers?: Record<string, Record<string, unknown>> };
      const entrada = config.mcpServers?.[CLAUDE_CODE_SERVER];
      if (entrada === undefined) return null;
      const texto2 = (v: unknown): Record<string, string> | undefined => {
        if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
        const pares = Object.entries(v).filter((p): p is [string, string] => typeof p[1] === "string");
        return pares.length === 0 ? undefined : Object.fromEntries(pares);
      };
      if (typeof entrada.command !== "string" && typeof entrada.url !== "string") return null;
      const args = Array.isArray(entrada.args) ? entrada.args.filter((a): a is string => typeof a === "string") : [];
      return {
        command: typeof entrada.command === "string" ? entrada.command : "",
        args,
        ...(typeof entrada.type === "string" ? { type: entrada.type } : {}),
        ...(typeof entrada.url === "string" ? { url: entrada.url } : {}),
        ...(texto2(entrada.env) === undefined ? {} : { env: texto2(entrada.env)! }),
        ...(texto2(entrada.headers) === undefined ? {} : { headers: texto2(entrada.headers)! }),
      };
    } catch {
      return null;
    }
  }
}

/** A entrada do `locum` no `~/.claude.json`, inteira: o rollback a recoloca como estava. */
interface EntradaDoClaude {
  command: string;
  args: string[];
  type?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

function mensagem(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

export const claudeCodeService = new ClaudeCodeService();
