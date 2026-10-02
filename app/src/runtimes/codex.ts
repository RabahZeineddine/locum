import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "../config/types.js";
import type { Runtime, RuntimeRequest, RuntimeResult } from "./types.js";

/**
 * Modelo que deixa a escolha com o Codex. O plano ChatGPT decide quais modelos
 * a conta enxerga, e um id escrito aqui envelheceria; quem quiser um específico
 * escreve `codex/<id>` no passo.
 */
export const CODEX_DEFAULT_MODEL = "default";

const TIMEOUT_MS = 15 * 60 * 1000;

/** Valor TOML de uma linha, que é o que o `-c` do Codex lê. */
function toml(valor: unknown): string {
  if (typeof valor === "string") return JSON.stringify(valor);
  if (Array.isArray(valor)) return `[${valor.map(toml).join(",")}]`;
  if (valor !== null && typeof valor === "object") {
    const pares = Object.entries(valor as Record<string, unknown>).map(([k, v]) => `${JSON.stringify(k)}=${toml(v)}`);
    return `{${pares.join(",")}}`;
  }
  return String(valor);
}

/**
 * Variável que muda o próprio Codex, e não só o servidor. Essas seguem no `-c`
 * do servidor, porque pô-las no ambiente do processo trocaria o PATH ou a
 * pasta de configuração do Codex inteiro.
 */
const DO_PROCESSO = /^(PATH|HOME|SHELL|TMPDIR|NODE_OPTIONS|CODEX_.*|DYLD_.*|LD_.*)$/;

/**
 * Argumentos e ambiente da chamada, separados para o teste conferir.
 *
 * Valor de `env` e de cabeçalho vai pelo ambiente do processo, e o `-c` leva
 * só o nome da variável (`env_vars`, `env_http_headers`): argumento aparece no
 * `ps` de qualquer conta da máquina, e é ali que o token do servidor ficava.
 * As mesmas variáveis saem do ambiente do shell do Codex, para o modelo não
 * lê-las com um `env`.
 */
export function codexCall(
  req: RuntimeRequest,
  mcpConfigs: Map<string, McpServerConfig>,
  arquivos: { schema?: string; pasta: string },
): { args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {};
  const args = codexArgsCom(req, mcpConfigs, arquivos, env);
  return { args, env };
}

/** Só os argumentos, para quem não precisa do ambiente. */
export function codexArgs(
  req: RuntimeRequest,
  mcpConfigs: Map<string, McpServerConfig>,
  arquivos: { schema?: string; pasta: string },
): string[] {
  return codexCall(req, mcpConfigs, arquivos).args;
}

/**
 * Argumentos da chamada, separados para o teste conferir o isolamento.
 *
 * `--ignore-user-config` deixa de fora o `config.toml` pessoal, e com ele os
 * servidores MCP da máquina: um agent que lê diff de terceiro não pode subir
 * junto o servidor de produção de alguém. O login continua valendo, porque mora
 * em outro arquivo. `--ephemeral` não grava sessão e `--sandbox read-only`
 * impede o agent de mexer em arquivo; escrever fora continua sendo da fila.
 */
