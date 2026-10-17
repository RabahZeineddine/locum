import type { EsquemaJson } from "../config/referencias.js";
import type { TriggerConfig } from "../config/types.js";
import { ESQUEMA_DO_EVENTO_DE_PR } from "./esquema-github.js";
import { ESQUEMA_DO_EVENTO_DA_CAIXA_DO_SLACK, ESQUEMA_DO_EVENTO_DO_CANAL_DO_SLACK } from "./esquema-slack.js";
import { esquemaDoEventoDoTeams } from "./esquema-teams.js";

/**
 * O esquema do evento que cada gatilho emite, ou `null` quando ele não emite
 * evento com formato. Quem lê (a tela, o MCP) não conhece gatilho nenhum: gatilho
 * novo declara o esquema aqui e o resto vem.
 *
 * Sem esquema, de propósito:
 * - `cron` e `schedule`: não há evento, o agent busca o próprio contexto;
 * - `webhook`: não há receptor que grave evento;
 * - `mcp-poll` genérico: o `item` é o que o servidor devolveu, sem formato nosso
 *   (só o que o Locum acrescenta tem esquema, o resto o último run mostra).
 */
export function esquemaDoEvento(config: TriggerConfig): EsquemaJson | null {
  switch (config.kind) {
    case "poll":
      return ESQUEMA_DO_EVENTO_DE_PR;
    case "teams-inbox":
      return esquemaDoEventoDoTeams({ prLinks: config.prLinks === true });
    case "slack-channel":
      return ESQUEMA_DO_EVENTO_DO_CANAL_DO_SLACK;
    case "slack-inbox":
      return ESQUEMA_DO_EVENTO_DA_CAIXA_DO_SLACK;
    case "mcp-poll":
      return {
        type: "object",
        properties: {
          repo: { type: "string", description: "Server and tool the event came from." },
          server: { type: "string", description: "Server the event came from." },
          tool: { type: "string", description: "Tool that was polled." },
          item: { description: "The item as the server returned it." },
          at: { type: ["string", "null"], description: "When the event was read." },
        },
        required: ["repo", "server", "tool", "item"],
      };
    case "manual":
      // "Executar com" cola um link de PR: o evento sai como o do Teams com link, sem conversa.
      return esquemaDoEventoDoTeams({ prLinks: true });
    case "cron":
    case "schedule":
    case "webhook":
      return null;
  }
}
