import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ActionHandler } from "../approval/gate.js";
import { db as defaultDb, schema } from "../db/index.js";
import { mcpOAuthService } from "../services/mcp-oauth-service.js";
import { GRAPH_URL, TEAMS_SERVER } from "../services/teams-app.js";
import { TEAMS_CHANNEL_PREFIX, TEAMS_SOURCE } from "../sources/teams-inbox.js";
import { clienteHttp } from "../net/http.js";

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

/**
 * O que fica gravado na pendência, e o que a publicação vai receber.
 *
 * Resposta em canal leva equipe, canal e thread; em conversa, só a conversa.
 * `chatId` continua obrigatório para a pendência antiga, de antes dos canais,
 * seguir publicável: em canal ele é o canal.
 */
export const TeamsPostProposal = z.object({
  chatId: z.string().min(1),
  text: z.string().min(1),
  /** A última mensagem lida da conversa, para a fila mostrar a que se responde. */
  subject: z.string(),
  author: z.string().nullable(),
  webUrl: z.string().nullable(),
  channel: z
    .object({
      teamId: z.string().min(1),
      channelId: z.string().min(1),
      threadId: z.string().min(1),
      label: z.string().nullable(),
    })
    .optional(),
});
export type TeamsPostProposal = z.infer<typeof TeamsPostProposal>;

/** Prefixo do `repo` que a caixa do Teams grava em cada evento. */
const PREFIXO = "teams/";

/** Para onde vai a resposta, pelo `repo` do evento. */
export type DestinoDoTeams =
  | { tipo: "chat"; chatId: string }
  | { tipo: "canal"; teamId: string; channelId: string; threadId: string };

export function destinoDe(payload: unknown): DestinoDoTeams {
  const repo = (payload as { repo?: unknown } | null | undefined)?.repo;
  if (typeof repo === "string" && repo.startsWith(TEAMS_CHANNEL_PREFIX)) {
    const partes = repo.slice(TEAMS_CHANNEL_PREFIX.length).split("/");
    if (partes.length === 3 && partes.every((p) => p !== "")) {
      return { tipo: "canal", teamId: partes[0]!, channelId: partes[1]!, threadId: partes[2]! };
    }
  }
  return { tipo: "chat", chatId: chatOf(payload) };
}

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
  const fetchFn = options.fetchFn ?? clienteHttp;
  const graphUrl = options.graphUrl ?? GRAPH_URL;

  return {
    modes: ["approve"],

    async propose(payload) {
      if (payload === null || typeof payload !== "object") {
        throw new Error("o passo de acao do Teams recebeu uma saida que nao e objeto");
      }
      const destino = destinoDe(payload);
      const resposta = TeamsReply.safeParse(payload);
      if (!resposta.success) {
        const onde = resposta.error.issues[0];
        throw new Error(
          `o passo de modelo nao escreveu a resposta: ${onde?.path.join(".") ?? ""} ${onde?.message ?? ""}`.trim(),
        );
      }

      if (destino.tipo === "canal") {
        const lida = await ultimaDoCanal(db, destino);
        if (lida === null) {
          throw new Error(`a thread ${destino.threadId} nao aparece no que o Locum leu do canal`);
        }
        const { label, ...resto } = lida;
        return TeamsPostProposal.parse({
          chatId: destino.channelId,
          text: resposta.data.text,
          ...resto,
          channel: { teamId: destino.teamId, channelId: destino.channelId, threadId: destino.threadId, label },
        });
      }

      const lida = await ultimaLida(db, destino.chatId);
      if (lida === null) {
        throw new Error(`a conversa ${destino.chatId} nao aparece no que o Locum leu do Teams`);
      }
      return TeamsPostProposal.parse({ chatId: destino.chatId, text: resposta.data.text, ...lida });
    },

    async publish(payload) {
      const proposta = TeamsPostProposal.parse(payload);
      const valor = await token();
      if (valor === null) throw new Error("o Teams não está conectado");

      const canal = proposta.channel;
      const endereco =
        canal === undefined
          ? `${graphUrl}/chats/${encodeURIComponent(proposta.chatId)}/messages`
          : `${graphUrl}/teams/${encodeURIComponent(canal.teamId)}/channels/${encodeURIComponent(canal.channelId)}` +
            `/messages/${encodeURIComponent(canal.threadId)}/replies`;
      const resposta = await fetchFn(endereco, {
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

/**
 * A mensagem mais recente lida daquela thread do canal, ou nulo. Conferir a
 * thread, e não só o canal, é o que impede o modelo de mandar a resposta para
 * uma conversa que ninguém leu.
 */
async function ultimaDoCanal(
  db: Db,
  destino: { teamId: string; channelId: string; threadId: string },
): Promise<{ subject: string; author: string | null; webUrl: string | null; label: string | null } | null> {
  const linhas = await db
    .select({ payload: schema.events.payload })
    .from(schema.events)
    .where(eq(schema.events.source, TEAMS_SOURCE))
    .orderBy(desc(schema.events.receivedAt))
    .limit(TETO_DE_LEITURA);

  for (const linha of linhas) {
    const corpo = linha.payload as Record<string, unknown>;
    if (corpo.teamId !== destino.teamId || corpo.channelId !== destino.channelId) continue;
    if (corpo.threadId !== destino.threadId) continue;
    return {
      subject: String(corpo.text ?? ""),
      author: typeof corpo.author === "string" ? corpo.author : null,
      webUrl: typeof corpo.webUrl === "string" ? corpo.webUrl : null,
      label: typeof corpo.channel === "string" ? corpo.channel : null,
    };
  }
  return null;
}
