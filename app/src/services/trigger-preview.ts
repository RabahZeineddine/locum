import { PollTrigger, type TriggerConfigInput } from "../config/types.js";
import type { PollClient, PreviaDaVarredura } from "../sources/github.js";
import type { db as defaultDb } from "../db/index.js";

type Db = typeof defaultDb;

export type PreviaDoGatilho = PreviaDaVarredura;

/**
 * A prévia de um gatilho de varredura do GitHub, com a configuração que a
 * tela tem na mão e que pode ainda não estar salva.
 *
 * O `@me` troca pela conta conferida do token, como na batida. As fontes
 * entram por import dinâmico, pelo mesmo motivo do agendador: o octokit só
 * carrega quando alguém pede.
 */
export async function previaDoGatilho(
  config: TriggerConfigInput,
  deps: { client?: PollClient; db?: Db; viewer?: () => Promise<string | null> } = {},
): Promise<PreviaDoGatilho> {
  if (config.kind !== "poll" || config.source !== "github") {
    throw new Error("a prévia existe só para gatilho de varredura do GitHub");
  }
  const parsed = PollTrigger.parse(config);
  const owner = parsed.owner ?? process.env.GITHUB_OWNER;
  if (!owner) throw new Error("gatilho sem dono e sem GITHUB_OWNER, a varredura precisa da org");

  const viewer =
    deps.viewer ??
    (async () => (await import("./github-service.js")).githubService.viewerLogin());
  const { previewOpenPullRequests } = await import("../sources/github.js");
  return previewOpenPullRequests(owner, new RegExp(parsed.repoMatch), {
    includeDrafts: parsed.includeDrafts,
    filters: parsed.filters,
    viewer: JSON.stringify(parsed.filters ?? {}).includes('"@me"') ? await viewer() : null,
    client: deps.client,
    db: deps.db,
  });
}
