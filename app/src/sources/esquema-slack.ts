import type { EsquemaJson } from "../config/referencias.js";

const MENSAGEM: Record<string, EsquemaJson> = {
  channel: { type: "string", description: "Channel the message was posted in." },
  author: { type: ["string", "null"], description: "Who wrote it." },
  text: { type: "string", description: "The message text." },
  ts: { type: "string", description: "Slack timestamp of the message." },
  threadTs: { type: "string", description: "Thread the message belongs to (its own ts when it opens one)." },
  reply: { type: "boolean", description: "Whether it is a reply in a thread." },
  permalink: { type: ["string", "null"], description: "Address of the message, when the server gives one." },
  at: { type: ["string", "null"], description: "When the poll read the message." },
};

const DE_PR_NO_SLACK: Record<string, EsquemaJson> = {
  prOwner: { type: "string", description: "Owner of the pull request linked in the message." },
  prRepo: { type: "string", description: "Repository of the linked pull request." },
  prNumber: { type: "number", description: "Number of the linked pull request." },
};

/** Evento do gatilho `slack-channel` (slack.ts, `slackShape`). */
export const ESQUEMA_DO_EVENTO_DO_CANAL_DO_SLACK: EsquemaJson = {
  type: "object",
  properties: { repo: { type: "string" }, server: { type: "string" }, ...MENSAGEM, ...DE_PR_NO_SLACK },
  required: ["repo", "channel", "text", "ts", "threadTs", "reply"],
};

/** Evento do gatilho `slack-inbox` (slack-inbox.ts). */
export const ESQUEMA_DO_EVENTO_DA_CAIXA_DO_SLACK: EsquemaJson = {
  type: "object",
  properties: {
    repo: { type: "string" },
    server: { type: "string" },
    kind: { type: "string", enum: ["mention", "dm"], description: "mention or dm." },
    authorId: { type: ["string", "null"], description: "Slack id of who wrote it." },
    ...MENSAGEM,
  },
  required: ["repo", "kind", "channel", "text", "ts", "threadTs", "reply"],
};
