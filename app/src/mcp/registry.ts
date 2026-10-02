import { randomUUID } from "node:crypto";
import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { ToolSet } from "ai";
import type { McpServerConfig, ToolRef } from "../config/types.js";

/** O que o servidor expoe, do ponto de vista de quem administra o cadastro. */
export interface McpToolInfo {
  name: string;
  description: string;
  /**
   * Quanto o schema desta ferramenta pesa no contexto quando ela entra num
   * passo. E estimativa grosseira, por caractere, e serve so para comparar
   * ferramentas entre si na hora de escolher quais marcar.
   */
  estimatedTokens: number;
}

type Entry = {
  client: Awaited<ReturnType<typeof createMCPClient>>;
  tools: ToolSet;
  timer: NodeJS.Timeout | null;
  refs: number;
  /** O cadastro com que o processo subiu, para saber se ele ficou velho. */
  fingerprint: string;
  /** Saiu do pool por cadastro trocado, e fecha quando o último uso soltar. */
  retired: boolean;
};

/**
 * Sobe servidor MCP sob demanda e encerra depois de ocioso.
 *
 * Cada servidor stdio e um processo de 30 a 80 MB. Sem isso, a quantidade de
 * servidores cadastrados vira o consumo de memoria em repouso do app, que e
 * exatamente o que nao pode acontecer num app que fica na bandeja o dia todo.
 */
/**
 * Falha de credencial, pelo texto. O SDK do MCP não tipa o erro de HTTP, então
 * o que sobra é o status e as palavras que servidor e proxy costumam usar.
 */
export function isAuthError(message: string): boolean {
  return /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[_ ]?(token|grant|credentials?)|token (has )?expired|expired token|session (has )?expired|authenticat|não autorizado|nao autorizado/i.test(
    message,
  );
}

/** Desfecho de uma conexão, para quem guarda a saúde do cadastro. */
export type McpConnectOutcome = { ok: true } | { ok: false; error: string };

export class McpRegistry {
  /**
   * Quem fica sabendo de cada conexão, de qualquer registro. É um só para o
   * processo inteiro porque o pool do executor, o registro descartável do teste
   * e o da fonte de Slack falam com o mesmo cadastro.
   */
  private static observer: ((name: string, outcome: McpConnectOutcome) => void) | null = null;

  static observe(fn: ((name: string, outcome: McpConnectOutcome) => void) | null): void {
    McpRegistry.observer = fn;
  }

  private live = new Map<string, Entry>();
  // Duas execuções ao mesmo tempo pedindo o mesmo servidor ainda frio subiriam
  // dois processos, e o que perdesse a vaga no mapa ficaria órfão.
  private connecting = new Map<string, Promise<Entry>>();

  constructor(private configs: Map<string, McpServerConfig>) {}

  static fromList(list: McpServerConfig[]): McpRegistry {
    return new McpRegistry(new Map(list.map((c) => [c.name, c])));
  }

  has(name: string): boolean {
    return this.configs.has(name);
  }

  private async connect(name: string): Promise<Entry> {
    const existing = this.live.get(name);
    if (existing) return existing;
    const inFlight = this.connecting.get(name);
    if (inFlight) return inFlight;

    const pending = this.spawn(name)
      .then(
        (entry) => {
          McpRegistry.observer?.(name, { ok: true });
          return entry;
        },
        (err: unknown) => {
          if (!this.configs.has(name)) throw err;
          const message = err instanceof Error ? err.message : String(err);
          McpRegistry.observer?.(name, { ok: false, error: message });
          // Quem lê é a pessoa, no passo que falhou: o erro do SDK sozinho não
          // diz que o conserto é reconectar.
          if (isAuthError(message)) {
            throw new Error(
              `servidor MCP "${name}" recusou a credencial; reconecte em Configuração (${message.slice(0, 200)})`,
              { cause: err },
            );
          }
          throw err;
        },
      )
      .finally(() => this.connecting.delete(name));
    this.connecting.set(name, pending);
    return pending;
  }

  private async spawn(name: string): Promise<Entry> {
    const cfg = this.configs.get(name);
    if (!cfg) throw new Error(`servidor MCP "${name}" nao cadastrado`);

    const client =
      cfg.transport === "stdio"
        ? await createMCPClient({
            transport: new Experimental_StdioMCPTransport({
              command: cfg.command![0]!,
              args: cfg.command!.slice(1),
              env: cfg.env,
            }),
          })
        : await createMCPClient({
            transport: { type: cfg.transport, url: cfg.url!, headers: cfg.headers },
          });

    const entry: Entry = {
      client,
      tools: await client.tools(),
      timer: null,
      refs: 0,
      fingerprint: fingerprint(cfg),
      retired: false,
    };
    this.live.set(name, entry);
    return entry;
  }

  /**
   * Troca o cadastro sem derrubar o que continua igual.
   *
   * O pool vive mais que uma execução, então o cadastro pode mudar com o
   * processo de pé. Servidor removido ou alterado sai do pool; se alguém ainda
   * o usa, fecha quando o uso soltar, e a próxima conexão sobe com o cadastro
   * novo.
   */
  reconfigure(configs: Map<string, McpServerConfig>): void {
    this.configs = configs;
    for (const [name, entry] of this.live) {
      const cfg = configs.get(name);
      if (cfg && fingerprint(cfg) === entry.fingerprint) continue;
      this.live.delete(name);
      entry.retired = true;
      if (entry.refs === 0) this.close(entry);
    }
  }

