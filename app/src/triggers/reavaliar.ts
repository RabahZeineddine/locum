import { eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { fetchPrBasico } from "../sources/github.js";
import { carregarRevisados, motivoDeDescarte, textoDosPrs } from "../sources/teams-inbox.js";
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
export async function motivoDoEventoGuardado(
  eventId: string,
  db: Db = defaultDb,
  deps: {
    buscar?: typeof fetchPrBasico;
    viewer?: () => Promise<string | null>;
    revisados?: () => Promise<Set<string>>;
  } = {},
): Promise<string | null> {
  const [evento] = await db.select({ payload: schema.events.payload }).from(schema.events).where(eq(schema.events.id, eventId)).limit(1);
  const p = (evento?.payload ?? null) as Record<string, unknown> | null;
  if (p === null) return null;
  // Evento de mensagem com vários PRs: sai da lista o PR que deixou de valer, e o
  // evento só deixa de valer quando nenhum sobra.
  const lista = Array.isArray(p.prs) && p.prs.length > 0 ? (p.prs as Record<string, unknown>[]) : [p];
  const alvos = lista.flatMap((q) => {
    const owner = q.owner ?? q.prOwner;
    const repo = q.repoName ?? q.prRepo;
    const pull = q.pull ?? q.prNumber;
    return typeof owner === "string" && typeof repo === "string" && typeof pull === "number" ? [{ owner, repo, pull, q }] : [];
  });
  if (alvos.length === 0 || alvos.length < lista.length) return null;
  const buscar = deps.buscar ?? fetchPrBasico;
  const viewer = deps.viewer ?? (() => githubService.viewerLogin());
  const revisados = deps.revisados ?? (() => carregarRevisados(db, { comEventosDoTeams: false }));
  const valem: typeof lista = [];
  let motivo: string | null = null;
  try {
    for (const a of alvos) {
      const contexto = await buscar(a.owner, a.repo, a.pull);
      const m = await motivoDeDescarte(contexto, viewer, revisados);
      if (m === null) valem.push(a.q);
      else motivo = m;
    }
  } catch {
    return null;
  }
  if (valem.length === 0) return motivo;
  if (valem.length < lista.length && Array.isArray(p.prs)) {
    const prs = valem as (Record<string, unknown> & { prOwner: string; prRepo: string; prNumber: number })[];
    const { prsCortados, prsLimite } = p as { prsCortados?: number; prsLimite?: number };
    await db
      .update(schema.events)
      .set({
        payload: {
          ...p,
          ...prs[0],
          prLinks: prs.map((q) => ({ owner: q.prOwner, repo: q.prRepo, pull: q.prNumber })),
          prs,
          prsTexto: textoDosPrs(prs, { cortados: prsCortados ?? 0, limite: prsLimite ?? prs.length }),
        },
      })
      .where(eq(schema.events.id, eventId));
  }
  return null;
}
