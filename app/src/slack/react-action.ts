import { z } from "zod";
import type { ActionHandler } from "../approval/gate.js";
import { reacaoDoPasso } from "../reacao/passo.js";
import { slackService, type SlackService } from "../services/slack-service.js";
import { unwrap } from "../sources/mcp-poll.js";
import { callTool, type SlackPostOptions } from "./post.js";

/** Ferramentas do servidor de Slack que reagem, como o servidor de referência as chama. */
const FERRAMENTA_DE_POR = "slack_add_reaction";
const FERRAMENTA_DE_TIRAR = "slack_remove_reaction";

/** O Slack nomeia a reação; o emoji unicode das mais comuns vira o nome delas. */
const NOME_DO_EMOJI: Readonly<Record<string, string>> = {
  "👀": "eyes",
  "✅": "white_check_mark",
  "⚠️": "warning",
  "⚠": "warning",
  "💬": "speech_balloon",
  "👍": "+1",
  "👎": "-1",
  "❌": "x",
  "🚫": "no_entry_sign",
  "🎉": "tada",
  "🔍": "mag",
  "🙏": "pray",
  "🚀": "rocket",
};

/** `:eyes:`, `eyes` e 👀 dão `eyes`; um emoji que o Slack não nomeia aqui estoura. */
export function nomeDaReacaoNoSlack(emoji: string): string {
  const cru = emoji.trim();
  const mapeado = NOME_DO_EMOJI[cru];
  if (mapeado !== undefined) return mapeado;
  const nome = cru.replace(/^:|:$/g, "");
  if (!/^[\w+-]+$/.test(nome)) {
    throw new Error(`o Slack reage pelo nome do emoji (como "eyes"), e "${cru}" não tem nome conhecido`);
  }
  return nome;
}

/** O que fica gravado na pendência. */
export const SlackReactProposal = z.object({
  server: z.string().min(1),
  channel: z.string().min(1),
  ts: z.string().min(1),
  operacao: z.enum(["set", "unset"]),
  emoji: z.string().min(1),
  tirar: z.string().min(1).optional(),
});
export type SlackReactProposal = z.infer<typeof SlackReactProposal>;

const texto = (valor: unknown): string | null => (typeof valor === "string" && valor !== "" ? valor : null);

export interface SlackReactHandlerOptions {
  slack?: SlackService;
  post?: SlackPostOptions;
}

/**
 * O handler da ação `slack.react`, a irmã do `teams.react`.
 *
 * A mensagem é a do evento: o canal e o carimbo que a fonte do Slack gravou
 * (`slackChannel` e `slackTs` quando o evento ganhou o contexto de um PR, senão
 * `channel` e `ts`). A saída do modelo não troca nenhum dos dois.
 */
export function slackReactHandler(options: SlackReactHandlerOptions = {}): ActionHandler {
  const slack = options.slack ?? slackService;

  return {
    modes: ["approve", "auto"],

    async propose(payload, target) {
      const p = (payload ?? {}) as Record<string, unknown>;
      const channel = texto(p.slackChannel) ?? texto(p.channel);
      const ts = texto(p.slackTs) ?? texto(p.ts);
      if (channel === null || ts === null) {
        throw new Error("o passo de reação no Slack não recebeu um evento de mensagem do Slack");
      }
      const server = target !== null && target.trim() !== "" ? target.trim() : (await slack.get()).server;
      if (server === null) throw new Error("nenhum servidor MCP cadastrado como Slack para reagir");
      const reacao = reacaoDoPasso(payload);
      nomeDaReacaoNoSlack(reacao.emoji);
      if (reacao.tirar !== undefined) nomeDaReacaoNoSlack(reacao.tirar);
      return SlackReactProposal.parse({ server, channel, ts, ...reacao });
    },

    async publish(payload) {
      const r = SlackReactProposal.parse(payload);
      const chamar = async (ferramenta: string, emoji: string): Promise<void> => {
        const resposta = unwrap(
          await callTool(
            r.server,
            ferramenta,
            { channel_id: r.channel, timestamp: r.ts, name: nomeDaReacaoNoSlack(emoji) },
            options.post ?? {},
          ),
        ) as { ok?: unknown; error?: unknown } | null;
        // Pôr de novo ou tirar o que não está lá é o estado que já se queria.
        const jaNoEstado = resposta?.error === "already_reacted" || resposta?.error === "no_reaction";
        if (resposta !== null && typeof resposta === "object" && resposta.ok === false && !jaNoEstado) {
          throw new Error(`o Slack recusou a reação: ${typeof resposta.error === "string" ? resposta.error : "sem motivo"}`);
        }
      };
      if (r.operacao === "set" && r.tirar !== undefined) {
        await chamar(FERRAMENTA_DE_TIRAR, r.tirar).catch((err) => {
          console.error(`tirar ${r.tirar} no Slack falhou: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      await chamar(r.operacao === "set" ? FERRAMENTA_DE_POR : FERRAMENTA_DE_TIRAR, r.emoji);
    },
  };
}
