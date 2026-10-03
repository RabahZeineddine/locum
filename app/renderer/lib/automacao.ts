/**
 * O canvas da automação, sem nada de React.
 *
 * Uma automação é um agent e os gatilhos dele. O canvas mostra os gatilhos
 * numa coluna à esquerda e os passos do agent à direita, ligados pelo `needs`
 * que o spec já tinha. Tudo que muda o desenho passa por aqui como função
 * pura: o componente só chama e repinta. Isso deixa testável a parte que pode
 * estragar um spec (ligar, desligar, remover passo) sem subir janela.
 *
 * A seta de gatilho para passo não é dado: todo gatilho começa o fluxo inteiro,
 * e por isso ela é desenhada até cada passo sem dependência e não pode ser
 * apagada. A seta entre passos é o `needs`, e essa a pessoa liga e desliga.
 */
import { topoSort, type AgentSpec, type Step, type TriggerConfig } from "../../src/config/types";
import { SLACK_REPLY_SCHEMA } from "../../src/slack/proposal";
import { CONVERSATION_ISSUE_SCHEMA, ISSUE_CONTENT_SCHEMA } from "../../src/trackers/proposal";
import { ALTURA_DO_NO, LARGURA_DO_NO, montarGrafo } from "./grafo";

export type PassoDoSpec = Step;
export type PassoDeIA = Extract<Step, { type: "model" }>;
export type PassoDeAcao = Extract<Step, { type: "action" }>;

/** Um gatilho no canvas. A `chave` é só do desenho; o `id` é o do cadastro. */
export interface GatilhoNoCanvas {
  chave: string;
  id?: string;
  config: TriggerConfig;
  enabled: boolean;
}

export interface Rascunho {
  spec: AgentSpec;
  gatilhos: GatilhoNoCanvas[];
}

export interface Posicao {
  x: number;
  y: number;
}

export interface ArestaDoCanvas {
  id: string;
  source: string;
  target: string;
  /** Gatilho para passo: desenhada, não gravada, e não se apaga. */
  fixa: boolean;
}

const VAO_X = 88;
const VAO_Y = 40;

/** O modelo dos passos de IA que o canvas cria. A pessoa troca no painel. */
export const MODELO_PADRAO = "claude-code/claude-sonnet-5";

export const PREFIXO_DE_GATILHO = "gatilho-";

export function ehGatilho(chave: string): boolean {
  return chave.startsWith(PREFIXO_DE_GATILHO);
}

/** Os gatilhos como chegam do cadastro, com chave de desenho estável. */
export function gatilhosDoCadastro(
  lista: readonly { id: string; config: TriggerConfig; enabled: boolean }[],
): GatilhoNoCanvas[] {
  return lista.map((g, i) => ({ chave: `${PREFIXO_DE_GATILHO}${i + 1}`, id: g.id, config: g.config, enabled: g.enabled }));
}

/* --------------------------------------------------------------- desenho */

/**
 * Onde cada nó fica.
 *
 * O que a pessoa arrastou vem do `layout` do spec. O resto sai do arranjo do
 * grafo de execução, deslocado uma coluna para a direita para caber a coluna
 * dos gatilhos.
 */
export function posicoes(r: Rascunho): Map<string, Posicao> {
  const salvo = r.spec.layout ?? {};
  const mapa = new Map<string, Posicao>();

  r.gatilhos.forEach((g, i) => {
    mapa.set(g.chave, salvo[g.chave] ?? { x: 0, y: i * (ALTURA_DO_NO + VAO_Y) });
  });

  const { nos } = montarGrafo(r.spec.steps.map((p) => ({ key: p.key, needs: p.needs })));
  const deslocamento = r.gatilhos.length > 0 ? LARGURA_DO_NO + VAO_X : 0;
  for (const no of nos) {
    mapa.set(no.key, salvo[no.key] ?? { x: no.x + deslocamento, y: no.y });
  }
  return mapa;
}

export function arestas(r: Rascunho): ArestaDoCanvas[] {
  const raizes = r.spec.steps.filter((p) => p.needs.length === 0);
  const chaves = new Set(r.spec.steps.map((p) => p.key));
  return [
    ...r.gatilhos.flatMap((g) =>
      raizes.map((p) => ({ id: `${g.chave}->${p.key}`, source: g.chave, target: p.key, fixa: true })),
    ),
    ...r.spec.steps.flatMap((p) =>
      p.needs
        .filter((n) => chaves.has(n))
        .map((n) => ({ id: `${n}->${p.key}`, source: n, target: p.key, fixa: false })),
    ),
  ];
}

