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
    title: "Example initiative",
    objective: "Show what an initiative looks like once it has a context, agents and servers.",
    doneCriteria: "Someone opens the initiatives screen and understands the shape without asking.",
  });
}
