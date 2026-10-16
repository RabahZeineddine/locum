import { z } from "zod";

// O renderer e o executor importam este arquivo: nada de Node aqui.

/** As ações de reação. Cada uma age na mensagem do evento, sem texto novo. */
export const ACOES_DE_REACAO = new Set(["teams.react", "slack.react"]);

/**
 * O que o passo de reação escreve em `params`, já com os marcadores trocados.
 *
 * `emoji` é a reação fixa. `porValor` escolhe a reação pelo valor de outra
 * saída (o veredito da revisão, por exemplo): `de` é o valor, `mapa` diz qual
 * emoji cada valor ganha e `padrao` vale para o resto. `tirar` é a reação que
 * sai antes de a nova entrar, para o "troca 👀 pelo veredito" ser um nó só.
 */
export const ParamsDeReacao = z.object({
  emoji: z.string().optional(),
  operacao: z.enum(["set", "unset"]).optional(),
  tirar: z.string().optional(),
  porValor: z
    .object({
      de: z.unknown().optional(),
      mapa: z.record(z.string(), z.string()).default({}),
      padrao: z.string().optional(),
    })
    .optional(),
});

export type ReacaoDoPasso = { operacao: "set" | "unset"; emoji: string; tirar?: string };

const limpo = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * A reação que o passo pede, a partir do que o executor juntou (saída do passo
 * de entrada, destino do evento e `params`). Estoura com o que falta: um passo
 * de reação sem emoji não deve virar pendência vazia.
 */
export function reacaoDoPasso(payload: unknown): ReacaoDoPasso {
  const p = ParamsDeReacao.safeParse(payload ?? {});
  if (!p.success) {
    const onde = p.error.issues[0];
    throw new Error(`os parâmetros da reação estão inválidos: ${onde?.path.join(".") ?? ""} ${onde?.message ?? ""}`.trim());
  }
  const { porValor } = p.data;
  let emoji: string;
  if (porValor !== undefined) {
    const valor = porValor.de === null || porValor.de === undefined ? "" : String(porValor.de).trim();
    const achado = limpo(porValor.mapa[valor]) || limpo(porValor.padrao);
    if (achado === "") {
      throw new Error(`a reação não tem emoji para o valor "${valor}" e o mapa não tem padrão`);
    }
    emoji = achado;
  } else {
    emoji = limpo(p.data.emoji);
    if (emoji === "") throw new Error("escolha o emoji da reação");
  }
  const tirar = limpo(p.data.tirar);
  return { operacao: p.data.operacao ?? "set", emoji, ...(tirar === "" ? {} : { tirar }) };
}

/** Uma linha para o ensaio e a Fila: `set 👀`, ou `unset 👀 e set ✅` quando troca. */
export function descreverReacao(r: ReacaoDoPasso): string {
  return r.tirar === undefined ? `${r.operacao} ${r.emoji}` : `unset ${r.tirar}, ${r.operacao} ${r.emoji}`;
}
