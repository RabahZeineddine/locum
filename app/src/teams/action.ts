import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ActionHandler } from "../approval/gate.js";
import { db as defaultDb, schema } from "../db/index.js";
import { mcpOAuthService } from "../services/mcp-oauth-service.js";
import { GRAPH_URL, TEAMS_SERVER } from "../services/teams-app.js";
import { TEAMS_SOURCE } from "../sources/teams-inbox.js";

type Db = typeof defaultDb;

/** Mesmo teto e mesma razão da resposta no Slack: conversa não é relatório. */
const TETO_DE_TEXTO = 3000;

/** Quantos eventos do Teams a conferência lê antes de desistir. */
const TETO_DE_LEITURA = 500;

/** O que o passo de modelo devolve: só o texto. A conversa vem do evento. */
export const TeamsReply = z.object({
  text: z.string().trim().min(1).max(TETO_DE_TEXTO),
});

/** O esquema de saída do passo de modelo, em JSON Schema puro. */
export const TEAMS_REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: { type: "string" },
  },
} as const;

/** O que fica gravado na pendência, e o que a publicação vai receber. */
export const TeamsPostProposal = z.object({
  chatId: z.string().min(1),
  text: z.string().min(1),
  /** A última mensagem lida da conversa, para a fila mostrar a que se responde. */
  subject: z.string(),
  author: z.string().nullable(),
  webUrl: z.string().nullable(),
});
export type TeamsPostProposal = z.infer<typeof TeamsPostProposal>;

/** Prefixo do `repo` que a caixa do Teams grava em cada evento. */
const PREFIXO = "teams/";

/** De qual conversa o evento veio, pelo `repo`, como no Slack. */
export function chatOf(payload: unknown): string {
  const repo = (payload as { repo?: unknown } | null | undefined)?.repo;
  if (typeof repo !== "string" || !repo.startsWith(PREFIXO) || repo.length === PREFIXO.length) {
    throw new Error("o passo de resposta no Teams nao recebeu um evento de conversa");
  }
  return repo.slice(PREFIXO.length);
}

export interface TeamsPostHandlerOptions {
  db?: Db;
  token?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
  graphUrl?: string;
}

/**
 * O handler da ação `teams.post`.
 *
 * Nasce e permanece em `approve` pelo mesmo motivo do `slack.post`: a mensagem
 * sai com o nome da pessoa, e quem lê não tem como saber que foi um agent que
 * escreveu. A trava é de código, então trocar o modo na spec faz o passo
 * falhar em vez de publicar. Sem `draft` porque o Graph não tem rascunho de
 * mensagem de chat.
 *
 * A conversa vem do evento e é conferida contra o que o Locum leu: um
 * identificador que nunca passou pela caixa não acha nada, e o passo falha
 * antes de virar pendência.
 */
export function teamsPostHandler(options: TeamsPostHandlerOptions = {}): ActionHandler {
  const db = options.db ?? defaultDb;
  const token = options.token ?? (() => mcpOAuthService.accessToken(TEAMS_SERVER));
  const fetchFn = options.fetchFn ?? fetch;
  const graphUrl = options.graphUrl ?? GRAPH_URL;

  return {
    modes: ["approve"],

    async propose(payload) {
      if (payload === null || typeof payload !== "object") {
        throw new Error("o passo de acao do Teams recebeu uma saida que nao e objeto");
      }
      const chatId = chatOf(payload);
      const resposta = TeamsReply.safeParse(payload);
      if (!resposta.success) {
        const onde = resposta.error.issues[0];
        throw new Error(
          `o passo de modelo nao escreveu a resposta: ${onde?.path.join(".") ?? ""} ${onde?.message ?? ""}`.trim(),
        );
      }

      const lida = await ultimaLida(db, chatId);
      if (lida === null) {
        throw new Error(`a conversa ${chatId} nao aparece no que o Locum leu do Teams`);
      }
      return TeamsPostProposal.parse({ chatId, text: resposta.data.text, ...lida });
    },

    async publish(payload) {
      const proposta = TeamsPostProposal.parse(payload);
      const valor = await token();
      if (valor === null) throw new Error("o Teams não está conectado");

      const resposta = await fetchFn(`${graphUrl}/chats/${encodeURIComponent(proposta.chatId)}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${valor}`, "Content-Type": "application/json" },
        body: JSON.stringify({ body: { contentType: "text", content: proposta.text } }),
      });
      // Falha precisa estourar: a gate fecha a pendência quando `publish`
      // volta, e fechar a de uma resposta que não saiu esconderia a falha.
      if (!resposta.ok) {
        const corpo = (await resposta.json().catch(() => ({}))) as { error?: { code?: unknown } };
        const codigo = typeof corpo.error?.code === "string" ? `: ${corpo.error.code}` : "";
        throw new Error(`Graph recusou a mensagem com ${resposta.status}${codigo}`);
      }
    },
  };
}

/** A mensagem mais recente lida da conversa, ou nulo se ela nunca foi lida. */
async function ultimaLida(
  db: Db,
  chatId: string,
): Promise<{ subject: string; author: string | null; webUrl: string | null } | null> {
  const linhas = await db
    .select({ payload: schema.events.payload })
    .from(schema.events)
    .where(eq(schema.events.source, TEAMS_SOURCE))
    .orderBy(desc(schema.events.receivedAt))
    .limit(TETO_DE_LEITURA);

  for (const linha of linhas) {
    const corpo = linha.payload as Record<string, unknown>;
    if (corpo.chatId !== chatId) continue;
    return {
      subject: String(corpo.text ?? ""),
      author: typeof corpo.author === "string" ? corpo.author : null,
      webUrl: typeof corpo.webUrl === "string" ? corpo.webUrl : null,
    };
  }
  return null;
}
