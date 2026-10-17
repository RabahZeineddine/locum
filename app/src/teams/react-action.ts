import { z } from "zod";
import type { ActionHandler } from "../approval/gate.js";
import { exigirDestino } from "../acao/destino.js";
import { PARAMS_DE_REACAO_NO_PACOTE, reacaoDoPasso } from "../reacao/passo.js";
import { alvoDaReacao, reagirNoTeams, type TeamsReactionOptions } from "./reaction.js";

/** O que fica gravado na pendência: a mensagem, a reação e o que sai antes dela. */
export const TeamsReactProposal = z.object({
  operacao: z.enum(["set", "unset"]),
  emoji: z.string().min(1),
  tirar: z.string().min(1).optional(),
  alvo: z.discriminatedUnion("tipo", [
    z.object({
      tipo: z.literal("chat"),
      chatId: z.string().min(1),
      messageId: z.string().min(1),
      account: z.string().min(1).optional(),
    }),
    z.object({
      tipo: z.literal("canal"),
      teamId: z.string().min(1),
      channelId: z.string().min(1),
      messageId: z.string().min(1),
      replyToId: z.string().min(1).optional(),
      account: z.string().min(1).optional(),
    }),
  ]),
});
export type TeamsReactProposal = z.infer<typeof TeamsReactProposal>;

/**
 * O handler da ação `teams.react`.
 *
 * Reagir é falar em nome da pessoa, então nasce em `approve` como as outras
 * ações. O alvo é sempre a mensagem do evento (os campos `teams*` que a
 * varredura gravou, e que a saída do modelo não troca); o emoji, a operação e o
 * mapa por valor vêm dos `params` do passo. Nada reage fora de um passo.
 */
export function teamsReactHandler(options: TeamsReactionOptions = {}): ActionHandler {
  return {
    modes: ["approve", "auto"],
    paramsDoPacote: PARAMS_DE_REACAO_NO_PACOTE,

    async propose(payload) {
      // Reação só cai na mensagem do evento; outro destino é recusado.
      exigirDestino("teams.react", (payload as { destino?: unknown } | null)?.destino);
      const alvo = alvoDaReacao(payload);
      if (alvo === null) throw new Error("o passo de reação no Teams não recebeu um evento de conversa");
      return TeamsReactProposal.parse({ ...reacaoDoPasso(payload), alvo });
    },

    async publish(payload) {
      const { alvo, operacao, emoji, tirar } = TeamsReactProposal.parse(payload);
      if (operacao === "set" && tirar !== undefined && tirar !== emoji) {
        // Quem trocou a reação à mão já tirou a antiga: não ter o que tirar não
        // pode impedir a nova de entrar.
        await reagirNoTeams(alvo, "unset", tirar, options).catch((err) => {
          console.error(`tirar ${tirar} no Teams falhou: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      await reagirNoTeams(alvo, operacao, emoji, options);
    },
  };
}
