import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServerConfig } from "../config/types.js";
import { claudeBinary } from "./claude-binary.js";
import type { Runtime, RuntimeRequest, RuntimeResult } from "./types.js";

const run = promisify(execFile);

/** Argumentos da chamada, separados para o teste conferir o isolamento. */
export function claudeArgs(req: RuntimeRequest, mcpConfigs: Map<string, McpServerConfig>): string[] {
  const servers = req.mcpServers ?? [];
  const allowed = Object.keys(req.tools).map((key) => {
    const [server, ...rest] = key.split("__");
    return `mcp__${server}__${rest.join("__")}`;
  });

  const args = ["-p", req.prompt, "--model", req.model, "--output-format", "json"];

  if (req.system) args.push("--append-system-prompt", req.system);
  if (req.outputSchema) args.push("--json-schema", JSON.stringify(req.outputSchema));
  if (servers.length > 0) args.push("--mcp-config", mcpConfigJson(servers, mcpConfigs));
  if (allowed.length > 0) args.push("--allowedTools", allowed.join(","));
  args.push("--permission-prompts", "none");
  args.push("--strict-mcp-config", "--no-session-persistence", "--setting-sources", "");
  return args;
}

function mcpConfigJson(servers: string[], mcpConfigs: Map<string, McpServerConfig>): string {
  const out: Record<string, unknown> = {};
  for (const name of servers) {
    const cfg = mcpConfigs.get(name);
    if (!cfg) continue;
    out[name] =
      cfg.transport === "stdio"
        ? { command: cfg.command![0], args: cfg.command!.slice(1), env: cfg.env ?? {} }
        : { type: cfg.transport, url: cfg.url, headers: cfg.headers ?? {} };
  }
  return JSON.stringify({ mcpServers: out });
}

/**
 * Única via que gasta a cota da assinatura Max.
 *
 * Não passa `--bare`: esse modo ignora o login de assinatura e exige
 * ANTHROPIC_API_KEY, que é justamente o que queremos evitar aqui. O isolamento
 * vem de três flags que mantêm o login: `--setting-sources ""` tira hooks,
 * regras, plugins e CLAUDE.md pessoais; `--strict-mcp-config` impede que os
 * servidores da máquina, inclusive os de produção, subam junto com um agent que
 * lê diff de terceiro; `--no-session-persistence` deixa o histórico pessoal
 * limpo. `--json-schema` continua sendo a proteção da saída estruturada.
 */
export class ClaudeCodeRuntime implements Runtime {
  readonly id = "claude-code";

  constructor(
    private mcpConfigs: Map<string, McpServerConfig>,
    private binario: () => Promise<string | undefined> = () => claudeBinary(),
  ) {}

  async run(req: RuntimeRequest): Promise<RuntimeResult> {
    const args = claudeArgs(req, this.mcpConfigs);

    // O mesmo caminho absoluto que a sessão interativa usa. Instalado em
    // `~/.claude/local`, o `claude` existe só como alias do `.zshrc`, fora do
    // PATH que o processo herda, e chamar pelo nome falhava com ENOENT.
    const comando = (await this.binario()) ?? "claude";
    const { stdout } = await run(comando, args, {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });

    const payload = JSON.parse(stdout) as {
      result?: string;
      structured_output?: unknown;
      total_cost_usd?: number;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
      is_error?: boolean;
    };

    if (payload.is_error) throw new Error(`claude -p falhou: ${payload.result ?? "sem detalhe"}`);

    return {
      text: payload.result ?? "",
      structured: payload.structured_output,
      promptTokens: payload.usage?.input_tokens ?? 0,
      completionTokens: payload.usage?.output_tokens ?? 0,
      cacheReadTokens: payload.usage?.cache_read_input_tokens,
      // total_cost_usd e o equivalente em API. Na assinatura o gasto marginal
      // e cota, nao dinheiro, entao nao entra no orcamento em dolar.
      costUsd: payload.total_cost_usd ?? 0,
      billable: false,
      toolsUsed: [],
    };
  }
}