/* ---------------------------------------------------------------- edição */

/**
 * Liga dois passos: `destino` passa a esperar `origem`.
 *
 * Devolve o erro em vez de lançar, para o canvas mostrar ao lado da seta. Seta
 * que sai de gatilho não muda nada, porque gatilho já começa o fluxo inteiro.
 */
export function ligar(spec: AgentSpec, origem: string, destino: string): { spec: AgentSpec } | { erro: string } {
  if (ehGatilho(destino)) return { erro: "automations.canvas.errors.intoTrigger" };
  if (ehGatilho(origem)) return { spec };
  if (origem === destino) return { erro: "automations.canvas.errors.cycle" };
  const alvo = spec.steps.find((p) => p.key === destino);
  if (alvo === undefined || !spec.steps.some((p) => p.key === origem)) return { spec };
  if (alvo.needs.includes(origem)) return { spec };

  const novo = trocarPasso(spec, destino, { ...alvo, needs: [...alvo.needs, origem] });
  try {
    topoSort(novo.steps);
  } catch {
    return { erro: "automations.canvas.errors.cycle" };
  }
  return { spec: novo };
}

export function desligar(spec: AgentSpec, origem: string, destino: string): AgentSpec {
  const alvo = spec.steps.find((p) => p.key === destino);
  if (alvo === undefined) return spec;
  const needs = alvo.needs.filter((n) => n !== origem);
  const passo = alvo.type === "action" && alvo.input === origem ? semEntrada({ ...alvo, needs }) : { ...alvo, needs };
  return trocarPasso(spec, destino, passo);
}

function semEntrada(passo: PassoDeAcao): PassoDeAcao {
  const { input: _input, ...resto } = passo;
  return resto as PassoDeAcao;
}

export function trocarPasso(spec: AgentSpec, chave: string, novo: Step): AgentSpec {
  return { ...spec, steps: spec.steps.map((p) => (p.key === chave ? novo : p)) };
}

