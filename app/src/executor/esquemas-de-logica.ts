import type { EsquemaJson } from "../config/referencias.js";
import type { LogicStep } from "../config/types.js";

const DECISAO: EsquemaJson = {
  type: "object",
  properties: {
    branch: { type: "string", description: "The path taken; the steps with `when` compare it." },
    value: { description: "The value that was compared." },
  },
  required: ["branch", "value"],
};

/**
 * O formato da saída de cada operação de lógica, como `runLogic` (logic.ts)
 * devolve. Arquivo puro, para a tela e o MCP lerem sem puxar o executor.
 */
export const ESQUEMA_DA_LOGICA: Record<LogicStep["op"], EsquemaJson> = {
  if: DECISAO,
  switch: DECISAO,
  "json.parse": { description: "The JSON that was parsed; its shape is the text's." },
  "json.stringify": { type: "string", description: "The JSON as text." },
  text: { type: "string", description: "The assembled text." },
  "slack.mrkdwn": { type: "object", properties: { text: { type: "string", description: "Text in Slack formatting." } }, required: ["text"] },
  "slack.blocks": {
    type: "object",
    properties: { text: { type: "string" }, blocks: { type: "array", items: { type: "object" }, description: "Slack blocks." } },
    required: ["text", "blocks"],
  },
  "teams.card": {
    type: "object",
    properties: { text: { type: "string" }, card: { type: "object", description: "Adaptive Card." } },
    required: ["text", "card"],
  },
};

export const esquemaDaLogica = (op: string): EsquemaJson | undefined => (ESQUEMA_DA_LOGICA as Record<string, EsquemaJson>)[op];
