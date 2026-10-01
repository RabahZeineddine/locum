import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeBinary } from "../runtimes/claude-binary.js";

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
      command: ["claude", ...this.addArgs(launcher)].map(quote).join(" "),
    };
  }

  /**
   * Cadastra, ou recadastra quando o aplicativo mudou de lugar. Remover antes
   * é o que faz o segundo clique valer: o `add` recusa nome que já existe.
   */
  async connect(): Promise<ClaudeCodeStatus> {
    const launcher = this.requireLauncher();
    const cli = await this.deps.resolveClaude();
    if (cli === undefined) {
      throw new Error("não achei o claude nesta máquina; instale o Claude Code e tente de novo");
    }
    if (this.registered() !== null) {
      await this.deps.run(cli, ["mcp", "remove", "--scope", "user", CLAUDE_CODE_SERVER]);
    }
    await this.deps.run(cli, this.addArgs(launcher));
    return this.status();
  }

  private addArgs(launcher: McpLauncher): string[] {
    return ["mcp", "add", "--scope", "user", CLAUDE_CODE_SERVER, "--", launcher.command, ...launcher.args, "--mcp"];
  }

  private requireLauncher(): McpLauncher {
    if (this.launcher === null) throw new Error("o processo principal não disse como subir o servidor MCP");
    return this.launcher;
  }

  /** O `locum` do escopo de usuário, como o Claude Code o gravou. */
  private registered(): { command: string; args: string[] } | null {
    let texto: string;
    try {
      texto = readFileSync(this.deps.configPath, "utf8");
    } catch {
      return null;
    }
    try {
      const config = JSON.parse(texto) as { mcpServers?: Record<string, { command?: unknown; args?: unknown }> };
      const entrada = config.mcpServers?.[CLAUDE_CODE_SERVER];
      if (entrada === undefined || typeof entrada.command !== "string") return null;
      const args = Array.isArray(entrada.args) ? entrada.args.filter((a): a is string => typeof a === "string") : [];
      return { command: entrada.command, args };
    } catch {
      return null;
    }
  }
}

export const claudeCodeService = new ClaudeCodeService();
