import {
  ActionStep,
  AgentProfile,
  AgentSpec,
  CronTrigger,
  LogicStep,
  ManualTrigger,
  McpPollTrigger,
  ModelStep,
  PollFilters,
  PollTrigger,
  ScheduleTrigger,
  SlackChannelTrigger,
  SlackInboxTrigger,
  TeamsInboxTrigger,
  WebhookTrigger,
} from "../config/types.js";
import type { CodigoOmitido } from "./formato.js";

/**
 * Como cada campo dos esquemas do spec, do gatilho e do agent viaja no pacote.
 * Cada mapa é tipado contra o `shape` do esquema: campo novo sem marcação não
 * compila, e `test/pacote-marcacao.test.ts` cobre o mesmo em tempo de execução.
 * O formato do pacote (formato.ts) e a exportação (pacote-service.ts) leem
 * daqui; nenhum deles decide campo a campo.
 *
 * - `portavel`: vai como está.
 * - `texto`: texto escrito por gente; passa pela limpeza de texto.
 * - `argumentos`: argumentos de uma ferramenta (marcador viaja; literal limpo ou omitido).
 * - `{ local }`: é desta máquina e da pessoa; não viaja, e a prévia pede para escolher (o código diz o quê).
 * - `{ filhos }`: objeto cujos campos têm marcação própria.
 * - `dobrado`: viaja por outro campo (o toolset do agent vira ferramentas avulsas; os chats do Teams viram `chatsRestritos`).
 */
export type Marca = "portavel" | "texto" | "argumentos" | "dobrado" | { local: CodigoOmitido } | { filhos: MapaDeMarcas };
export type MapaDeMarcas = Readonly<Record<string, Marca>>;
type Campos<S extends { shape: object }> = Record<keyof S["shape"], Marca>;

export const ehLocal = (m: Marca): m is { local: CodigoOmitido } => typeof m === "object" && "local" in m;
export const temFilhos = (m: Marca): m is { filhos: MapaDeMarcas } => typeof m === "object" && "filhos" in m;

const MARCAS_DOS_FILTROS: Campos<typeof PollFilters> = {
  authors: { local: "filtros-de-pessoa" },
  reviewRequested: { local: "filtros-de-pessoa" },
  teamMembers: { local: "filtros-de-pessoa" },
  labels: "portavel",
  baseBranches: "portavel",
  paths: "portavel",
  maxChangedLines: "portavel",
};

/** Marcação de cada tipo de gatilho, pelo `kind`. */
export const MARCAS_DOS_GATILHOS = {
  schedule: { kind: "portavel", everyMinutes: "portavel", workingHours: "portavel" } satisfies Campos<typeof ScheduleTrigger>,
  webhook: { kind: "portavel", path: "texto" } satisfies Campos<typeof WebhookTrigger>,
  cron: { kind: "portavel", expression: "portavel" } satisfies Campos<typeof CronTrigger>,
  manual: { kind: "portavel" } satisfies Campos<typeof ManualTrigger>,
  "slack-inbox": { kind: "portavel", mentions: "portavel", dms: "portavel", everyMinutes: "portavel", workingHours: "portavel" } satisfies Campos<typeof SlackInboxTrigger>,
  "slack-channel": { kind: "portavel", channels: { local: "canais" }, everyMinutes: "portavel", workingHours: "portavel" } satisfies Campos<typeof SlackChannelTrigger>,
  "teams-inbox": {
    kind: "portavel",
    mentions: "portavel",
    dms: "portavel",
    prLinks: "portavel",
    agruparPrs: "portavel",
    maxPrs: "portavel",
    filtroIa: "portavel",
    channels: { local: "canais" },
    chats: { local: "canais" },
    chatsPendentes: "dobrado",
    everyMinutes: "portavel",
    workingHours: "portavel",
  } satisfies Campos<typeof TeamsInboxTrigger>,
  poll: {
    kind: "portavel",
    source: "portavel",
    owner: { local: "dono-do-github" },
    repoMatch: "texto",
    authorship: "portavel",
    includeDrafts: "portavel",
    filters: { filhos: MARCAS_DOS_FILTROS },
    everyMinutes: "portavel",
    workingHours: "portavel",
  } satisfies Campos<typeof PollTrigger>,
  "mcp-poll": { kind: "portavel", server: "portavel", tool: "portavel", args: "argumentos", everyMinutes: "portavel", workingHours: "portavel" } satisfies Campos<typeof McpPollTrigger>,
} as const satisfies Record<string, MapaDeMarcas>;

/** O agent da biblioteca no pacote. O toolset vira ferramentas avulsas dele; o resto viaja. */
export const MARCAS_DO_AGENT: Campos<typeof AgentProfile> = {
  id: "portavel",
  name: "texto",
  description: "texto",
  context: "texto",
  instructions: "texto",
  model: "portavel",
  temperature: "portavel",
  toolsets: "dobrado",
  tools: "portavel",
  connections: "portavel",
  skills: "portavel",
  budget: "portavel",
  maxSteps: "portavel",
};

/** O spec da automação. Os passos têm a marcação própria abaixo. */
export const MARCAS_DO_SPEC: Campos<typeof AgentSpec> = {
  id: "portavel",
  name: "texto",
  defaultTools: "portavel",
  skills: "portavel",
  steps: "portavel",
  budget: "portavel",
  layout: "portavel",
  pendentes: "dobrado",
};

/** Os passos de IA e de lógica viajam inteiros; o de ação tem o `target` local e os `params` pela declaração da ação. */
export const MARCAS_DO_PASSO_DE_ACAO: Campos<typeof ActionStep> = {
  key: "portavel",
  name: "texto",
  needs: "portavel",
  when: "portavel",
  optional: "portavel",
  type: "portavel",
  action: "portavel",
  mode: "portavel",
  input: "portavel",
  target: { local: "tracker" },
  params: "dobrado",
};
export const MARCAS_DO_PASSO_DE_IA: Campos<typeof ModelStep> = Object.fromEntries(Object.keys(ModelStep.shape).map((k) => [k, "portavel"])) as Campos<typeof ModelStep>;
export const MARCAS_DO_PASSO_DE_LOGICA: Campos<typeof LogicStep> = Object.fromEntries(Object.keys(LogicStep.shape).map((k) => [k, "portavel"])) as Campos<typeof LogicStep>;
