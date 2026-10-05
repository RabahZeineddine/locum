import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CLAUDE_CODE_SERVER, type McpLauncher } from "./claude-code-service.js";

export interface OpencodeStatus {
  /** O arquivo de configuração global que o opencode lê. */
  configPath: string;
  /** Existe um `locum` em `mcp` nesse arquivo. */
  registered: boolean;
  /** O cadastrado sobe este aplicativo, e não outra cópia. */
  current: boolean;
  /** O trecho que o botão grava, para quem preferir colar à mão. */
  snippet: string;
}

export interface OpencodeServiceDeps {
  /** Pasta da configuração global: `~/.config/opencode`. */
  configDir: string;
}

type Entrada = { type: "local"; command: string[]; enabled: boolean };

/**
 * Liga o Locum ao opencode, como o `ClaudeCodeService` faz com o Claude Code.
 *
 * O opencode não tem comando que cadastre servidor MCP sem perguntar, então o
 * cadastro é escrito no `opencode.json` global, só na chave `mcp.locum`, com o
 * resto do arquivo preservado. Arquivo com comentário (`opencode.jsonc`, ou
 * `.json` que não é JSON puro) não é reescrito: regravar perderia os
 * comentários, e a tela mostra o trecho para colar.
 */
export class OpencodeService {
  private launcher: McpLauncher | null = null;
  private readonly deps: OpencodeServiceDeps;

  constructor(deps: Partial<OpencodeServiceDeps> = {}) {
    this.deps = { configDir: join(homedir(), ".config", "opencode"), ...deps };
  }

  /** O processo principal diz como ele mesmo sobe, porque só ele sabe. */
  useLauncher(launcher: McpLauncher): void {
    this.launcher = launcher;
  }

  async status(): Promise<OpencodeStatus> {
    const esperada = this.entrada();
    const lida = this.lerConfig();
    const cadastrada = lida.config?.mcp?.[CLAUDE_CODE_SERVER] as Partial<Entrada> | undefined;
    // Arquivo com comentário não é lido como objeto: basta o caminho deste
    // aplicativo aparecer nele, que é o que quem colou o trecho deixou lá.
    const colado = lida.config === null && lida.texto !== null && lida.texto.includes(JSON.stringify(esperada.command[0]));
    return {
      configPath: lida.path,
      registered: cadastrada !== undefined || colado,
      current:
        colado ||
        (cadastrada !== undefined &&
          cadastrada.enabled !== false &&
          JSON.stringify(cadastrada.command) === JSON.stringify(esperada.command)),
      snippet: JSON.stringify({ mcp: { [CLAUDE_CODE_SERVER]: esperada } }, null, 2),
    };
  }

  /** Grava `mcp.locum`, ou troca o que aponta para outra cópia. */
  async connect(): Promise<OpencodeStatus> {
    const lida = this.lerConfig();
    if (lida.texto !== null && lida.config === null) {
      throw new Error(`${lida.path} tem comentário ou não é JSON puro; cole o trecho mostrado na chave "mcp"`);
    }
    const config = lida.config ?? { $schema: "https://opencode.ai/config.json" };
    config.mcp = { ...(config.mcp ?? {}), [CLAUDE_CODE_SERVER]: this.entrada() };
    mkdirSync(dirname(lida.path), { recursive: true });
    writeFileSync(lida.path, `${JSON.stringify(config, null, 2)}\n`);
    return this.status();
  }

  private entrada(): Entrada {
    if (this.launcher === null) throw new Error("o processo principal não disse como subir o servidor MCP");
    return { type: "local", command: [this.launcher.command, ...this.launcher.args, "--mcp"], enabled: true };
  }

  /**
   * O `.json` quando existe, e senão o `.jsonc`; sem nenhum, o `.json` que o
   * botão vai criar. `config` nulo com texto é arquivo que não se reescreve.
   */
  private lerConfig(): { path: string; texto: string | null; config: OpencodeConfig | null } {
    const json = join(this.deps.configDir, "opencode.json");
    const jsonc = join(this.deps.configDir, "opencode.jsonc");
    const path = existsSync(json) || !existsSync(jsonc) ? json : jsonc;
    let texto: string;
    try {
      texto = readFileSync(path, "utf8");
    } catch {
      return { path, texto: null, config: null };
    }
    if (path === jsonc) return { path, texto, config: null };
    try {
      const config = JSON.parse(texto) as unknown;
      return { path, texto, config: config !== null && typeof config === "object" ? (config as OpencodeConfig) : null };
    } catch {
      return { path, texto, config: null };
    }
  }
}

type OpencodeConfig = { mcp?: Record<string, unknown> } & Record<string, unknown>;

export const opencodeService = new OpencodeService();
