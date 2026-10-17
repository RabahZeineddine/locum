import { mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversarPeloClaude, type AbrirChat } from "../chat/claude-chat.js";
import { SERVIDOR_CONTA, type McpServerConfig } from "../config/types.js";
import { appHome } from "../db/path.js";
import { prefixoDoServidor } from "../runtimes/claude-account.js";
import { claudeBinary } from "../runtimes/claude-binary.js";
import { mcpConfigJson } from "../runtimes/claude-code.js";
import { mcpService } from "../services/mcp-service.js";
import type { Gasto, PedidoDaAssinatura } from "./nucleo.js";
import { abrirServidorDeAprovacao, APROVACAO_NO_CLAUDE, SERVIDOR_DE_APROVACAO } from "./servidor-de-aprovacao.js";
import { abrirServidorLocal, SERVIDOR_LOCAL } from "./servidor-local.js";

export interface DepsDaAssinatura {
  binario?: () => Promise<string | undefined>;
  configs?: () => Promise<McpServerConfig[]>;
  abrir?: AbrirChat;
  /** O texto de quando o Claude Code não está na máquina, no idioma da janela. */
  mensagemSemClaude: string;
}

/**
 * Uma volta do chat do agent pelo Claude Code da assinatura.
 *
 * Sobem só os servidores que o agent alcança, mais o de aprovação. A leitura
 * entra em `--allowedTools`; a escrita não, e por isso o Claude Code a leva à
 * ferramenta de permissão (`--permission-prompt-tool`), que espera o clique do
 * cartão. Sem ferramenta de arquivo: o agent age pelas conexões dele.
 */
export async function rodarPelaAssinatura(
  p: PedidoDaAssinatura,
  deps: DepsDaAssinatura,
): Promise<{ sessao: string | undefined; gasto: Gasto }> {
  const binario = await (deps.binario ?? (() => claudeBinary()))();
  if (binario === undefined) throw new Error(deps.mensagemSemClaude);

  const refs = [...p.leitura, ...p.confirmar];
  const nomes = new Set(refs.filter((r) => r.server !== SERVIDOR_CONTA).map((r) => r.server));
  const cadastrados = await (deps.configs ?? (() => mcpService.enabledConfigs()))();
  const servidores = cadastrados.filter((c) => nomes.has(c.name));

  // Os conectores da conta Claude não entram: para tê-los o CLI precisa carregar as
  // configurações da pessoa, e as regras `allow` delas liberariam escrita antes da
  // ferramenta de permissão. O chat roda isolado, só com os servidores do agent.
  const permitidas = [
    ...p.leitura.filter((t) => t.server !== SERVIDOR_CONTA).map((t) => `${prefixoDoServidor(t.server)}${t.tool}`),
    // As do Locum para a conversa não escrevem fora: a escrita delas vai à Fila (ADR 0009).
    ...p.locais.map((l) => `${prefixoDoServidor(SERVIDOR_LOCAL)}${l.nome}`),
  ];

  const cwd = join(appHome(), "chat-agents");
  mkdirSync(cwd, { recursive: true });
  const aprovacao = await abrirServidorDeAprovacao(p.aprovar);
  const locais = p.locais.length === 0 ? undefined : await abrirServidorLocal(p.locais, p.sinal);
  const pasta = await mkdtemp(join(tmpdir(), "locum-chat-agent-"));
  try {
    const config = JSON.parse(mcpConfigJson(servidores.map((c) => c.name), new Map(servidores.map((c) => [c.name, c])))) as {
      mcpServers: Record<string, unknown>;
    };
    config.mcpServers[SERVIDOR_DE_APROVACAO] = { type: "http", url: aprovacao.url, headers: { Authorization: `Bearer ${aprovacao.token}` } };
    if (locais !== undefined) config.mcpServers[SERVIDOR_LOCAL] = { type: "http", url: locais.url, headers: { Authorization: `Bearer ${locais.token}` } };
    // O token da volta e as credenciais dos servidores vão por arquivo, e não pela linha de comando: o `ps` mostra argumento.
    const mcpConfigPath = join(pasta, "mcp.json");
    await writeFile(mcpConfigPath, JSON.stringify(config), { mode: 0o600 });

    return await conversarPeloClaude(
      binario,
      {
        texto: p.texto,
        modelo: p.modelo,
        cwd,
        pastas: [],
        system: p.system,
        ...(p.sessao === undefined ? {} : { sessao: p.sessao }),
        mcpConfigPath,
        permitidas,
        conta: false,
        internas: [],
        maxTurns: p.maxSteps,
        aprovacaoPor: APROVACAO_NO_CLAUDE,
      },
      p.emitir,
      p.sinal,
      deps.abrir,
    );
  } finally {
    await aprovacao.fechar();
    await locais?.fechar();
    await rm(pasta, { recursive: true, force: true });
  }
}
