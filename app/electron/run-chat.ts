import { rodarPelaAssinatura } from "../src/agent-chat/assinatura.js";
import { ConversasDoRun } from "../src/agent-chat/conversa-do-run.js";
import { assertWithinBudget, recordSpend } from "../src/executor/budget.js";
import { buildRuntimes } from "../src/executor/build.js";
import { approvalService } from "../src/services/approval-service.js";
import { libraryService } from "../src/services/library-service.js";
import { passoAvulsoService } from "../src/services/passo-avulso-service.js";
import { priceService } from "../src/services/price-service.js";
import { runService } from "../src/services/run-service.js";
import { emitir, modeloDoChat } from "./agent-chat.js";
import { t } from "./i18n.js";

/** A conversa de cada run (ADR 0009): o mesmo motor do chat do agent, com o contexto do run. */
export const runChat = new ConversasDoRun({
  runs: runService,
  avulso: passoAvulsoService,
  aprovacoes: approvalService,
  library: libraryService,
  mcp: async () => (await buildRuntimes()).mcp,
  modelo: (id) => modeloDoChat(id),
  orcamento: { checar: assertWithinBudget, gastar: recordSpend },
  preco: (provedor, nome) => priceService.priceFor(provedor, nome),
  assinatura: (pedido) => rodarPelaAssinatura(pedido, { mensagemSemClaude: t("assistant.status.noClaude") }),
  emitir,
  texto: (chave, variaveis) => t(chave, variaveis),
});
