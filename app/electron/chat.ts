import type { WebContents } from "electron";
import { stepCountIs, streamText, type ModelMessage } from "ai";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversarPeloClaude, type EventoDoChat } from "../src/chat/claude-chat.js";
import type { McpServerConfig } from "../src/config/types.js";
import { appHome } from "../src/db/path.js";
import { buildProviders, claudeCodeAvailable } from "../src/providers/registry.js";
import { claudeAccountService, ehLeitura, prefixoDoServidor } from "../src/runtimes/claude-account.js";
import { claudeBinary } from "../src/runtimes/claude-binary.js";
import { mcpConfigJson } from "../src/runtimes/claude-code.js";
import { initiativeService } from "../src/services/initiative-service.js";
import { mcpService } from "../src/services/mcp-service.js";
import { sessionService } from "../src/services/session-service.js";
import { compactarHistorico } from "../src/services/chat-history.js";
import { providerService } from "../src/services/provider-service.js";
import { settingsService } from "../src/services/settings-service.js";
import { chatTools } from "./chat-tools.js";
import { t } from "./i18n.js";

export const CHAT_EVENT = "chat:event";

/** Cada evento diz de qual conversa é: o painel e a aba da iniciativa escutam o mesmo canal. */
export type ChatEvent = EventoDoChat & { chave: string };

/** Uma fala como a tela mostra, guardada para a conversa voltar ao reabrir. */
export interface Fala {
  de: "user" | "assistant";
  texto: string;
  ferramentas: string[];
}

/** Quantas falas ficam guardadas por conversa. O Claude Code guarda a conversa inteira. */
const FALAS_GUARDADAS = 200;

/** A conversa da iniciativa, ou a geral, fora de iniciativa. */
export function chaveDoChat(context?: { initiative?: string }): string {
  return context?.initiative ?? "geral";
}

/** Onde a escolha do modelo do assistente fica guardada. */
export const CHAVE_DO_MODELO = "chat.model";

/**
 * O modelo do assistente e escolhido em Configuracao, no formato
 * `provedor/modelo`, a partir do catalogo que o proprio provedor publica.
 *
 * Nao ha lista de preferencia no codigo, e isso e decisao, nao falta. Um
 * gateway expoe o catalogo que a organizacao dele decidiu, entao id chutado
 * aqui quebra na primeira chamada e acusa credencial errada quando o problema
 * era o nome do modelo.
 *
 * O Claude Code da assinatura também responde: com `--include-partial-messages`
 * o texto chega aos pedaços, e `--resume` continua a conversa. O Codex fica de
 * fora, porque não entrega fluxo parcial e conversa sem texto aparecendo vira
 * silêncio de meio minuto.
 */
async function escolherModelo(): Promise<{ provedor: string; modelo: string } | null> {
  // Sem escolha, e com Claude Code na máquina, a assinatura responde: quem
  // não tem chave de API nenhuma ainda conversa.
  const guardado = (await settingsService.get(CHAVE_DO_MODELO)) ?? (claudeCodeAvailable() ? "claude-code/sonnet" : null);
  if (!guardado) return null;

  const corte = guardado.indexOf("/");
  if (corte < 1) return null;
  const provedor = guardado.slice(0, corte);
  const modelo = guardado.slice(corte + 1);

  if (provedor === "claude-code") return claudeCodeAvailable() ? { provedor, modelo } : null;
  const entry = buildProviders()[provedor];
  if (!entry?.model || !entry.available()) return null;
  return { provedor, modelo };
}

/**
 * O prompt de sistema do assistente.
 *
 * Ele é texto de produto e não constante de código, e por isso mora no
 * dicionário: a linha que manda responder em português é justamente o que
 * precisa mudar quando a janela está em inglês, e deixá-la aqui faria o
 * assistente responder num idioma e a tela em volta dele em outro.
 *
 * Lido a cada envio, e não uma vez por subida: o idioma do processo principal
 * pode ter mudado desde que este módulo carregou.
 */
export function promptDoSistema(context?: { initiative?: string; pasta?: string }): string {
  const base = t("assistant.system");
  if (!context?.initiative) return base;
  const partes = [base, t("assistant.systemInitiative", { slug: context.initiative })];
  if (context.pasta) partes.push(t("assistant.systemInitiativeFolder", { folder: context.pasta }));
  return partes.join("\n\n");
}

/**
 * O próprio Locum como servidor MCP do chat: o mesmo binário, com `--mcp`. O
 * comando vem do processo principal na subida, porque depende de o app estar
 * empacotado, e este módulo não importa o `app` do Electron para continuar
 * testável fora dele.
 */
let comandoDoLocum: string[] | null = null;
export function usarComandoDoLocum(comando: string[]): void {
  comandoDoLocum = comando;
}
function servidorDoLocum(): McpServerConfig | null {
  if (comandoDoLocum === null) return null;
  return { name: "locum-chat", transport: "stdio", command: comandoDoLocum, scope: "write", idleTimeoutMs: 300_000 };
}

