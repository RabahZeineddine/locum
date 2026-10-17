import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConversasDoRun } from "../agent-chat/conversa-do-run.js";
import type { EstadoDaConversa } from "../agent-chat/tipos.js";
import type { Ambiente } from "./ambiente.js";
import { def } from "./tool-def.js";

/** Teto da espera de uma volta; passado dele a resposta sai com `respondendo` e se confere com run_chat_state. */
const ESPERA_MAXIMA_MS = 120_000;
const INTERVALO_MS = 300;

const SEM_APP = "a conversa do run só existe com o aplicativo do Locum: suba o servidor MCP pelo binário do Locum (--mcp)";

function conversas(amb: Ambiente): ConversasDoRun {
  if (amb.runChat === null) throw new Error(SEM_APP);
  return amb.runChat;
}

/** A conversa não aceita mensagem agora: o motivo volta como erro, e não como uma resposta que parece ter corrido. */
function exigirLivre(estado: EstadoDaConversa): void {
  if (estado.respondendo) throw new Error("the run conversation is still answering (or another Locum process is in the middle of a message); wait and check run_chat_state");
}

/** Espera a volta terminar. A conversa do run não tem cartão: o que ela propõe vai para a Fila. */
async function esperarVolta(chat: ConversasDoRun, runId: string, volta: Promise<void>): Promise<EstadoDaConversa> {
  let acabou = false;
  let erro: unknown;
  volta.then(() => (acabou = true), (e: unknown) => ((erro = e), (acabou = true)));
  const limite = Date.now() + ESPERA_MAXIMA_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, INTERVALO_MS));
    if (erro !== undefined) throw erro;
    const estado = await chat.estado(runId);
    if (acabou || !estado.respondendo || Date.now() > limite) return estado;
  }
}

/**
 * A conversa de um run que já rodou, a mesma da tela (ADR 0009). O modelo lê o run e age
 * só por mecanismos que já existem: propõe ação avulsa (vai para a Fila), reexecuta um
 * passo com instrução. Nada é publicado por ela.
 */
export function registerRunChatTools(server: McpServer, amb: Ambiente): void {
  def(server, "run_chat_state", "read",
    "The conversation about a run that already ran: messages, tool calls, who is answering (an agent or a model, and whether that is the default: the agent of the run's first model step, or its model), the context size ceiling and what it cut, what the conversation spent, whether the run's automation is archived (then it only reads), and whether a turn is running.",
    { runId: z.string().min(1) }, async ({ runId }) => conversas(amb).estado(runId));

  def(server, "run_chat_send", "external",
    "Sends a message to the conversation about a run and waits for the turn to end (up to two minutes; then check with run_chat_state). The model sees the event, each step output and the pending approvals, and can only read the run, propose a standalone action (it lands in the approval queue, nothing is published) and re-run a model step with an instruction. It spends the budget of the automation and, when an agent answers, of that agent.",
    { runId: z.string().min(1), text: z.string().min(1) },
    async ({ runId, text }) => {
      const chat = conversas(amb);
      exigirLivre(await chat.estado(runId));
      return esperarVolta(chat, runId, chat.enviar(runId, text));
    });

  def(server, "run_chat_cancel", "write",
    "Stops the running turn of the run conversation.",
    { runId: z.string().min(1) },
    async ({ runId }) => {
      conversas(amb).cancelar(runId);
      return { runId, cancelled: true };
    });

  def(server, "run_chat_reset", "danger",
    "Starts the run conversation over: forgets the messages and the Claude Code session. The agent or model chosen stays.",
    { runId: z.string().min(1) },
    async ({ runId }) => {
      await conversas(amb).limpar(runId);
      return { runId, reset: true };
    });

  def(server, "run_chat_set_model", "write",
    "Chooses who answers the run conversation: a library agent (agentId) or a model (model, as provider/name). With neither, it goes back to the default: the agent of the run's first model step, or its model. Refused while a turn is running.",
    {
      runId: z.string().min(1),
      agentId: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
    },
    async ({ runId, agentId, model }) => {
      if (agentId !== undefined && model !== undefined) throw new Error("choose either agentId or model, not both");
      await conversas(amb).definirAlvo(runId, agentId !== undefined ? { agent: agentId } : model !== undefined ? { modelo: model } : null);
      return conversas(amb).estado(runId);
    });
}