/** Chave livre a partir de uma base: `analisar`, `analisar-2`... */
export function novaChave(spec: AgentSpec, base: string): string {
  const usadas = new Set(spec.steps.map((p) => p.key));
  if (!usadas.has(base)) return base;
  for (let n = 2; ; n++) if (!usadas.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Acrescenta um passo depois de outro, ou no começo.
 *
 * Ação acrescentada depois de um passo de IA ajusta o formato de saída dele,
 * quando ainda não havia um: responder no Slack precisa de `text` e
 * `threadTs`, e abrir tarefa precisa do corpo da tarefa. Sem isso a pessoa
 * montaria um fluxo que só quebra na primeira execução.
 */
export function adicionarPasso(
  r: Rascunho,
  passo: Step,
  depoisDe: string | null,
  onde?: Posicao,
): AgentSpec {
  const anterior = depoisDe === null || ehGatilho(depoisDe) ? null : r.spec.steps.find((p) => p.key === depoisDe);
  const novo: Step =
    anterior === undefined || anterior === null
      ? { ...passo, needs: [] }
      : passo.type === "action"
        ? { ...passo, needs: [anterior.key], input: anterior.key }
        : { ...passo, needs: [anterior.key] };

  let steps = [...r.spec.steps, novo];
  if (anterior && anterior.type === "model" && novo.type === "action" && anterior.outputSchema === undefined) {
    const formato = formatoPedidoPor(novo.action, r.gatilhos);
    if (formato !== null) {
      steps = steps.map((p) => (p.key === anterior.key ? { ...anterior, outputSchema: FORMATOS[formato] } : p));
    }
  }

  const layout = onde === undefined ? r.spec.layout : { ...(r.spec.layout ?? {}), [novo.key]: onde };
  return { ...r.spec, steps, ...(layout === undefined ? {} : { layout }) };
}

/**
 * Tira um passo sem quebrar o fluxo: quem esperava por ele passa a esperar o
 * que ele esperava. Apagar o passo do meio de A → B → C deixa A → C.
 */
export function removerPasso(spec: AgentSpec, chave: string): AgentSpec {
  const removido = spec.steps.find((p) => p.key === chave);
  if (removido === undefined) return spec;
  const steps = spec.steps
    .filter((p) => p.key !== chave)
    .map((p) => {
      if (!p.needs.includes(chave)) return p;
      const needs = [...new Set([...p.needs.filter((n) => n !== chave), ...removido.needs])];
      if (p.type === "action" && p.input === chave) {
        const herdado = removido.needs[0];
        return herdado === undefined ? semEntrada({ ...p, needs }) : { ...p, needs, input: herdado };
      }
      return { ...p, needs };
    });
  const { [chave]: _fora, ...layout } = spec.layout ?? {};
  return { ...spec, steps, layout };
}

/** Guarda a posição de quem foi arrastado. */
export function mover(spec: AgentSpec, chave: string, onde: Posicao): AgentSpec {
  return { ...spec, layout: { ...(spec.layout ?? {}), [chave]: { x: Math.round(onde.x), y: Math.round(onde.y) } } };
}

/* ---------------------------------------------------------- formato saída */

export const FORMATOS = {
  respostaSlack: SLACK_REPLY_SCHEMA as unknown as Record<string, unknown>,
  respostaTeams: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: { text: { type: "string" } },
  } as Record<string, unknown>,
  tarefa: CONVERSATION_ISSUE_SCHEMA as unknown as Record<string, unknown>,
  tarefaDePullRequest: ISSUE_CONTENT_SCHEMA as unknown as Record<string, unknown>,
} as const;

export type Formato = keyof typeof FORMATOS;

/** Qual formato o passo de IA tem, comparando o esquema gravado. */
export function formatoDe(passo: PassoDeIA): Formato | "livre" | "outro" {
  if (passo.outputSchema === undefined) return "livre";
  const texto = JSON.stringify(passo.outputSchema);
  for (const [nome, esquema] of Object.entries(FORMATOS)) {
    if (JSON.stringify(esquema) === texto) return nome as Formato;
  }
  return "outro";
}

function formatoPedidoPor(acao: string, gatilhos: readonly GatilhoNoCanvas[]): Formato | null {
  if (acao === "slack.post") return "respostaSlack";
  if (acao === "teams.post") return "respostaTeams";
  if (acao === "tracker.create_issue") {
    return gatilhos.some((g) => g.config.kind === "poll") ? "tarefaDePullRequest" : "tarefa";
  }
  return null;
}

/* ----------------------------------------------------------- componentes */

export type AppDoComponente = "locum" | "slack" | "teams" | "github" | "atlassian";

/** Gatilho que a paleta oferece, com a configuração que ele nasce. */
export interface ComponenteDeGatilho {
  id: TriggerConfig["kind"];
  app: AppDoComponente;
  novo: () => TriggerConfig;
}

/** Passo que a paleta oferece. */
export interface ComponenteDePasso {
  id: string;
  app: AppDoComponente;
  novo: (spec: AgentSpec) => Step;
}

export const GATILHOS: readonly ComponenteDeGatilho[] = [
  { id: "manual", app: "locum", novo: () => ({ kind: "manual" }) },
  { id: "cron", app: "locum", novo: () => ({ kind: "cron", expression: "0 9 * * 1-5" }) },
  { id: "schedule", app: "locum", novo: () => ({ kind: "schedule", everyMinutes: 60 }) },
  { id: "slack-channel", app: "slack", novo: () => ({ kind: "slack-channel", channels: [], everyMinutes: 5 }) },
  { id: "slack-inbox", app: "slack", novo: () => ({ kind: "slack-inbox", mentions: true, dms: true, everyMinutes: 5 }) },
  {
    id: "teams-inbox",
    app: "teams",
    novo: () => ({ kind: "teams-inbox", mentions: true, dms: true, channels: [], everyMinutes: 5 }),
  },
  {
    id: "poll",
    app: "github",
    novo: () => ({
      kind: "poll",
      source: "github",
      repoMatch: ".*",
      authorship: "others",
      includeDrafts: false,
      everyMinutes: 15,
    }),
  },
];

export const PASSOS: readonly ComponenteDePasso[] = [
  {
    id: "ai",
    app: "locum",
    novo: (spec) => ({
      type: "model",
      key: novaChave(spec, "analisar"),
      name: "Analisar com IA",
      needs: [],
      optional: false,
      model: MODELO_PADRAO,
      prompt: "",
      requiresServers: [],
      maxSteps: 12,
    }),
  },
  {
    id: "slack.post",
    app: "slack",
    novo: (spec) => ({
      type: "action",
      key: novaChave(spec, "responder-slack"),
      name: "Responder na thread",
      needs: [],
      optional: false,
      action: "slack.post",
      mode: "approve",
    }),
  },
  {
    id: "teams.post",
    app: "teams",
    novo: (spec) => ({
      type: "action",
      key: novaChave(spec, "responder-teams"),
      name: "Responder no Teams",
      needs: [],
      optional: false,
      action: "teams.post",
      mode: "approve",
    }),
  },
  {
    id: "tracker.create_issue",
    app: "atlassian",
    novo: (spec) => ({
      type: "action",
      key: novaChave(spec, "abrir-tarefa"),
      name: "Abrir tarefa",
      needs: [],
      optional: false,
      action: "tracker.create_issue",
      mode: "approve",
    }),
  },
  {
    id: "mcp.call",
    app: "locum",
    novo: (spec) => ({
      type: "action",
      key: novaChave(spec, "acao-em-app"),
      name: "Ação em app",
      needs: [],
      optional: false,
      action: "mcp.call",
      mode: "approve",
      params: { server: "", tool: "", args: {} },
    }),
  },
  {
    id: "http.request",
    app: "locum",
    novo: (spec) => ({
      type: "action",
      key: novaChave(spec, "chamar-api"),
      name: "Chamar API",
      needs: [],
      optional: false,
      action: "http.request",
      mode: "approve",
      params: { method: "POST", url: "", headers: {}, body: "" },
    }),
  },
];

/** Ações que não leem a saída de uma IA: o que mandam está todo em `params`. */
export const ACOES_POR_PARAMETRO: ReadonlySet<string> = new Set(["mcp.call", "http.request"]);

/** O componente da paleta que corresponde a um passo já gravado. */
export function componenteDoPasso(passo: Step): string {
  if (passo.type === "model") return passo.profile === undefined ? "ai" : "agent";
  return passo.action;
}

/** O agent da biblioteca como a paleta conhece: id, nome e modelo. */
export interface AgentDaBiblioteca {
  id: string;
  name: string;
  model: string;
}

/**
 * Passo que entrega a tarefa a um agent da biblioteca. `model` vai junto só
 * porque o esquema do passo exige; quem vale na execução é o do agent.
 */
export function passoDoAgent(spec: AgentSpec, agent: AgentDaBiblioteca): PassoDeIA {
  return {
    type: "model",
    key: novaChave(spec, agent.id),
    name: agent.name,
    needs: [],
    optional: false,
    model: agent.model,
    prompt: "",
    requiresServers: [],
    maxSteps: 12,
    profile: agent.id,
  };
}

/* -------------------------------------------------------------- variáveis */

/**
 * O que o prompt pode citar, a partir dos gatilhos e dos passos anteriores.
 * É ajuda de digitação: o executor aceita qualquer `{{event.x}}`, e o que não
 * existe no evento vira `null` no texto.
 */
export function variaveis(r: Rascunho, chave: string): string[] {
  const doEvento = new Set<string>();
  for (const g of r.gatilhos) {
    switch (g.config.kind) {
      case "slack-channel":
      case "slack-inbox":
        for (const v of ["text", "author", "channel", "threadTs", "permalink"]) doEvento.add(`event.${v}`);
        break;
      case "teams-inbox":
        for (const v of ["text", "author", "webUrl"]) doEvento.add(`event.${v}`);
        break;
      case "poll":
        for (const v of ["title", "repo", "pull", "author", "url"]) doEvento.add(`event.${v}`);
        break;
      default:
        break;
    }
  }
  const antes = anteriores(r.spec, chave).map((k) => `steps.${k}`);
  return [...doEvento, ...antes];
}

/** Todo passo de que `chave` depende, direta ou indiretamente. */
export function anteriores(spec: AgentSpec, chave: string): string[] {
  const porChave = new Map(spec.steps.map((p) => [p.key, p]));
  const vistos = new Set<string>();
  const visitar = (k: string): void => {
    for (const n of porChave.get(k)?.needs ?? []) {
      if (vistos.has(n)) continue;
      vistos.add(n);
      visitar(n);
    }
  };
  visitar(chave);
  return spec.steps.map((p) => p.key).filter((k) => vistos.has(k));
}

/* -------------------------------------------------------------- problemas */

export interface Problema {
  /** Chave do dicionário. */
  chave: string;
  /** Nó a que o problema se refere, para o canvas marcar. */
  no?: string;
  /** Impede salvar. Os outros são aviso. */
  bloqueia: boolean;
}

export interface Contexto {
  slackConectado: boolean;
  teamsConectado: boolean;
  trackers: readonly string[];
  /** Ids da biblioteca. Ausente enquanto a lista não chegou: não acusa nada. */
  agents?: readonly string[];
}

/**
 * O que está errado ou faltando, antes de gravar.
 *
 * Só bloqueia o que o serviço recusaria de qualquer jeito, ou o que quebraria
 * na primeira execução sem dizer por quê. App desconectado é aviso: a pessoa
 * pode montar a automação antes de ligar o Slack.
 */
export function problemas(r: Rascunho, ctx: Contexto): Problema[] {
  const lista: Problema[] = [];
  const kinds = new Set(r.gatilhos.map((g) => g.config.kind));
  const conversaDoSlack = kinds.has("slack-channel") || kinds.has("slack-inbox");
  const conversaDoTeams = kinds.has("teams-inbox");

  if (r.spec.name.trim() === "") lista.push({ chave: "automations.problems.noName", bloqueia: true });
  if (r.spec.steps.length === 0) lista.push({ chave: "automations.problems.noSteps", bloqueia: true });
  if (r.gatilhos.length === 0) lista.push({ chave: "automations.problems.noTrigger", bloqueia: false });

  for (const g of r.gatilhos) {
    const c = g.config;
    if (c.kind === "slack-channel" && c.channels.length === 0) {
      lista.push({ chave: "automations.problems.noChannels", no: g.chave, bloqueia: true });
    }
    if ((c.kind === "slack-channel" || c.kind === "slack-inbox") && !ctx.slackConectado) {
      lista.push({ chave: "automations.problems.slackOff", no: g.chave, bloqueia: false });
    }
    if (c.kind === "teams-inbox" && !ctx.teamsConectado) {
      lista.push({ chave: "automations.problems.teamsOff", no: g.chave, bloqueia: false });
    }
  }

  const porChave = new Map(r.spec.steps.map((p) => [p.key, p]));
  for (const p of r.spec.steps) {
    if (p.type === "model") {
      if (p.prompt.trim() === "") lista.push({ chave: "automations.problems.noPrompt", no: p.key, bloqueia: false });
      if (p.profile !== undefined && ctx.agents !== undefined && !ctx.agents.includes(p.profile)) {
        lista.push({ chave: "automations.problems.agentMissing", no: p.key, bloqueia: true });
      }
      continue;
    }
    if (p.action === "mcp.call") {
      const prm = (p.params ?? {}) as { server?: unknown; tool?: unknown };
      if (typeof prm.server !== "string" || prm.server === "" || typeof prm.tool !== "string" || prm.tool === "") {
        lista.push({ chave: "automations.problems.noTool", no: p.key, bloqueia: true });
      }
    }
    if (p.action === "http.request") {
      const url = (p.params ?? {}).url;
      if (typeof url !== "string" || !/^https?:\/\/\S+/.test(url.replace(/\{\{[^}]*\}\}/g, "x"))) {
        lista.push({ chave: "automations.problems.noUrl", no: p.key, bloqueia: true });
      }
    }
    const fonte = porChave.get(p.input ?? p.needs[0] ?? "");
    if (!ACOES_POR_PARAMETRO.has(p.action) && (fonte === undefined || fonte.type !== "model")) {
      lista.push({ chave: "automations.problems.actionWithoutAi", no: p.key, bloqueia: false });
    }
    if (p.action === "slack.post" && !conversaDoSlack) {
      lista.push({ chave: "automations.problems.slackReplyNeedsSlack", no: p.key, bloqueia: false });
    }
    if (p.action === "teams.post" && !conversaDoTeams) {
      lista.push({ chave: "automations.problems.teamsReplyNeedsTeams", no: p.key, bloqueia: false });
    }
    if (p.action === "tracker.create_issue" && (p.target === undefined || !ctx.trackers.includes(p.target))) {
      lista.push({ chave: "automations.problems.noTracker", no: p.key, bloqueia: true });
    }
  }
  return lista;
}

