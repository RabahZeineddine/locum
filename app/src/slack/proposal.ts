import { z } from "zod";
import type { EsquemaJson } from "../config/referencias.js";
import { destinoParaFila, type AlvoResolvido } from "../acao/conversa.js";
import { DestinoNaFila } from "../acao/destino.js";

/**
 * A resposta que um passo de modelo escreve, e o que vira proposta de envio.
 *
 * A divisão é a mesma da proposta de tarefa e da de digest. O modelo escreve o
 * texto, e só o texto. Canal e servidor vêm do evento e do cadastro, que já
 * sabem de onde a conversa saiu; um modelo que também escolhesse o canal
 * responderia no lugar errado com a cara de quem foi respondido.
 *
 * A thread também vem do evento, e é conferida por `src/slack/thread.ts`
 * contra o que o Locum leu do canal: o modelo não a escreve nem a troca.
 */

/**
 * Onde o texto da resposta é cortado.
 *
 * O Slack aceita bem mais que isto numa mensagem só, mas mensagem de thread
 * que passa de alguns parágrafos não é lida: quem recebe rola a conversa no
 * celular. Estourar aqui é melhor que mandar um relatório para dentro de uma
 * conversa.
 */
const TETO_DE_TEXTO = 3000;

/** O que da pendência se edita: o texto, no mesmo teto que o handler aplica ao do modelo. */
export const CAMPOS_EDITAVEIS_DA_MENSAGEM: EsquemaJson = {
  type: "object",
  properties: { text: { type: "string", minLength: 1, maxLength: TETO_DE_TEXTO } },
  additionalProperties: false,
};

/** O que o passo de modelo devolve. Sem isto não há resposta para propor. */
export const SlackReply = z.object({
  text: z.string().trim().min(1).max(TETO_DE_TEXTO),
});
export type SlackReply = z.infer<typeof SlackReply>;

/**
 * O esquema de saída do passo de modelo, no formato que o runtime entende.
 *
 * Escrito à mão e não derivado do zod acima, pelo mesmo motivo das outras
 * propostas: o que vai para o provedor é JSON Schema puro.
 */
export const SLACK_REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: { type: "string" },
  },
} as const;

/** O que fica gravado na pendência, e o que a publicação vai receber. */
export const SlackPostProposal = z.object({
  /** O servidor MCP que responde pelo Slack, tal como cadastrado. */
  server: z.string().min(1),
  channel: z.string().min(1),
  /** Sem a thread, a mensagem abre uma conversa nova no canal. */
  threadTs: z.string().min(1).optional(),
  text: z.string().min(1),
  /** Para onde o passo mandou o texto, em dado: a Fila monta o texto. */
  destino: DestinoNaFila.optional(),
  /** A mensagem que abriu a thread, para a fila mostrar do que se trata. */
  subject: z.string(),
  permalink: z.string().nullable(),
});
export type SlackPostProposal = z.infer<typeof SlackPostProposal>;

/** Prefixo do `repo` que a fonte do Slack grava em cada evento. */
const PREFIXO = "slack/";

/**
 * De qual canal o evento veio.
 *
 * Sai do `repo`, e não de um campo próprio, porque `repo` é um dos poucos
 * campos do evento que o executor entrega ao passo de ação. A fonte do Slack
 * grava ali `slack/<canal>` justamente para que quem age saiba de onde a
 * conversa veio sem precisar do evento inteiro dentro da fila.
 */
export function channelOf(payload: unknown): string {
  const repo = (payload as { repo?: unknown } | null | undefined)?.repo;
  if (typeof repo !== "string" || !repo.startsWith(PREFIXO) || repo.length === PREFIXO.length) {
    throw new Error("o passo de resposta no Slack nao recebeu um evento de canal");
  }
  return repo.slice(PREFIXO.length);
}

/**
 * Monta a resposta a partir da saída do passo de modelo e do destino resolvido.
 *
 * O modelo escreve só o texto. Canal e thread vêm do destino resolvido, que
 * sai do evento (ou do valor fixo do passo). `subject` e `permalink` ficam
 * vazios aqui: quem os preenche é o handler, depois de achar a thread no que já
 * foi lido. Só o destino `evento` tem thread; `novo` e `fixo` abrem conversa nova.
 */
export function buildPostProposal(
  payload: unknown,
  server: string,
  alvo: AlvoResolvido,
): Omit<SlackPostProposal, "subject" | "permalink"> {
  if (payload === null || typeof payload !== "object") {
    throw new Error("o passo de acao do Slack recebeu uma saida que nao e objeto");
  }

  const resposta = SlackReply.safeParse(payload);
  if (!resposta.success) {
    const onde = resposta.error.issues[0];
    throw new Error(
      `o passo de modelo nao escreveu a resposta: ${onde?.path.join(".") ?? ""} ${onde?.message ?? ""}`.trim(),
    );
  }
  if (alvo.tipo === "evento" && alvo.mensagem === null) {
    throw new Error("o evento nao traz a mensagem do Slack a que responder");
  }

  return {
    server,
    channel: alvo.conversa,
    ...(alvo.tipo === "evento" && alvo.mensagem !== null ? { threadTs: alvo.mensagem } : {}),
    text: resposta.data.text,
    destino: destinoParaFila("slack", alvo, null),
  };
}
