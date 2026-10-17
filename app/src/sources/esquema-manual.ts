import type { EsquemaJson } from "../config/referencias.js";
import { CAMPOS_DO_LINK_DE_PR, CAMPOS_DO_PR } from "./esquema-github.js";

const { prsFalharam: _a, prsCortados: _b, prsLimite: _c, ...DO_LINK } = CAMPOS_DO_LINK_DE_PR;

/**
 * O evento que "Executar com" monta ao colar o link de um PR (evento-manual.ts):
 * o contexto do PR no formato do evento do Teams, sem conversa. Só o que
 * `doLink` emite: `prsFalharam`, `prsCortados` e `prsLimite` ficam de fora.
 */
export const ESQUEMA_DO_EVENTO_MANUAL: EsquemaJson = {
  type: "object",
  properties: {
    ...CAMPOS_DO_PR,
    ...DO_LINK,
    kind: { type: "string", description: "Always pr." },
    chatId: { type: "null", description: "There is no conversation." },
    messageId: { type: "null", description: "There is no message." },
    text: { type: "string", description: "Empty: there is no message text." },
    teamsAuthor: { type: "null", description: "There is no Teams author." },
    semConversa: { type: "boolean", description: "True: reactions and replies run as a rehearsal." },
  },
  required: ["kind", "text", "prOwner", "prRepo", "prNumber", "prLinks", "prs", "prsTexto", "semConversa", "repo", "owner", "repoName", "pull", "title", "diff", "url", "author"],
};
