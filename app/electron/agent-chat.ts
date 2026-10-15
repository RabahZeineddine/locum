import { BrowserWindow } from "electron";
import { rodarPelaAssinatura } from "../src/agent-chat/assinatura.js";
import { ConversasDeAgent, type ModeloEscolhido } from "../src/agent-chat/conversas.js";
import { assertWithinBudget, recordSpend } from "../src/executor/budget.js";
import { buildRuntimes } from "../src/executor/build.js";
import { resolveModel } from "../src/providers/registry.js";
import { libraryService } from "../src/services/library-service.js";
import { machineId } from "../src/services/machine-service.js";
import { priceService } from "../src/services/price-service.js";
import { providerService } from "../src/services/provider-service.js";
import { settingsService } from "../src/services/settings-service.js";
import { CHAT_EVENT } from "./chat.js";
import { t } from "./i18n.js";

type EscolherModelo = (id: string) => Promise<ModeloEscolhido>;

/** O modelo do agent nesta máquina: o dele, ou o que a tabela de fallback manda no lugar. */
const escolherModelo: EscolherModelo = async (id) => {
  // A chave guardada no cofre entra antes de qualquer provedor ser consultado.
  await providerService.loadSecrets();
  const entradas = providerService.entries();
  const resolvido = resolveModel(id, await providerService.getFallbacks(machineId), entradas);
  if (resolvido.provider === "claude-code") return { via: "claude-code", modelo: resolvido.model };
  // O Codex não entrega texto aos pedaços nem ferramenta de permissão por chamada.
  if (resolvido.provider === "codex") throw new Error(t("agentChat.errors.codex"));
  const entrada = entradas[resolvido.provider];
  if (!entrada?.model) throw new Error(t("agentChat.errors.noApiModel", { provider: resolvido.provider }));
  return { via: "api", provedor: resolvido.provider, modelo: resolvido.model, model: entrada.model(resolvido.model) };
};

let modelo = escolherModelo;

/** Só a fumaça troca o modelo: ela não pode sair para a rede nem gastar assinatura. */
export function usarModeloDoAgentChat(outro: EscolherModelo | null): void {
  modelo = outro ?? escolherModelo;
}

/** O fluxo vai a todas as janelas: quem abriu a conversa pode ter trocado de tela ou de janela. */
function emitir(evento: unknown): void {
  for (const janela of BrowserWindow.getAllWindows()) {
    if (!janela.isDestroyed() && !janela.webContents.isDestroyed()) janela.webContents.send(CHAT_EVENT, evento);
  }
}

export const agentChat = new ConversasDeAgent({
  library: libraryService,
  mcp: async () => (await buildRuntimes()).mcp,
  modelo: (id) => modelo(id),
  settings: settingsService,
  orcamento: { checar: assertWithinBudget, gastar: recordSpend },
  preco: (provedor, nome) => priceService.priceFor(provedor, nome),
  assinatura: (pedido) => rodarPelaAssinatura(pedido, { mensagemSemClaude: t("assistant.status.noClaude") }),
  emitir,
  texto: (chave, variaveis) => t(chave, variaveis),
});
