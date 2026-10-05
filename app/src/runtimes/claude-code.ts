import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "../config/types.js";
import { claudeBinary } from "./claude-binary.js";
import { ehLeitura, flagsDaConta } from "./claude-account.js";
import { cortar, nomeDaFerramenta, type Atividade, type Runtime, type RuntimeRequest, type RuntimeResult } from "./types.js";

/** O mesmo teto de sempre para um passo inteiro, com todas as voltas de ferramenta. */
const TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Argumentos da chamada, separados para o teste conferir o isolamento.
 *
 * Os servidores vão por arquivo, e não pelo valor da flag: o cadastro chega
 * aqui com a credencial já preenchida, e argumento de processo aparece no `ps`
 * de qualquer usuário da máquina.
 */
export function claudeArgs(req: RuntimeRequest, mcpConfigPath?: string): string[] {
  const servers = req.mcpServers ?? [];
  const allowed = Object.keys(req.tools).map((key) => {
    const [server, ...rest] = key.split("__");
    return `mcp__${server}__${rest.join("__")}`;
  });

  const daConta = req.accountTools ?? [];
  const escrita = daConta.filter((nome) => !ehLeitura(nome));
  if (escrita.length > 0) {
    throw new Error(`ferramenta de escrita da conta Claude não entra em passo de modelo: ${escrita.join(", ")}`);
  }
  allowed.push(...daConta);

  // stream-json traz cada chamada de ferramenta enquanto acontece, para a tela
  // acompanhar; o resultado final vem na última linha, igual ao modo json.
  const args = ["-p", req.prompt, "--model", req.model, "--output-format", "stream-json", "--verbose"];

  if (req.system) args.push("--append-system-prompt", req.system);
  if (req.outputSchema) args.push("--json-schema", JSON.stringify(req.outputSchema));
  if (servers.length > 0) {
    if (mcpConfigPath === undefined) throw new Error("passo com servidor MCP precisa do arquivo de configuração");
    args.push("--mcp-config", mcpConfigPath);
  }
  if (allowed.length > 0) args.push("--allowedTools", allowed.join(","));
  args.push("--permission-prompts", "none", "--no-session-persistence");
  // Com ferramenta da conta, a configuração da pessoa precisa entrar, senão
  // conector e plugin somem; `flagsDaConta` desliga o que viria junto. Sem
  // ela, o isolamento de sempre.
  if (daConta.length > 0) args.push(...flagsDaConta());
  // `--tools ""` tira Bash, Read, Edit e as outras embutidas: sem isso, o
  // agent saía procurando arquivo pelo disco, até `find /`. Ficam só os
  // servidores MCP liberados e a saída estruturada. Com a conta, quem fecha
  // as embutidas é `flagsDaConta`.
  else args.push("--strict-mcp-config", "--setting-sources", "", "--tools", "");
  return args;
}

