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
  // Evento de mensagem com vários PRs: só deixa de valer quando nenhum deles vale.
  const lista = Array.isArray(p.prs) && p.prs.length > 0 ? (p.prs as Record<string, unknown>[]) : [p];
  const alvos = lista.flatMap((q) => {
    const owner = q.owner ?? q.prOwner;
    const repo = q.repoName ?? q.prRepo;
    const pull = q.pull ?? q.prNumber;
    return typeof owner === "string" && typeof repo === "string" && typeof pull === "number" ? [{ owner, repo, pull }] : [];
  });
  if (alvos.length === 0 || alvos.length < lista.length) return null;
  try {
    let motivo: string | null = null;
    for (const a of alvos) {
      const contexto = await fetchPrBasico(a.owner, a.repo, a.pull);
      motivo = await motivoDeDescarte(contexto, () => githubService.viewerLogin(), () => carregarRevisados(db, { comEventosDoTeams: false }));
      if (motivo === null) return null;
    }
    return motivo;
  } catch {
    return null;
  }
}
