import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { SERVIDOR_CONTA } from "../config/types.js";
import type { McpToolInfo } from "../mcp/registry.js";
import { claudeBinary } from "./claude-binary.js";

export { SERVIDOR_CONTA };
import { ehLeitura } from "../config/leitura.js";
export { ehLeitura };

/**
 * O que a chamada carrega da configuração da pessoa quando o passo usa
 * ferramenta da conta Claude. Os conectores do claude.ai e os MCPs de plugin
 * só aparecem com `--setting-sources user` e sem `--strict-mcp-config`; o
 * resto do que vem junto é desligado aqui: hooks, CLAUDE.md e memória.
 */
export const CONFIG_ISOLADA = {
  disableAllHooks: true,
  claudeMdExcludes: ["**/CLAUDE.md", "**/CLAUDE.local.md", "**/.claude/rules/**"],
  autoMemoryEnabled: false,
};

/**
 * Flags que fecham o que a configuração da pessoa abriria. O modo de
 * permissão dela pode ser `auto`, que aprovaria ferramenta sozinho; aqui só
 * roda o que está em `--allowedTools`. Dos internos, só a busca de
 * ferramentas, sem a qual o Claude Code põe o schema de todos os conectores
 * no contexto e estoura o limite.
 */
export function flagsDaConta(opcoes: { internas?: string[]; ajustes?: Record<string, unknown> } = {}): string[] {
  return [
    "--setting-sources",
    "user",
    "--settings",
    JSON.stringify({ ...opcoes.ajustes, ...CONFIG_ISOLADA }),
    "--permission-mode",
    "dontAsk",
    "--tools",
    ["ToolSearch", ...(opcoes.internas ?? [])].join(","),
  ];
}

/** O nome com que o Claude Code prefixa as ferramentas de um servidor. */
export function prefixoDoServidor(servidor: string): string {
  return `mcp__${servidor.replace(/[^A-Za-z0-9_-]/g, "_")}__`;
}

export interface ServidorDaConta {
  name: string;
  status: string;
}

export interface FerramentasDaConta {
  servidores: ServidorDaConta[];
  ferramentas: McpToolInfo[];
}

interface Init {
  type: "system";
  subtype: "init";
  tools: string[];
  mcp_servers?: ServidorDaConta[];
}

/**
 * Monta o catálogo a partir do evento `init` do Claude Code. Fica de fora o
 * próprio Locum, que a pessoa pode ter registrado no Claude Code, e toda
 * ferramenta de escrita.
 */
export function catalogoDoInit(init: Init): FerramentasDaConta {
  const servidores = (init.mcp_servers ?? []).filter((s) => s.name !== "locum");
  const ferramentas: McpToolInfo[] = [];
  for (const nome of init.tools) {
    if (!nome.startsWith("mcp__") || nome.startsWith("mcp__locum__") || !ehLeitura(nome)) continue;
    const dono = servidores.find((s) => nome.startsWith(prefixoDoServidor(s.name)));
    ferramentas.push({
      name: nome,
      description: dono === undefined ? "" : `${dono.name}: ${nome.slice(prefixoDoServidor(dono.name).length)}`,
      estimatedTokens: 0,
    });
  }
  return { servidores, ferramentas };
}

export type Abrir = (comando: string, args: string[], cwd: string) => {
  linhas: AsyncIterable<string>;
  encerrar: () => void;
};

const abrirProcesso: Abrir = (comando, args, cwd) => {
  const filho = spawn(comando, args, { cwd, stdio: ["pipe", "pipe", "ignore"] });
  filho.stdin.end("ok");
  return { linhas: createInterface({ input: filho.stdout }), encerrar: () => filho.kill("SIGTERM") };
};

/**
 * O que a conta Claude oferece, sem pedir nada ao modelo: o Claude Code
 * anuncia as ferramentas no evento `init`, antes da primeira chamada, e o
 * processo é encerrado ali. Servidor que ainda conectava fica com status
 * `pending` e sem ferramentas; listar de novo depois resolve.
 */
export class ClaudeAccountService {
  private cache: { em: number; valor: FerramentasDaConta } | null = null;

  constructor(
    private binario: () => Promise<string | undefined> = () => claudeBinary(),
    private abrir: Abrir = abrirProcesso,
    private validade = 10 * 60 * 1000,
  ) {}

  async disponivel(): Promise<boolean> {
    return (await this.binario()) !== undefined;
  }

  async listar(renovar = false): Promise<FerramentasDaConta> {
    if (!renovar && this.cache !== null && Date.now() - this.cache.em < this.validade) return this.cache.valor;
    const comando = await this.binario();
    if (comando === undefined) return { servidores: [], ferramentas: [] };

    const pasta = await mkdtemp(join(tmpdir(), "locum-conta-"));
    const processo = this.abrir(
      comando,
      ["-p", "--model", "haiku", "--output-format", "stream-json", "--verbose", "--no-session-persistence", ...flagsDaConta()],
      pasta,
    );
    try {
      for await (const linha of processo.linhas) {
        let evento: unknown;
        try {
          evento = JSON.parse(linha);
        } catch {
          continue;
        }
        const e = evento as Partial<Init>;
        if (e.type === "system" && e.subtype === "init" && Array.isArray(e.tools)) {
          const valor = catalogoDoInit(e as Init);
          this.cache = { em: Date.now(), valor };
          return valor;
        }
      }
      throw new Error("o Claude Code saiu sem anunciar as ferramentas");
    } finally {
      processo.encerrar();
      await rm(pasta, { recursive: true, force: true });
    }
  }

  async tools(): Promise<McpToolInfo[]> {
    return (await this.listar()).ferramentas;
  }
}

export const claudeAccountService = new ClaudeAccountService();

/**
 * Separa as ferramentas da conta Claude das que o registro do Locum sobe. As
 * da conta só valem no runtime do Claude Code: com outro modelo o passo
 * falha dizendo por quê, em vez de rodar sem elas.
 */
export function separarDaConta<T extends { server: string; tool: string }>(
  refs: readonly T[],
  runtimeId: string,
): { doLocum: T[]; daConta: string[] } {
  const daConta = refs.filter((r) => r.server === SERVIDOR_CONTA).map((r) => r.tool);
  if (daConta.length > 0 && runtimeId !== "claude-code") {
    throw new Error("ferramenta da conta Claude só roda com modelo do Claude Code (assinatura)");
  }
  return { doLocum: refs.filter((r) => r.server !== SERVIDOR_CONTA), daConta };
}

/** Recusa ao gravar, para o erro sair na hora e não no primeiro run. */
export function recusarEscritaDaConta(refs: readonly { server: string; tool: string }[]): void {
  const escrita = refs.filter((r) => r.server === SERVIDOR_CONTA && !ehLeitura(r.tool)).map((r) => r.tool);
  if (escrita.length > 0) {
    throw new Error(
      `${[...new Set(escrita)].join(", ")} escreve pela conta Claude; passo de modelo só lê. Escrita externa vai como passo de ação, pela fila de aprovação.`,
    );
  }
}