function codexArgsCom(
  req: RuntimeRequest,
  mcpConfigs: Map<string, McpServerConfig>,
  arquivos: { schema?: string; pasta: string },
  env: Record<string, string>,
): string[] {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--cd",
    arquivos.pasta,
  ];
  if (req.model !== CODEX_DEFAULT_MODEL) args.push("--model", req.model);
  if (arquivos.schema !== undefined) args.push("--output-schema", arquivos.schema);

  // Só as ferramentas que o passo marcou: o servidor sobe inteiro, mas o Codex
  // enxerga apenas as da lista.
  const porServidor = new Map<string, string[]>();
  for (const chave of Object.keys(req.tools)) {
    const [servidor, ...resto] = chave.split("__");
    porServidor.set(servidor!, [...(porServidor.get(servidor!) ?? []), resto.join("__")]);
  }

  for (const nome of req.mcpServers ?? []) {
    const cfg = mcpConfigs.get(nome);
    if (!cfg) continue;
    // O `-c` separa a chave por ponto antes de ler o TOML, então nome com
    // ponto ou aspas viraria outra chave. O cadastro já não aceita esses, e
    // aqui fica a garantia.
    if (!/^[A-Za-z0-9_-]+$/.test(nome)) throw new Error(`servidor MCP "${nome}" tem nome que o Codex não aceita`);
    const base = `mcp_servers.${nome}`;
    if (cfg.transport === "stdio") {
      args.push("-c", `${base}.command=${toml(cfg.command![0])}`);
      args.push("-c", `${base}.args=${toml(cfg.command!.slice(1))}`);
      const doProcesso: Record<string, string> = {};
      const porNome: string[] = [];
      for (const [chave, valor] of Object.entries(cfg.env ?? {})) {
        if (DO_PROCESSO.test(chave)) {
          doProcesso[chave] = valor;
          continue;
        }
        // O `env_vars` repassa a variável com o mesmo nome, então dois
        // servidores não podem querer valores diferentes para ela.
        if (env[chave] !== undefined && env[chave] !== valor) {
          throw new Error(`dois servidores do passo pedem ${chave} com valores diferentes; o Codex não separa os dois`);
        }
        env[chave] = valor;
        porNome.push(chave);
      }
      if (Object.keys(doProcesso).length > 0) args.push("-c", `${base}.env=${toml(doProcesso)}`);
      if (porNome.length > 0) args.push("-c", `${base}.env_vars=${toml(porNome)}`);
    } else {
      args.push("-c", `${base}.url=${toml(cfg.url)}`);
      const cabecalhos: Record<string, string> = {};
      for (const [cabecalho, valor] of Object.entries(cfg.headers ?? {})) {
        const variavel = `LOCUM_MCP_HEADER_${Object.keys(env).length}`;
        env[variavel] = valor;
        cabecalhos[cabecalho] = variavel;
      }
      if (Object.keys(cabecalhos).length > 0) args.push("-c", `${base}.env_http_headers=${toml(cabecalhos)}`);
    }
    args.push("-c", `${base}.enabled_tools=${toml(porServidor.get(nome) ?? [])}`);
  }

  if (Object.keys(env).length > 0) {
    args.push("-c", `shell_environment_policy.exclude=${toml(Object.keys(env))}`);
  }

  // O prompt vai pela entrada padrão: argumento de linha de comando tem teto e
  // aparece no `ps` de quem estiver olhando.
  args.push("-");
  return args;
}

/** O Codex não tem campo de sistema no `exec`; as instruções vão na frente. */
export function codexPrompt(req: RuntimeRequest): string {
  return req.system === undefined ? req.prompt : `${req.system}\n\n${req.prompt}`;
}

type Evento =
  | { type: "item.completed"; item: { type: string; text?: string; server?: string; tool?: string } }
  | {
      type: "turn.completed";
      usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
    }
  | { type: "turn.failed"; error?: { message?: string } }
  | { type: "error"; message?: string }
  | { type: string };

/**
 * Lê o JSONL do `codex exec --json`. A resposta é a última mensagem do agent;
 * o uso soma todos os turnos, que num `exec` costuma ser um só. Formato
 * conferido contra o `codex-cli` 0.160.0 sem login: o 401 chega como uma série
 * de `error` de reconexão e termina em `turn.failed` com saída 1.
 */
