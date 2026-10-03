import type { ActionHandler } from "../approval/gate.js";
import { slackService, type SlackService } from "../services/slack-service.js";
import { postSlackReply, type SlackPostOptions } from "./post.js";
import { buildPostProposal, SlackPostProposal } from "./proposal.js";
import { findThread, type SlackThread } from "./thread.js";

export interface SlackPostHandlerOptions {
  slack?: SlackService;
  /** Como achar a thread no que já foi lido. Trocável para o exame. */
  lookup?: (server: string, channel: string, threadTs: string) => Promise<SlackThread | null>;
  post?: SlackPostOptions;
}

/**
 * O handler da ação `slack.post`.
 *
 * Nasce em `approve`: mensagem em canal aparece assinada por uma pessoa, e
 * quem lê não tem como saber que quem escreveu foi um agent. O automático
 * existe para o fluxo que a pessoa montou e quer rodando sozinho, e só uma
 * pessoa liga: versão escrita por agent volta para `approve` ao ser gravada.
 * Sem `draft` porque rascunho de mensagem de thread não existe no Slack, e
 * emular um publicando e apagando deixaria a notificação na tela de todo mundo.
 *
 * O handler não escreve prosa. O texto vem do passo de modelo anterior, e aqui
 * ele só ganha destino: canal do evento, servidor do cadastro, e a thread
 * conferida contra o que o Locum leu. Por isso a proposta é montada em
 * `propose`, antes de a pendência ser gravada: o que a fila mostra é exatamente
 * o texto que sairia.
 */
export function slackPostHandler(options: SlackPostHandlerOptions = {}): ActionHandler {
  const slack = options.slack ?? slackService;
  const lookup = options.lookup ?? findThread;

  return {
    modes: ["approve", "auto"],

    async propose(payload, target) {
      // `target` existe para o agent que aponta para um servidor específico. Sem
      // ele vale o cadastro da máquina, que é o caso comum: um Slack só.
      const server = target !== null && target.trim() !== "" ? target.trim() : (await slack.get()).server;
      if (server === null) {
        throw new Error("nenhum servidor MCP cadastrado como Slack para responder");
      }

      const parcial = buildPostProposal(payload, server);
      const thread = await lookup(server, parcial.channel, parcial.threadTs);
      if (thread === null) {
        throw new Error(
          `a thread ${parcial.threadTs} nao aparece no que o Locum leu do canal ${parcial.channel}`,
        );
      }

      return SlackPostProposal.parse({
        ...parcial,
        subject: thread.subject,
        permalink: thread.permalink,
      });
    },

    async publish(payload) {
      const proposta = SlackPostProposal.parse(payload);
      const watch = await slack.get();

      // A pendência pode ficar dias na fila, e nesse tempo alguém troca o
      // servidor de Slack cadastrado. Os nomes de argumento saem desse cadastro,
      // e mandá-los para outro servidor publicaria a resposta com o canal no
      // campo errado, ou em lugar nenhum.
      if (watch.server !== proposta.server) {
        throw new Error(
          `a resposta foi proposta para o servidor "${proposta.server}" e o cadastro agora e "${watch.server ?? "nenhum"}"`,
        );
      }

      await postSlackReply(proposta, watch, options.post);
    },
  };
}
