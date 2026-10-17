import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ActionHandler } from "../approval/gate.js";
import { db as defaultDb, schema } from "../db/index.js";
import { TEAMS_CHANNEL_PREFIX, TEAMS_SOURCE } from "../sources/teams-inbox.js";
import { abrirTeams, servidorDeVariasContas, type TeamsGraphOptions } from "./graph.js";
import { DestinoNaFila, PARAMS_DE_DESTINO_NO_PACOTE } from "../acao/destino.js";
import { destinoParaFila, resolverDestino } from "../acao/conversa.js";
import { adaptadorDoTeams, destinoDe } from "./conversa.js";
import { lerRefDoTeams } from "./ref.js";

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
  /** A conta do servidor MCP que leu a conversa, para a resposta sair por ela. */
  account: z.string().min(1).optional(),
  channel: z
    .object({
      teamId: z.string().min(1),
      channelId: z.string().min(1),
      /** Sem a thread, a mensagem abre uma conversa nova no canal. */
      threadId: z.string().min(1).optional(),
      label: z.string().nullable(),
    })
    .optional(),
  /** Para onde o passo mandou o texto, em dado: a Fila monta o texto. */
  destino: DestinoNaFila.optional(),
});
export type TeamsPostProposal = z.infer<typeof TeamsPostProposal>;

export { chatOf, destinoDe, type DestinoDoTeams } from "./conversa.js";

export interface TeamsPostHandlerOptions extends TeamsGraphOptions {
  db?: Db;
}

/**
 * O handler da ação `teams.post`.
 *
 * Nasce em `approve` pelo mesmo motivo do `slack.post`: a mensagem sai com o
 * nome da pessoa, e quem lê não tem como saber que foi um agent que escreveu.
 * O automático, como lá, só uma pessoa liga. Sem `draft` porque o Graph não tem rascunho de
 * mensagem de chat.
 *
 * A conversa vem do evento e é conferida contra o que o Locum leu: um
 * identificador que nunca passou pela caixa não acha nada, e o passo falha
 * antes de virar pendência.
 */
export function teamsPostHandler(options: TeamsPostHandlerOptions = {}): ActionHandler {
  const db = options.db ?? defaultDb;

  return {
    modes: ["approve", "auto"],
    paramsDoPacote: PARAMS_DE_DESTINO_NO_PACOTE,

    async propose(payload) {
      if (payload === null || typeof payload !== "object") {
        throw new Error("o passo de acao do Teams recebeu uma saida que nao e objeto");
      }
      const resposta = TeamsReply.safeParse(payload);
      if (!resposta.success) {
        const onde = resposta.error.issues[0];
        throw new Error(
          `o passo de modelo nao escreveu a resposta: ${onde?.path.join(".") ?? ""} ${onde?.message ?? ""}`.trim(),
        );
      }
      const alvo = resolverDestino(adaptadorDoTeams, "teams.post", (payload as { destino?: unknown }).destino, payload);
      const text = resposta.data.text;

      if (alvo.tipo === "fixo") {
        // Conversa que a pessoa escolheu: não precisa ter sido lida pelo gatilho.
        // A conta é a que a pessoa escolheu junto com a conversa: a do evento pode ser outra.
        const comConta = alvo.conta === null ? {} : { account: alvo.conta };
        const conversa = lerRefDoTeams(alvo.conversa);
        // O nome conferido sai do que o Locum leu do canal; sem leitura, a Fila mostra o escolhido no nó, sem fingir.
        const nome = conversa.tipo === "canal" ? await nomeDoCanalLido(db, conversa.teamId, conversa.channelId) : null;
        const destino = destinoParaFila("teams", alvo, nome);
        const base = { text, subject: "", author: null, webUrl: null, destino, ...comConta };
        return exigirConta(
          options,
          TeamsPostProposal.parse(
          conversa.tipo === "chat"
            ? { chatId: conversa.chatId, ...base }
            : {
                chatId: conversa.channelId,
                ...base,
                channel: { teamId: conversa.teamId, channelId: conversa.channelId, label: nome },
              },
          ),
        );
      }

      // `evento` responde no fio; `novo` usa a mesma conversa, sem o fio.
      const destino = destinoParaFila("teams", alvo, null);
      const lugar = destinoDe(payload);
      if (lugar.tipo === "canal") {
        const lida = await ultimaDoCanal(db, lugar);
        if (lida === null) {
          throw new Error(`a thread ${lugar.threadId} nao aparece no que o Locum leu do canal`);
        }
        const { label, ...resto } = lida;
        return exigirConta(options, TeamsPostProposal.parse({
          chatId: lugar.channelId,
          text,
          ...resto,
          destino,
          channel: {
            teamId: lugar.teamId,
            channelId: lugar.channelId,
            ...(alvo.mensagem === null ? {} : { threadId: alvo.mensagem }),
            label,
          },
        }));
      }

      const lida = await ultimaLida(db, lugar.chatId);
      if (lida === null) {
        throw new Error(`a conversa ${lugar.chatId} nao aparece no que o Locum leu do Teams`);
      }
      return exigirConta(options, TeamsPostProposal.parse({ chatId: lugar.chatId, text, ...lida, destino }));
    },

    async publish(payload) {
      const proposta = TeamsPostProposal.parse(payload);
      const teams = await abrirTeams(
        proposta.account === undefined ? options : { ...options, account: proposta.account },
      );
      try {
        // Pendência de antes de a conta ir gravada: o servidor falaria pela
        // conta padrão de hoje, que pode não ser a de quem leu.
        if (teams.multiConta && proposta.account === undefined) {
          throw new Error(
            `O servidor "${teams.servidor}" tem várias contas e esta resposta não diz por qual sair. Rejeite e gere a resposta de novo.`,
          );
        }
        const canal = proposta.channel;
        const caminho =
          canal === undefined
            ? `/chats/${encodeURIComponent(proposta.chatId)}/messages`
            : `/teams/${encodeURIComponent(canal.teamId)}/channels/${encodeURIComponent(canal.channelId)}/messages` +
              (canal.threadId === undefined ? "" : `/${encodeURIComponent(canal.threadId)}/replies`);
        await teams.post(caminho, { body: { contentType: "text", content: proposta.text } }, "a mensagem");
      } finally {
        await teams.close();
      }
    },
  };
}