export function mcpConfigJson(servers: string[], mcpConfigs: Map<string, McpServerConfig>): string {
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
 *
 * A exceção é o passo com ferramenta da conta Claude: ver `flagsDaConta`.
 * Mesmo nele, os servidores do Locum continuam indo por `--mcp-config` e só
 * roda ferramenta listada em `--allowedTools`.
 */
export class ClaudeCodeRuntime implements Runtime {
  readonly id = "claude-code";

  constructor(
    private mcpConfigs: Map<string, McpServerConfig>,
    private binario: () => Promise<string | undefined> = () => claudeBinary(),
  ) {}

  async run(req: RuntimeRequest): Promise<RuntimeResult> {
    const servers = req.mcpServers ?? [];
    const pasta = servers.length > 0 ? await mkdtemp(join(tmpdir(), "locum-mcp-")) : undefined;
    try {
      let caminho: string | undefined;
      if (pasta !== undefined) {
        caminho = join(pasta, "mcp.json");
        await writeFile(caminho, mcpConfigJson(servers, this.mcpConfigs), { mode: 0o600 });
      }
      return await this.chamar(claudeArgs(req, caminho), req.onActivity);
    } finally {
      if (pasta !== undefined) await rm(pasta, { recursive: true, force: true });
    }
  }

  private async chamar(args: string[], onActivity?: (a: Atividade) => void): Promise<RuntimeResult> {
    // O mesmo caminho absoluto que a sessão interativa usa. Instalado em
    // `~/.claude/local`, o `claude` existe só como alias do `.zshrc`, fora do
    // PATH que o processo herda, e chamar pelo nome falhava com ENOENT.
    const comando = (await this.binario()) ?? "claude";
    const leitor = new LeitorDoStream(onActivity);

    await new Promise<void>((pronto, falhou) => {
      // Numa pasta vazia: a pasta de trabalho do app levava junto memória e
      // CLAUDE.md de projeto que não têm nada com o passo.
      // A resposta de ferramenta acima do teto vira arquivo, e sem Read o
      // modelo não teria como abrir; o teto mais alto deixa a resposta voltar
      // direto. Planilha inteira continua grande demais: a instrução do agent
      // pede só o intervalo que interessa.
      const filho = spawn(comando, args, {
        cwd: tmpdir(),
        // MCP_TIMEOUT: servidor por npx leva de 10 a 90 s para subir com a
        // máquina carregada e o antivírus lendo cada arquivo do pacote, e quando
        // passa do prazo o claude segue sem ele. Servidor morto de verdade só
        // custa a espera.
        env: {
          ...process.env,
          MAX_MCP_OUTPUT_TOKENS: process.env.MAX_MCP_OUTPUT_TOKENS ?? "60000",
          MCP_TIMEOUT: process.env.MCP_TIMEOUT ?? "180000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let resto = "";
      let erros = "";
      let estourou = false;
      const prazo = setTimeout(() => {
        estourou = true;
        filho.kill("SIGTERM");
      }, TIMEOUT_MS);
      filho.stdout.setEncoding("utf8");
      filho.stdout.on("data", (pedaco: string) => {
        const linhas = (resto + pedaco).split("\n");
        resto = linhas.pop() ?? "";
        for (const linha of linhas) leitor.linha(linha);
      });
      filho.stderr.setEncoding("utf8");
      filho.stderr.on("data", (pedaco: string) => {
        erros = (erros + pedaco).slice(-4000);
      });
      filho.on("error", (err) => {
        clearTimeout(prazo);
        falhou(err);
      });
      filho.on("close", (codigo, sinal) => {
        clearTimeout(prazo);
        if (resto.length > 0) leitor.linha(resto);
        if (leitor.final !== null) return pronto();
        // O claude trata o SIGTERM e sai com 143, então o sinal não serve para saber se foi o prazo.
        const motivo = estourou ? `passou de ${TIMEOUT_MS / 60000} min` : `saiu com ${codigo ?? sinal}`;
        falhou(new Error(`claude -p ${motivo}: ${erros.trim().slice(-800) || "sem detalhe"}`));
      });
    });

    const payload = leitor.final!;
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
      toolsUsed: [...leitor.ferramentas],
    };
  }
}

type Final = {
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  is_error?: boolean;
};

type Conteudo = { type?: string; id?: string; name?: string; input?: unknown; text?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };

/**
 * Lê o `--output-format stream-json` linha a linha: cada `tool_use` vira uma
 * chamada, cada `tool_result` o desfecho dela, e o texto do modelo entra entre
 * os dois. A ferramenta `StructuredOutput` é o próprio Claude Code montando a
 * saída e fica de fora. A linha `result` é a mesma do modo json.
 */
export class LeitorDoStream {
  final: Final | null = null;
  readonly ferramentas = new Set<string>();
  private readonly inicio = new Map<string, number>();

  constructor(
    private readonly onActivity?: (a: Atividade) => void,
    private readonly agora: () => number = Date.now,
  ) {}

  linha(texto: string): void {
    if (texto.trim() === "") return;
    let evento: { type?: string; message?: { content?: unknown } } & Final;
    try {
      evento = JSON.parse(texto);
    } catch {
      return;
    }
    if (evento.type === "result") {
      this.final = evento;
      return;
    }
    // Servidor que não subiu some calado: o modelo só diz que a ferramenta
    // não existe, e a tela precisa mostrar qual servidor faltou.
    if (evento.type === "system") {
      const servidores = (evento as { mcp_servers?: { name?: string; status?: string }[] }).mcp_servers ?? [];
      for (const m of servidores) {
        if (m.status !== undefined && m.status !== "connected") {
          this.emitir({ tipo: "resultado", detalhe: `servidor ${m.name ?? "?"} não conectou (${m.status})`, erro: true });
        }
      }
      return;
    }
    const conteudo = Array.isArray(evento.message?.content) ? (evento.message.content as Conteudo[]) : [];
    for (const c of conteudo) {
      if (evento.type === "assistant" && c.type === "tool_use" && c.name !== undefined && c.name !== "StructuredOutput") {
        this.ferramentas.add(c.name);
        if (c.id !== undefined) this.inicio.set(c.id, this.agora());
        this.emitir({ tipo: "ferramenta", ferramenta: nomeDaFerramenta(c.name), detalhe: cortar(JSON.stringify(c.input ?? {})) });
      } else if (evento.type === "assistant" && c.type === "text" && (c.text ?? "").trim() !== "") {
        this.emitir({ tipo: "texto", detalhe: cortar(c.text!) });
      } else if (evento.type === "user" && c.type === "tool_result" && c.tool_use_id !== undefined) {
        const comecou = this.inicio.get(c.tool_use_id);
        if (comecou === undefined) continue;
        this.inicio.delete(c.tool_use_id);
        this.emitir({
          tipo: "resultado",
          detalhe: cortar(textoDoResultado(c.content)),
          erro: c.is_error === true,
          ms: this.agora() - comecou,
        });
      }
    }
  }

  private emitir(a: Omit<Atividade, "at">): void {
    this.onActivity?.({ at: this.agora(), ...a });
  }
}

function textoDoResultado(conteudo: unknown): string {
  if (typeof conteudo === "string") return conteudo;
  if (Array.isArray(conteudo)) {
    return conteudo.map((c: { text?: string }) => (typeof c?.text === "string" ? c.text : "")).join(" ");
  }
  return "";
}
