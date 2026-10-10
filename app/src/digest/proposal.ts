import { z } from "zod";

/**
 * O digest que um passo de modelo escreve, e o que vira proposta de leitura.
 *
 * A divisão é a mesma da proposta de tarefa. O modelo escreve prosa e
 * classifica; canal, assunto e a ordem das seções vêm do agrupamento
 * determinístico, que já sabe de onde cada linha saiu. Um modelo que também
 * inventasse o canal transformaria erro de leitura em conversa atribuída ao
 * lugar errado.
 */

/** Para que serve cada assunto de um digest. */
export const DigestKind = z.enum(["needs_reply", "info", "ignore"]);
export type DigestKind = z.infer<typeof DigestKind>;

export const DigestItem = z.object({
  channel: z.string().trim().min(1),
  subject: z.string().trim().min(1),
  kind: DigestKind,
  summary: z.string().trim().min(1),
  /** A thread de onde o assunto saiu, quando o modelo soube dizer. */
  threadTs: z.string().trim().min(1).optional(),
});
export type DigestItem = z.infer<typeof DigestItem>;

/** O que o passo de modelo devolve. Sem isto não há digest para propor.
 *
 * Lista vazia é dia calmo válido, e não erro: o monitor de observabilidade
 * que não achou incidente nenhum tem resultado legível, e escondê-lo faria o
 * silêncio parecer falha. A pendência entra na fila com a headline e sem
 * assunto, e o clique de leitura vale como os outros.
 */
export const DigestReading = z.object({
  headline: z.string().trim().min(1),
  items: z.array(DigestItem),
});
export type DigestReading = z.infer<typeof DigestReading>;

/**
 * O esquema de saída do passo de modelo, no formato que o runtime entende.
 *
 * Escrito à mão e não derivado do zod acima, pelo mesmo motivo da proposta de
 * tarefa: o que vai para o provedor é JSON Schema puro.
 */
export const DIGEST_READING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "items"],
  properties: {
    headline: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["channel", "subject", "kind", "summary"],
        properties: {
          channel: { type: "string" },
          subject: { type: "string" },
          kind: { enum: ["needs_reply", "info", "ignore"] },
          summary: { type: "string" },
          threadTs: { type: "string" },
        },
      },
    },
  },
} as const;

/** O que fica gravado na pendência, e o que a inbox mostra. */
export const DigestProposal = z.object({
  headline: z.string().min(1),
  /** Os assuntos agrupados por canal, na ordem em que o digest se lê. */
  channels: z
    .array(
      z.object({
        channel: z.string().min(1),
        items: z.array(DigestItem).min(1),
      }),
    ),
  /** Quantos assuntos de cada classe, que é o que se olha antes de abrir. */
  counts: z.object({
    needs_reply: z.number().int().nonnegative(),
    info: z.number().int().nonnegative(),
    ignore: z.number().int().nonnegative(),
  }),
  body: z.string().min(1),
});
export type DigestProposal = z.infer<typeof DigestProposal>;

/** Título de cada seção do corpo, na língua em que a conversa acontece. */
const CLASSE: Record<DigestKind, string> = {
  needs_reply: "pede resposta",
  info: "informação",
  ignore: "dá para ignorar",
};

/**
 * Monta a proposta a partir do que o passo de modelo devolveu.
 *
 * O agrupamento por canal é refeito aqui, e não copiado da saída do modelo:
 * ele classifica e resume assunto por assunto, e deixar que ele também
 * devolvesse a árvore permitiria que o mesmo canal aparecesse duas vezes na
 * tela por causa de um espaço a mais no nome.
 */
export function buildDigestProposal(payload: unknown): DigestProposal {
  if (payload === null || typeof payload !== "object") {
    throw new Error("o passo de acao do digest recebeu uma saida que nao e objeto");
  }

  const leitura = DigestReading.safeParse(payload);
  if (!leitura.success) {
    const onde = leitura.error.issues[0];
    throw new Error(
      `o passo de modelo nao escreveu o digest: ${onde?.path.join(".") ?? ""} ${onde?.message ?? ""}`.trim(),
    );
  }

  const porCanal = new Map<string, DigestItem[]>();
  const counts = { needs_reply: 0, info: 0, ignore: 0 };
  for (const item of leitura.data.items) {
    const lista = porCanal.get(item.channel) ?? [];
    porCanal.set(item.channel, lista);
    lista.push(item);
    counts[item.kind] += 1;
  }

  // O que pede resposta primeiro dentro de cada canal: um digest que abre com
  // o que dá para ignorar é lido até a metade e abandonado.
  const ordem: DigestKind[] = ["needs_reply", "info", "ignore"];
  const channels = [...porCanal]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([channel, items]) => ({
      channel,
      items: [...items].sort((x, y) => ordem.indexOf(x.kind) - ordem.indexOf(y.kind)),
    }));

  return DigestProposal.parse({
    headline: leitura.data.headline,
    channels,
    counts,
    body: corpo(leitura.data.headline, channels),
  });
}

function corpo(
  headline: string,
  channels: { channel: string; items: DigestItem[] }[],
): string {
  const linhas = [headline.trim(), ""];
  for (const canal of channels) {
    linhas.push(`## ${canal.channel}`, "");
    for (const item of canal.items) {
      linhas.push(`- [${CLASSE[item.kind]}] ${item.subject}`, `  ${item.summary}`);
    }
    linhas.push("");
  }
  return linhas.join("\n").trimEnd();
}