/** Ferramentas de leitura de um servidor do Locum, guardadas por 10 min: listar sobe o servidor. */
const leiturasPorServidor = new Map<string, { em: number; nomes: string[] }>();
async function leiturasDe(cfg: McpServerConfig): Promise<string[]> {
  // Servidor só de leitura entra inteiro, sem precisar subir para listar.
  if (cfg.scope === "read") return [`mcp__${cfg.name}`];
  const guardado = leiturasPorServidor.get(cfg.name);
  if (guardado && Date.now() - guardado.em < 10 * 60 * 1000) return guardado.nomes;
  const nomes = (await mcpService.listTools(cfg.name).catch(() => []))
    .map((f) => f.name)
    .filter((nome) => ehLeitura(nome))
    .map((nome) => `${prefixoDoServidor(cfg.name)}${nome}`);
  leiturasPorServidor.set(cfg.name, { em: Date.now(), nomes });
  return nomes;
}

export class ChatSession {
  private historicos = new Map<string, ModelMessage[]>();
  private cancelar = new Map<string, AbortController>();

  /** O que a janela precisa mostrar antes da primeira mensagem. */
  async status(): Promise<{ disponivel: boolean; modelo: string | null; motivo?: string }> {
    const escolha = await escolherModelo();
    if (escolha) return { disponivel: true, modelo: `${escolha.provedor}/${escolha.modelo}` };
    const guardado = await settingsService.get(CHAVE_DO_MODELO);
    if (!guardado) return { disponivel: false, modelo: null, motivo: t("assistant.status.noModel") };
    return {
      disponivel: false,
      modelo: guardado,
      motivo: t("assistant.status.providerUnavailable", { model: guardado }),
    };
  }

  /** Grava a escolha. A janela so oferece o que o catalogo do provedor devolveu. */
  async escolher(modelo: string): Promise<void> {
    await settingsService.set(CHAVE_DO_MODELO, modelo);
  }

  interromper(context?: { initiative?: string }): void {
    if (context === undefined) {
      for (const c of this.cancelar.values()) c.abort();
      this.cancelar.clear();
      return;
    }
    const chave = chaveDoChat(context);
    this.cancelar.get(chave)?.abort();
    this.cancelar.delete(chave);
  }

  /** As falas guardadas da conversa, para a tela reabrir onde parou. */
  async falas(context?: { initiative?: string }): Promise<Fala[]> {
    const bruto = await settingsService.get(`chat.falas.${chaveDoChat(context)}`);
    if (!bruto) return [];
    try {
      return JSON.parse(bruto) as Fala[];
    } catch {
      return [];
    }
  }

  /** Começa a conversa do zero: esquece as falas e a sessão do Claude Code. */
  async limpar(context?: { initiative?: string }): Promise<void> {
    const chave = chaveDoChat(context);
    this.historicos.delete(chave);
    await settingsService.set(`chat.falas.${chave}`, "[]");
    await settingsService.set(`chat.sessao.${chave}`, "");
  }

  private async guardar(chave: string, novas: Fala[]): Promise<void> {
    const falas = [...(await this.falas(chave === "geral" ? undefined : { initiative: chave })), ...novas];
    await settingsService.set(`chat.falas.${chave}`, JSON.stringify(falas.slice(-FALAS_GUARDADAS)));
  }

  async enviar(texto: string, alvo: WebContents, context?: { initiative?: string }): Promise<void> {
    const chave = chaveDoChat(context);
    const sair = (evento: EventoDoChat): void => emitir(alvo, { ...evento, chave });
    const escolha = await escolherModelo();
    if (!escolha) {
      const { motivo } = await this.status();
      const disponiveis = providerService
        .listProviders()
        .filter((p) => p.available && !p.subscription)
        .map((p) => p.name);
      sair({
        tipo: "erro",
        mensagem:
          disponiveis.length > 0
            ? t("assistant.status.withProviders", {
                providers: disponiveis.join(", "),
                reason: motivo,
              })
            : t("assistant.status.withoutProviders", { reason: motivo }),
      });
      return;
    }

    this.cancelar.get(chave)?.abort();
    const controle = new AbortController();
    this.cancelar.set(chave, controle);
    const resposta: Fala = { de: "assistant", texto: "", ferramentas: [] };
    const acompanhar = (evento: EventoDoChat): void => {
      if (evento.tipo === "texto") resposta.texto += evento.delta;
      else if (evento.tipo === "ferramenta") resposta.ferramentas.push(evento.nome);
      else if (evento.tipo === "erro") resposta.texto += `\n\n[${evento.mensagem}]`;
      sair(evento);
    };

    try {
      if (escolha.provedor === "claude-code") await this.pelaAssinatura(chave, texto, escolha.modelo, acompanhar, controle.signal, context);
      else await this.pelaApi(chave, texto, escolha, acompanhar, controle.signal, context);
    } catch (err) {
      acompanhar({ tipo: "erro", mensagem: err instanceof Error ? err.message : String(err) });
    } finally {
      if (this.cancelar.get(chave) === controle) this.cancelar.delete(chave);
      await this.guardar(chave, [{ de: "user", texto, ferramentas: [] }, resposta]);
    }
  }

