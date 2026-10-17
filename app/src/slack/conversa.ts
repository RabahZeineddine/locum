import type { AdaptadorDeConversa } from "../acao/conversa.js";
import { channelOf } from "./proposal.js";

/**
 * O adaptador do Slack: o evento diz o canal pelo `repo` (`slack/<canal>`) e o
 * fio pelo carimbo da thread (ou da própria mensagem); o destino fixo é o id do
 * canal. O executor só entrega aqui os campos do evento: o que o modelo escreveu
 * com esses nomes é apagado antes.
 */
export const adaptadorDoSlack: AdaptadorDeConversa = {
  app: "slack",
  enderecoDoEvento(payload) {
    const p = (payload ?? {}) as { threadTs?: unknown; ts?: unknown };
    const fio = [p.threadTs, p.ts].find((v): v is string => typeof v === "string" && v !== "");
    return { conversa: channelOf(payload), mensagem: fio ?? null };
  },
  validarRef(ref) {
    if (!/^[A-Za-z0-9_-]+$/.test(ref)) throw new Error(`"${ref}" não é um canal do Slack`);
  },
  descreverRef: (ref) => `Canal ${ref}`,
};
