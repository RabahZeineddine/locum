import { z } from "zod";

/**
 * O que `InitiativeService.proposeContextUpdate` grava na fila, e o que
 * `context.update` recebe de volta em `publish`.
 *
 * `replace` reescreve o arquivo inteiro e por isso exige `baseHash`: sem ele
 * não há como saber se o arquivo mudou por fora entre a proposta e o clique.
 * `append` só acrescenta um bloco novo, identificado por um marcador, e um
 * arquivo que mudou por fora não invalida um acréscimo que ainda não está lá.
 */
export const ContextUpdateMode = z.enum(["replace", "append"]);
export type ContextUpdateMode = z.infer<typeof ContextUpdateMode>;

export const ContextUpdateProposal = z
  .object({
    initiativeId: z.string().trim().min(1),
    slug: z.string().trim().min(1),
    file: z.literal("context.md"),
    mode: ContextUpdateMode,
    content: z.string().min(1),
    baseHash: z.string().trim().min(1).optional(),
    /** De onde a proposta veio: MCP, chat, gatilho. Vai para o log da pendência. */
    origin: z.string().trim().min(1),
  })
  .refine((v) => (v.mode === "replace" ? v.baseHash !== undefined : v.baseHash === undefined), {
    message: '"replace" precisa de baseHash, e "append" nao aceita baseHash',
    path: ["baseHash"],
  });
export type ContextUpdateProposal = z.infer<typeof ContextUpdateProposal>;
