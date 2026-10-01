import { initiativeService, type InitiativeRow } from "../services/initiative-service.js";

/**
 * Garante uma iniciativa semente para a tela de iniciativas ter o que mostrar.
 *
 * `upsert` ja e idempotente pelo slug: a segunda chamada so atualiza os campos
 * e nunca reescreve o `context.md`, entao plantar aqui a cada subida do smoke
 * nao acumula nada nem perde o que uma pessoa tenha escrito no contexto.
 */
export async function ensureExampleInitiative(): Promise<InitiativeRow> {
  return initiativeService.upsert({
    slug: "example",
    title: "Iniciativa de exemplo",
    objective: "Mostrar como fica uma iniciativa que já tem contexto, agents e servidores.",
    doneCriteria: "Quem abre a tela de iniciativas entende o formato sem precisar perguntar.",
  });
}
