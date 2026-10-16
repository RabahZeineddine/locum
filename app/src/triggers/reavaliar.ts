import { eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { fetchPrBasico } from "../sources/github.js";
import { carregarRevisados, motivoDeDescarte } from "../sources/teams-inbox.js";
import { githubService } from "../services/github-service.js";

type Db = typeof defaultDb;

/**
 * Por que um evento guardado não vale mais, ou nulo se ainda vale.
 *
 * Evento que esperou o limite de um provedor pode ter ficado velho: o PR
 * fechou, foi mergeado, virou rascunho, é do próprio dono ou já ganhou review.
 * É o mesmo exame do enriquecimento da fonte (`motivoDeDescarte`), feito de
 * novo na hora de soltar. Evento sem pull request no payload, ou com o GitHub
 * fora do ar, segue: na dúvida, o evento roda.
 *
 * "Repetido" olha só as reviews já feitas: os eventos do Teams entre si se
 * acusariam uns aos outros, porque cada um já traz o commit do PR.
 */
export async function motivoDoEventoGuardado(eventId: string, db: Db = defaultDb): Promise<string | null> {
  const [evento] = await db.select({ payload: schema.events.payload }).from(schema.events).where(eq(schema.events.id, eventId)).limit(1);
  const p = (evento?.payload ?? null) as Record<string, unknown> | null;
  if (p === null) return null;
  const owner = p.owner ?? p.prOwner;
  const repo = p.repoName ?? p.prRepo;
  const pull = p.pull ?? p.prNumber;
  if (typeof owner !== "string" || typeof repo !== "string" || typeof pull !== "number") return null;
  try {
    const contexto = await fetchPrBasico(owner, repo, pull);
    return await motivoDeDescarte(contexto, () => githubService.viewerLogin(), () => carregarRevisados(db, { comEventosDoTeams: false }));
  } catch {
    return null;
  }
}
