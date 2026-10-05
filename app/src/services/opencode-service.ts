import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
// A build ESM, porque a UMD (o "main" do pacote) faz `require` dinâmico que o
// esbuild não embute.
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser/lib/esm/main.js";
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
 * cadastro é escrito na configuração global, só na chave `mcp.locum`. O
 * arquivo é editado no lugar, e não regravado, porque o `opencode.jsonc` tem
 * comentário que precisa sobreviver. Só arquivo quebrado é recusado, com a
 * tela mostrando o trecho para colar.
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
    return {
      configPath: lida.path,
      registered: cadastrada !== undefined,
      current:
        cadastrada !== undefined &&
        cadastrada.enabled !== false &&
        JSON.stringify(cadastrada.command) === JSON.stringify(esperada.command),
      snippet: JSON.stringify({ mcp: { [CLAUDE_CODE_SERVER]: esperada } }, null, 2),
    };
  }

  /** Grava `mcp.locum`, ou troca o que aponta para outra cópia. */
  async connect(): Promise<OpencodeStatus> {
    const lida = this.lerConfig();
    if (lida.texto !== null && lida.config === null) {
      throw new Error(`${lida.path} não é JSON válido; cole o trecho mostrado na chave "mcp"`);
    }
    const base = lida.texto ?? `${JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2)}\n`;
    const edicoes = modify(base, ["mcp", CLAUDE_CODE_SERVER], this.entrada(), {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    });
    mkdirSync(dirname(lida.path), { recursive: true });
    writeFileSync(lida.path, applyEdits(base, edicoes));
    return this.status();
  }

  private entrada(): Entrada {
    if (this.launcher === null) throw new Error("o processo principal não disse como subir o servidor MCP");
    return { type: "local", command: [this.launcher.command, ...this.launcher.args, "--mcp"], enabled: true };
  }

  /**
   * O `.json` quando existe, e senão o `.jsonc`; sem nenhum, o `.json` que o
   * botão vai criar. Os dois são lidos aceitando comentário e vírgula sobrando,
   * como o opencode lê. `config` nulo com texto é arquivo quebrado.
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
    const erros: ParseError[] = [];
    const config = parse(texto, erros, { allowTrailingComma: true }) as unknown;
    const objeto = erros.length === 0 && config !== null && typeof config === "object" && !Array.isArray(config);
    return { path, texto, config: objeto ? (config as OpencodeConfig) : null };
  }
}

type OpencodeConfig = { mcp?: Record<string, unknown> } & Record<string, unknown>;

export const opencodeService = new OpencodeService();