/**
 * Servidor com várias contas e proposta sem conta: a resposta não saberia por
 * qual sair, e falharia só no clique de aprovar. Recusa aqui, antes da Fila.
 */
async function exigirConta(options: TeamsGraphOptions, proposta: TeamsPostProposal): Promise<TeamsPostProposal> {
  if (proposta.account !== undefined) return proposta;
  const servidor = await servidorDeVariasContas(options);
  if (servidor !== null) {
    throw new Error(
      `O servidor "${servidor}" tem várias contas e este destino não diz por qual sair. Escolha a conversa de novo no nó, para gravar a conta.`,
    );
  }
  return proposta;
}

/** O nome do canal, como veio nas mensagens que o Locum já leu dele, ou nulo. */
async function nomeDoCanalLido(db: Db, teamId: string, channelId: string): Promise<string | null> {
  const linhas = await db
    .select({ payload: schema.events.payload })
    .from(schema.events)
    .where(eq(schema.events.source, TEAMS_SOURCE))
    .orderBy(desc(schema.events.receivedAt))
    .limit(TETO_DE_LEITURA);
  for (const linha of linhas) {
    const corpo = linha.payload as Record<string, unknown>;
    if (corpo.teamId === teamId && corpo.channelId === channelId && typeof corpo.channel === "string" && corpo.channel !== "") {
      return corpo.channel;
    }
  }
  return null;
}

/** A mensagem mais recente lida da conversa, ou nulo se ela nunca foi lida. */
async function ultimaLida(
  db: Db,
  chatId: string,
): Promise<{ subject: string; author: string | null; webUrl: string | null; account?: string } | null> {
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
      ...(typeof corpo.teamsAccount === "string" && corpo.teamsAccount !== "" ? { account: corpo.teamsAccount } : {}),
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
): Promise<{ subject: string; author: string | null; webUrl: string | null; label: string | null; account?: string } | null> {
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
      ...(typeof corpo.teamsAccount === "string" && corpo.teamsAccount !== "" ? { account: corpo.teamsAccount } : {}),
      label: typeof corpo.channel === "string" ? corpo.channel : null,
    };
  }
  return null;
}