export function readCodexEvents(stdout: string): {
  text: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  toolsUsed: string[];
  error?: string;
  lastNotice?: string;
} {
  let text = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens: number | undefined;
  const toolsUsed = new Set<string>();
  let error: string | undefined;
  let lastNotice: string | undefined;

  for (const linha of stdout.split("\n")) {
    if (!linha.trim().startsWith("{")) continue;
    let evento: Evento;
    try {
      evento = JSON.parse(linha) as Evento;
    } catch {
      continue;
    }
    if (evento.type === "item.completed" && "item" in evento) {
      if (evento.item.type === "agent_message" && typeof evento.item.text === "string") text = evento.item.text;
      if (evento.item.type === "mcp_tool_call" && evento.item.server && evento.item.tool) {
        toolsUsed.add(`${evento.item.server}__${evento.item.tool}`);
      }
    } else if (evento.type === "turn.completed" && "usage" in evento && evento.usage) {
      promptTokens += evento.usage.input_tokens ?? 0;
      completionTokens += evento.usage.output_tokens ?? 0;
      if (evento.usage.cached_input_tokens !== undefined) {
        cacheReadTokens = (cacheReadTokens ?? 0) + evento.usage.cached_input_tokens;
      }
    } else if (evento.type === "turn.failed" && "error" in evento) {
      error = evento.error?.message ?? "turno falhou sem detalhe";
    } else if (evento.type === "error" && "message" in evento) {
      // Não é falha: o Codex manda `error` a cada tentativa de reconexão
      // ("Reconnecting... 2/5") e segue o turno. Fica guardado para explicar
      // a saída se o processo morrer sem `turn.failed`.
      lastNotice = evento.message;
    }
  }

  return { text, promptTokens, completionTokens, cacheReadTokens, toolsUsed: [...toolsUsed], error, lastNotice };
}

function executar(
  comando: string,
  args: string[],
  entrada: string,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const filho = spawn(comando, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    const prazo = setTimeout(() => filho.kill("SIGTERM"), TIMEOUT_MS);
    filho.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    filho.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    filho.on("error", (err) => {
      clearTimeout(prazo);
      reject(err);
    });
    filho.on("close", (code) => {
      clearTimeout(prazo);
      resolve({ stdout, stderr, code });
    });
    filho.stdin.end(entrada);
  });
}

/**
 * A via do plano ChatGPT, para a máquina sem assinatura Claude.
 *
 * Roda numa pasta temporária vazia, e não no diretório do app: o Codex lê
 * `.codex/config.toml` do projeto em que está, e o projeto certo para um agent
 * de revisão é nenhum. O gasto é cota do plano, não dinheiro, então fica fora
 * do orçamento em dólar como o do Claude Code.
 */
export class CodexRuntime implements Runtime {
  readonly id = "codex";

  constructor(
    private mcpConfigs: Map<string, McpServerConfig>,
    private binario = "codex",
  ) {}

  async run(req: RuntimeRequest): Promise<RuntimeResult> {
    const pasta = await mkdtemp(join(tmpdir(), "locum-codex-"));
    try {
      let schema: string | undefined;
      if (req.outputSchema !== undefined) {
        schema = join(pasta, "schema.json");
        await writeFile(schema, JSON.stringify(req.outputSchema));
      }
      const { args, env } = codexCall(req, this.mcpConfigs, { schema, pasta });
      const { stdout, stderr, code } = await executar(this.binario, args, codexPrompt(req), env);
      const lido = readCodexEvents(stdout);

      if (code !== 0 || lido.error !== undefined) {
        const detalhe = lido.error ?? lido.lastNotice ?? (stderr.trim().split("\n").pop() || `saiu com ${code}`);
        throw new Error(`codex exec falhou: ${detalhe.slice(0, 500)}`);
      }

      let structured: unknown;
      if (req.outputSchema !== undefined) {
        try {
          structured = JSON.parse(lido.text);
        } catch {
          throw new Error("codex exec devolveu texto que não é o JSON do schema");
        }
      }

      return {
        text: lido.text,
        structured,
        promptTokens: lido.promptTokens,
        completionTokens: lido.completionTokens,
        cacheReadTokens: lido.cacheReadTokens,
        costUsd: 0,
        billable: false,
        toolsUsed: lido.toolsUsed,
      };
    } finally {
      await rm(pasta, { recursive: true, force: true });
    }
  }
}
