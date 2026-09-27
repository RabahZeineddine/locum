import type { WebContents } from "electron";
import { stepCountIs, streamText, type ModelMessage } from "ai";
import { buildProviders } from "../src/providers/registry.js";
import { compactarHistorico } from "../src/services/chat-history.js";
import { providerService } from "../src/services/provider-service.js";
import { settingsService } from "../src/services/settings-service.js";
import { chatTools } from "./chat-tools.js";
import { t } from "./i18n.js";

export const CHAT_EVENT = "chat:event";

export type ChatEvent =
  | { tipo: "texto"; delta: string }
  | { tipo: "ferramenta"; nome: string; entrada: unknown }
  | { tipo: "resultado"; nome: string }
  | { tipo: "fim"; motivo: string }
  | { tipo: "resumido" }
  | { tipo: "erro"; mensagem: string };

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
 * O runtime de assinatura fica de fora do assistente: ele sobe um processo por
 * chamada e nao entrega fluxo parcial, e conversa sem texto aparecendo vira
 * silencio de meio minuto.
 */
async function escolherModelo(): Promise<{ provedor: string; modelo: string } | null> {
  const guardado = await settingsService.get(CHAVE_DO_MODELO);
  if (!guardado) return null;

  const corte = guardado.indexOf("/");
  if (corte < 1) return null;
  const provedor = guardado.slice(0, corte);
  const modelo = guardado.slice(corte + 1);

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
export function promptDoSistema(context?: { initiative?: string }): string {
  const base = t("assistant.system");
  if (!context?.initiative) return base;
  return `${base}\n\n${t("assistant.systemInitiative", { slug: context.initiative })}`;
}

export class ChatSession {
  private historico: ModelMessage[] = [];
  private cancelar: AbortController | null = null;

  /** O que a janela precisa mostrar antes da primeira mensagem. */
  async status(): Promise<{ disponivel: boolean; modelo: string | null; motivo?: string }> {
    const guardado = await settingsService.get(CHAVE_DO_MODELO);
    if (!guardado) {
      return {
        disponivel: false,
        modelo: null,
        motivo: t("assistant.status.noModel"),
      };
    }
    const escolha = await escolherModelo();
    if (!escolha) {
      return {
        disponivel: false,
        modelo: guardado,
        motivo: t("assistant.status.providerUnavailable", { model: guardado }),
      };
    }
    return { disponivel: true, modelo: guardado };
  }

  /** Grava a escolha. A janela so oferece o que o catalogo do provedor devolveu. */
  async escolher(modelo: string): Promise<void> {
    await settingsService.set(CHAVE_DO_MODELO, modelo);
  }

  interromper(): void {
    this.cancelar?.abort();
    this.cancelar = null;
  }

  async enviar(texto: string, alvo: WebContents, context?: { initiative?: string }): Promise<void> {
    const escolha = await escolherModelo();
    if (!escolha) {
      const { motivo } = await this.status();
      const disponiveis = providerService
        .listProviders()
        .filter((p) => p.available && !p.subscription)
        .map((p) => p.name);
      emitir(alvo, {
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

    const entry = buildProviders()[escolha.provedor]!;
    this.historico.push({ role: "user", content: texto });
    // Guardado já enxuto, e não só enviado enxuto: o processo principal fica
    // de pé o dia inteiro e o histórico cheio viveria na memória dele.
    const { mensagens, resumido } = compactarHistorico(this.historico);
    this.historico = mensagens;
    if (resumido) emitir(alvo, { tipo: "resumido" });
    this.cancelar = new AbortController();

    try {
      const resultado = streamText({
        model: entry.model!(escolha.modelo),
        system: promptDoSistema(context),
        messages: this.historico,
        tools: chatTools(),
        stopWhen: stepCountIs(10),
        abortSignal: this.cancelar.signal,
      });

      for await (const parte of resultado.fullStream) {
        if (parte.type === "text-delta") emitir(alvo, { tipo: "texto", delta: parte.text });
        else if (parte.type === "tool-call")
          emitir(alvo, { tipo: "ferramenta", nome: parte.toolName, entrada: parte.input });
        else if (parte.type === "tool-result")
          emitir(alvo, { tipo: "resultado", nome: parte.toolName });
        else if (parte.type === "error")
          emitir(alvo, { tipo: "erro", mensagem: String(parte.error) });
      }

      this.historico.push(...(await resultado.response).messages);
      emitir(alvo, { tipo: "fim", motivo: await resultado.finishReason });
    } catch (err) {
      emitir(alvo, { tipo: "erro", mensagem: err instanceof Error ? err.message : String(err) });
    } finally {
      this.cancelar = null;
    }
  }
}

function emitir(alvo: WebContents, evento: ChatEvent): void {
  if (!alvo.isDestroyed()) alvo.send(CHAT_EVENT, evento);
}

export const chatSession = new ChatSession();