  private close(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    void entry.client.close().catch(() => undefined);
  }

  private take(entry: Entry): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.refs += 1;
  }

  private drop(name: string, entry: Entry): void {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) return;
    if (entry.retired) {
      this.close(entry);
      return;
    }
    const cfg = this.configs.get(name)!;
    entry.timer = setTimeout(() => {
      if (entry.refs > 0) return;
      if (this.live.get(name) === entry) this.live.delete(name);
      this.close(entry);
    }, cfg.idleTimeoutMs);
    entry.timer.unref();
  }

  /**
   * Devolve apenas as ferramentas marcadas no passo. Habilitar o servidor
   * inteiro joga dezenas de schemas no contexto a cada chamada, o que custa
   * token e piora a escolha do modelo.
   */
  async toolsFor(refs: ToolRef[]): Promise<{ tools: ToolSet; release: () => void }> {
    const wanted = new Map<string, ToolRef[]>();
    for (const ref of refs) {
      if (ref.class === "external_write") {
        throw new Error(
          `ferramenta "${ref.server}.${ref.tool}" e escrita externa e nao pode entrar como tool de passo. ` +
            `Escrita externa vira passo de acao, que passa pela fila de aprovacao.`,
        );
      }
      const list = wanted.get(ref.server) ?? [];
      list.push(ref);
      wanted.set(ref.server, list);
    }

    const taken: [string, Entry][] = [];
    const tools: ToolSet = {};

    for (const [server, list] of wanted) {
      const entry = await this.connect(server);
      this.take(entry);
      taken.push([server, entry]);

      for (const ref of list) {
        const found = entry.tools[ref.tool];
        if (!found) throw new Error(`ferramenta "${ref.tool}" nao existe no servidor "${server}"`);
        tools[`${server}__${ref.tool}`] = found;
      }
    }

    return {
      tools,
      release: () => {
        for (const [server, entry] of taken) this.drop(server, entry);
      },
    };
  }

  /**
   * Conecta e descreve o que o servidor expoe, sem reservar nada.
   *
   * Nao usa `toolsFor` porque aqui ninguem vai chamar ferramenta: o alvo e o
   * catalogo. Quem chama fecha depois com `closeAll`, porque o processo stdio
   * segura o event loop e a linha de comando nao terminaria sozinha.
   */
  async describeTools(name: string): Promise<McpToolInfo[]> {
    const entry = await this.connect(name);
    return Object.entries(entry.tools)
      .map(([toolName, tool]) => ({
        name: toolName,
        description: tool.description ?? "",
        estimatedTokens: estimateTokens(toolName, tool.description, tool.inputSchema),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Chama uma ferramenta direto, sem passar por modelo.
   *
   * Quem usa isto e o gatilho de varredura por MCP: ele nao precisa de um passo
   * nem de contexto, so do resultado bruto para virar evento. A contagem de
   * referencia e a mesma de `toolsFor`, senao o encerramento por ocioso mataria
   * o processo no meio da chamada.
   *
   * A chamada vai pelo embrulho do AI SDK porque o cliente desta versao do
   * pacote nao expoe `callTool`. O `toolCallId` e exigido pela assinatura e nao
   * significa nada aqui: nao ha conversa nem modelo esperando resposta.
   */
  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    const entry = await this.connect(server);
    const found = entry.tools[tool];
    if (!found) throw new Error(`ferramenta "${tool}" nao existe no servidor "${server}"`);
    if (!found.execute) throw new Error(`ferramenta "${tool}" do servidor "${server}" nao executa`);

    this.take(entry);
    try {
      return await found.execute(args, { toolCallId: randomUUID(), messages: [] });
    } finally {
      this.drop(server, entry);
    }
  }

  /** Servidores obrigatorios do passo que nao existem nesta maquina. */
  missing(names: string[]): string[] {
    return names.filter((n) => !this.configs.has(n));
  }

  async closeAll(): Promise<void> {
    for (const [name, entry] of this.live) {
      if (entry.timer) clearTimeout(entry.timer);
      await entry.client.close();
      this.live.delete(name);
    }
  }
}

/** Só o que muda o processo que sobe; o tempo ocioso vale na próxima soltura. */
function fingerprint(cfg: McpServerConfig): string {
  return JSON.stringify([cfg.transport, cfg.command, cfg.env, cfg.url, cfg.headers]);
}

/**
 * Quatro caracteres por token e a regra de bolso dos tokenizadores BPE. Chamar
 * um contador de verdade exigiria saber o modelo antes de listar, e a diferenca
 * nao muda a decisao de marcar ou nao marcar a ferramenta.
 */
function estimateTokens(name: string, description: string | undefined, inputSchema: unknown): number {
  // O cliente MCP embrulha o schema em `jsonSchema()`, que guarda o original
  // em `.jsonSchema`. Ferramenta declarada de outro jeito cai no proprio valor.
  const raw = (inputSchema as { jsonSchema?: unknown } | undefined)?.jsonSchema ?? inputSchema;
  const payload = JSON.stringify({ name, description: description ?? "", schema: raw ?? {} });
  return Math.ceil(payload.length / 4);
}