/* ----------------------------------------------------------------- modelos */

export type ModeloId = "blank" | "slackReply" | "slackJira" | "mentions" | "daily";

export const MODELOS: readonly ModeloId[] = ["slackReply", "slackJira", "mentions", "daily", "blank"];

const ORCAMENTO = { perRunUsd: 0.2, perDayUsd: 2 };

/**
 * Os modelos de "Nova automação". O texto dos prompts é ponto de partida, e
 * fica em português porque é o que a pessoa vai editar.
 */
export function rascunhoDoModelo(modelo: ModeloId, id: string, nome: string, tracker: string | null): Rascunho {
  const base = { id, name: nome, defaultTools: [], skills: [], budget: ORCAMENTO } satisfies Partial<AgentSpec>;
  const ia = (key: string, name: string, prompt: string, needs: string[], outputSchema?: Record<string, unknown>): PassoDeIA => ({
    type: "model",
    key,
    name,
    needs,
    optional: false,
    model: MODELO_PADRAO,
    prompt,
    requiresServers: [],
    maxSteps: 8,
    ...(outputSchema === undefined ? {} : { outputSchema }),
  });
  const acao = (key: string, name: string, action: string, input: string, target?: string): PassoDeAcao => ({
    type: "action",
    key,
    name,
    needs: [input],
    optional: false,
    action,
    mode: "approve",
    input,
    ...(target === undefined ? {} : { target }),
  });
  const gatilho = (config: TriggerConfig): GatilhoNoCanvas => ({ chave: `${PREFIXO_DE_GATILHO}1`, config, enabled: false });

  const resposta = [
    "Escreva a resposta para esta mensagem, na thread dela.",
    "",
    "Em `text`, a resposta como ela sairia no canal: direta, sem saudação",
    "de e-mail e sem repetir a pergunta. Se faltar informação, diga o que falta.",
    "",
    "Em `threadTs`, devolva exatamente o carimbo que veio abaixo.",
    "",
    "Canal: {{event.channel}}",
    "Thread: {{event.threadTs}}",
    "De: {{event.author}}",
    "",
    "Mensagem:",
    "{{event.text}}",
  ].join("\n");

  switch (modelo) {
    case "slackReply":
      return {
        spec: {
          ...base,
          steps: [
            ia("escrever", "Escrever a resposta", resposta, [], FORMATOS.respostaSlack),
            acao("responder", "Responder na thread", "slack.post", "escrever"),
          ],
        },
        gatilhos: [gatilho({ kind: "slack-channel", channels: [], everyMinutes: 5 })],
      };
    case "mentions":
      return {
        spec: {
          ...base,
          steps: [
            ia("escrever", "Escrever a resposta", resposta, [], FORMATOS.respostaSlack),
            acao("responder", "Responder na thread", "slack.post", "escrever"),
          ],
        },
        gatilhos: [gatilho({ kind: "slack-inbox", mentions: true, dms: true, everyMinutes: 5 })],
      };
    case "slackJira":
      return {
        spec: {
          ...base,
          steps: [
            ia(
              "analisar",
              "Analisar o pedido",
              [
                "Leia a mensagem abaixo e escreva a tarefa que ela pede.",
                "",
                "Em `title`, o título da tarefa, curto e específico.",
                "Em `objective`, o que precisa ficar resolvido, em uma ou duas frases.",
                "Em `changes`, o contexto: quem pediu, o que relatou, o que já se sabe.",
                "Em `testing`, como saber que terminou, em passos concretos.",
                "",
                "De: {{event.author}}",
                "",
                "Mensagem:",
                "{{event.text}}",
              ].join("\n"),
              [],
              FORMATOS.tarefa,
            ),
            acao("abrir-tarefa", "Abrir tarefa", "tracker.create_issue", "analisar", tracker ?? undefined),
            ia(
              "escrever",
              "Avisar na thread",
              [
                "Escreva uma resposta curta na thread dizendo que a tarefa foi aberta",
                "e o que vai acontecer agora. Não repita o pedido inteiro.",
                "",
                "Tarefa: {{steps.analisar.title}}",
                "Objetivo: {{steps.analisar.objective}}",
                "",
                "Em `threadTs`, devolva exatamente: {{event.threadTs}}",
              ].join("\n"),
              ["abrir-tarefa"],
              FORMATOS.respostaSlack,
            ),
            acao("responder", "Responder na thread", "slack.post", "escrever"),
          ],
        },
        gatilhos: [gatilho({ kind: "slack-channel", channels: [], everyMinutes: 5 })],
      };
    case "daily":
      return {
        spec: {
          ...base,
          steps: [
            ia(
              "resumir",
              "Resumo do dia",
              "Liste o que merece atenção hoje, a partir das ferramentas disponíveis.",
              [],
            ),
          ],
        },
        gatilhos: [gatilho({ kind: "cron", expression: "0 9 * * 1-5" })],
      };
    case "blank":
      return {
        spec: { ...base, steps: [ia("analisar", "Analisar com IA", "", [])] },
        gatilhos: [gatilho({ kind: "manual" })],
      };
  }
}