  /**
   * Pelo Claude Code da assinatura. A conversa continua pela sessão dele
   * (`--resume`), na pasta da iniciativa: o repositório do workspace quando
   * há um, e a pasta de contexto como leitura a mais. Entram o próprio Locum,
   * os servidores da iniciativa e os conectores da conta, todos só leitura,
   * fora o Locum, cuja escrita é configuração dele mesmo.
   */
  private async pelaAssinatura(
    chave: string,
    texto: string,
    modelo: string,
    emitirEvento: (e: EventoDoChat) => void,
    sinal: AbortSignal,
    context?: { initiative?: string },
  ): Promise<void> {
    const binario = await claudeBinary();
    if (binario === undefined) throw new Error(t("assistant.status.noClaude"));

    let cwd = join(appHome(), "chat");
    const pastas: string[] = [];
    let negar: string[] | undefined;
    const locum = servidorDoLocum();
    const servidores: McpServerConfig[] = locum === null ? [] : [locum];
    if (context?.initiative) {
      const plano = await sessionService.plan(context.initiative);
      cwd = plano.cwd;
      if (plano.folder !== cwd) pastas.push(plano.folder);
      negar = (plano.settings as { permissions?: { deny?: string[] } }).permissions?.deny;
      const detalhe = await initiativeService.detail(context.initiative);
      const daIniciativa = new Set(detalhe?.servers ?? []);
      servidores.push(...(await mcpService.enabledConfigs()).filter((c) => daIniciativa.has(c.name)));
    }
    mkdirSync(cwd, { recursive: true });

    const permitidas = locum === null ? [] : ["mcp__locum-chat"];
    for (const cfg of servidores) if (cfg !== locum) permitidas.push(...(await leiturasDe(cfg)));
    const conta = (await claudeAccountService.tools().catch(() => [])).map((f) => f.name);
    permitidas.push(...conta);

    const pasta = await mkdtemp(join(tmpdir(), "locum-chat-"));
    try {
      const mcpConfigPath = join(pasta, "mcp.json");
      await writeFile(mcpConfigPath, mcpConfigJson(servidores.map((c) => c.name), new Map(servidores.map((c) => [c.name, c]))), { mode: 0o600 });
      const sessao = (await settingsService.get(`chat.sessao.${chave}`)) || undefined;
      const { sessao: nova } = await conversarPeloClaude(
        binario,
        {
          texto,
          modelo,
          cwd,
          pastas,
          system: promptDoSistema({ ...context, ...(pastas[0] ? { pasta: pastas[0] } : {}) }),
          ...(sessao ? { sessao } : {}),
          mcpConfigPath,
          permitidas,
          conta: conta.length > 0,
          ...(negar ? { negar } : {}),
        },
        emitirEvento,
        sinal,
      );
      if (nova) await settingsService.set(`chat.sessao.${chave}`, nova);
    } finally {
      await rm(pasta, { recursive: true, force: true });
    }
  }

  /** Por modelo de API, com o catálogo de ferramentas escrito à mão do assistente. */
  private async pelaApi(
    chave: string,
    texto: string,
    escolha: { provedor: string; modelo: string },
    emitirEvento: (e: EventoDoChat) => void,
    sinal: AbortSignal,
    context?: { initiative?: string },
  ): Promise<void> {
    const entry = buildProviders()[escolha.provedor]!;
    const historico = this.historicos.get(chave) ?? [];
    historico.push({ role: "user", content: texto });
    // Guardado já enxuto, e não só enviado enxuto: o processo principal fica
    // de pé o dia inteiro e o histórico cheio viveria na memória dele.
    const { mensagens, resumido } = compactarHistorico(historico);
    this.historicos.set(chave, mensagens);
    if (resumido) emitirEvento({ tipo: "resumido" });

    const resultado = streamText({
      model: entry.model!(escolha.modelo),
      system: promptDoSistema(context),
      messages: mensagens,
      tools: chatTools(),
      stopWhen: stepCountIs(10),
      abortSignal: sinal,
    });

    for await (const parte of resultado.fullStream) {
      if (parte.type === "text-delta") emitirEvento({ tipo: "texto", delta: parte.text });
      else if (parte.type === "tool-call") emitirEvento({ tipo: "ferramenta", nome: parte.toolName, entrada: parte.input });
      else if (parte.type === "tool-result") emitirEvento({ tipo: "resultado", nome: parte.toolName });
      else if (parte.type === "error") emitirEvento({ tipo: "erro", mensagem: String(parte.error) });
    }

    mensagens.push(...(await resultado.response).messages);
    emitirEvento({ tipo: "fim", motivo: await resultado.finishReason });
  }
}

function emitir(alvo: WebContents, evento: ChatEvent): void {
  if (!alvo.isDestroyed()) alvo.send(CHAT_EVENT, evento);
}

export const chatSession = new ChatSession();
