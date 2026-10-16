import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConversasDeAgent } from "../agent-chat/conversas.js";
import type { Cartao, EstadoDaConversa } from "../agent-chat/tipos.js";
import type { Ambiente } from "./ambiente.js";
import { exigirImpressao, impressaoDe } from "./impressao.js";
import { def } from "./tool-def.js";

/** Teto da espera de uma volta; passado dele a resposta sai com `respondendo` e se confere com agent_chat_state. */
const ESPERA_MAXIMA_MS = 120_000;
const INTERVALO_MS = 300;

const SEM_APP = "o chat de agent só existe com o aplicativo do Locum: suba o servidor MCP pelo binário do Locum (--mcp)";

function conversas(amb: Ambiente): ConversasDeAgent {
  if (amb.agentChat === null) throw new Error(SEM_APP);
  return amb.agentChat;
}

/** O que o hash do cartão cobre: a ferramenta, o servidor e os argumentos que vão rodar. */
const impressaoDoCartao = (c: Cartao): string => impressaoDe({ id: c.id, servidor: c.servidor, ferramenta: c.ferramenta, argumentos: c.argumentos });

/** O estado com o hash de cada cartão, para agent_chat_decide ficar amarrado ao que foi visto. */
function comHash(estado: EstadoDaConversa) {
  return { ...estado, falas: estado.falas.map((f) => ({ ...f, cartoes: f.cartoes.map((c) => ({ ...c, hash: impressaoDoCartao(c) })) })) };
}

/** A conversa não aceita mensagem agora: o motivo volta como erro, e não como uma resposta que parece ter corrido. */
function exigirLivre(estado: EstadoDaConversa): void {
  if (estado.respondendo) throw new Error("the agent is still answering (or another Locum process is in the middle of a message); wait and check agent_chat_state");
  if (parouNoCartao(estado)) throw new Error("a card is waiting for a decision: decide it with agent_chat_decide before sending another message");
}

const parouNoCartao = (e: EstadoDaConversa): boolean => e.falas.some((f) => f.cartoes.some((c) => c.estado === "pendente"));

/**
 * Espera a volta do agent terminar ou parar num cartão. No caminho do Claude
 * Code a promessa da volta só resolve depois do clique, então quem diz que
 * parou é o estado, e não ela.
 */
async function esperarVolta(chat: ConversasDeAgent, id: string, volta: Promise<void>) {
  let acabou = false;
  let erro: unknown;
  volta.then(() => (acabou = true), (e: unknown) => ((erro = e), (acabou = true)));
  const limite = Date.now() + ESPERA_MAXIMA_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, INTERVALO_MS));
    if (erro !== undefined) throw erro;
    const estado = await chat.estado(id);
    if (acabou || !estado.respondendo || parouNoCartao(estado) || Date.now() > limite) return comHash(estado);
  }
}

/**
 * O chat de cada agent da biblioteca, o mesmo da tela. A leitura do agent roda
 * direto; a escrita que a pessoa ligou na conexão para num cartão, e só roda
 * com agent_chat_decide.
 */
export function registerAgentChatTools(server: McpServer, amb: Ambiente): void {
  def(server, "agent_chat_state", "read",
    "The conversation with a library agent: messages, tool calls, the cards waiting for a decision (each with the hash agent_chat_decide asks for), and whether a turn is running.",
    { agentId: z.string().min(1) }, async ({ agentId }) => comHash(await conversas(amb).estado(agentId)));

  def(server, "agent_chat_send", "external",
    "Sends a message to a library agent and waits for its turn to end or to stop at a card (up to two minutes; then check with agent_chat_state). The agent runs on its model, spends its budget, and uses its read tools on the services it is connected to. A write it wants stops at a card for agent_chat_decide.",
    { agentId: z.string().min(1), text: z.string().min(1) },
    async ({ agentId, text }) => {
      const chat = conversas(amb);
      exigirLivre(await chat.estado(agentId));
      return esperarVolta(chat, agentId, chat.enviar(agentId, text));
    });

  def(server, "agent_chat_decide", "publish",
    "Decides a card of the agent chat. execute RUNS THE WRITE TOOL the agent asked for, with the arguments shown in the card, on the connected service in your name (a message, a comment, a ticket...). refuse runs nothing and tells the agent. hash is the one of the card in agent_chat_state, so the decision is tied to the server, tool and arguments that were seen. Waits for the turn to go on, like agent_chat_send.",
    {
      agentId: z.string().min(1),
      cardId: z.string().min(1),
      decision: z.enum(["executar", "recusar"]),
      hash: z.string().min(1).describe("the hash of the card as agent_chat_state or agent_chat_send showed it"),
    },
    async ({ agentId, cardId, decision, hash }) => {
      const chat = conversas(amb);
      const cartao = (await chat.estado(agentId)).falas.flatMap((f) => f.cartoes).find((c) => c.id === cardId && c.estado === "pendente");
      if (cartao === undefined) throw new Error(`no card ${cardId} is waiting for a decision in this conversation`);
      exigirImpressao(hash, impressaoDoCartao(cartao), "o cartão");
      return esperarVolta(chat, agentId, chat.decidir(agentId, cardId, decision));
    });

  def(server, "agent_chat_cancel", "write",
    "Stops the running turn of the agent chat; cards still waiting expire.",
    { agentId: z.string().min(1) },
    async ({ agentId }) => {
      conversas(amb).cancelar(agentId);
      return { agentId, cancelled: true };
    });

  def(server, "agent_chat_reset", "danger",
    "Starts the agent conversation over: forgets the messages, the Claude Code session and any waiting card.",
    { agentId: z.string().min(1) },
    async ({ agentId }) => {
      await conversas(amb).limpar(agentId);
      return { agentId, reset: true };
    });
}
