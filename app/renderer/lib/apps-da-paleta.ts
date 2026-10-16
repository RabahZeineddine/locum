/**
 * A paleta por app, sem React. Cada serviço (Teams, Slack, GitHub...) é um app
 * que junta as ações nativas do Locum e as ferramentas do servidor MCP dele, e
 * o passo guardado continua o mesmo: `mcp.call` com servidor e ferramenta, ou a
 * ação nativa. Nada daqui muda o formato do spec; o app e a operação são lidos
 * do que já está gravado.
 */
import { ehLeituraNaAcao, type FerramentaClassificavel } from "../../src/config/leitura";
import { SERVIDOR_NATIVO, type AgentSpec, type Step } from "../../src/config/types";
import { novaChave, PASSOS } from "./automacao";
import { agruparPor, classificarOperacao, tituloDaOperacao, type Traduzir } from "./operacao-da-ferramenta";
import { casaBusca, humanizar, modoParaFerramenta, passoDeFerramenta, slug, type ConexaoParaPaleta } from "./paleta-conexoes";

type PassoDeAcao = Extract<Step, { type: "action" }>;

/** As ações nativas de cada app do Locum, na ordem em que aparecem. */
const NATIVAS_POR_APP: Record<string, readonly string[]> = {
  teams: ["teams.post", "teams.react"],
  slack: ["slack.post", "slack.react"],
  // A publicação da review (`github.review_comment`) vem do modelo de revisão, não da paleta: depende de evento de PR.
  github: [],
  tracker: ["tracker.create_issue"],
  http: ["http.request"],
};

/** Servidor conhecido pelo pedaço do nome. O que não casa é o próprio app. */
const APP_POR_NOME: readonly [RegExp, string][] = [
  [/slack/, "slack"],
  [/github/, "github"],
  [/jira|atlassian|shortcut|linear|tracker/, "tracker"],
  [/teams/, "teams"],
  [/ms365|microsoft|office365|outlook/, "microsoft365"],
];

export function appDoServidor(servidor: string): string {
  if (servidor === SERVIDOR_NATIVO) return "locum";
  const nome = servidor.toLowerCase();
  return APP_POR_NOME.find(([padrao]) => padrao.test(nome))?.[1] ?? nome;
}

/** Recursos do ms365 que são do Teams: o resto (e-mail, calendário, arquivos) fica no Microsoft 365. */
const RECURSOS_DO_TEAMS = new Set(["chat", "channel", "team", "message", "reaction", "thread"]);

/**
 * O app de uma ferramenta. Cada uma pertence a um app só: o servidor do
 * Microsoft 365 reparte as de chat e canal para o Teams.
 */
export function appDaFerramenta(servidor: string, ferramenta: string): string {
  const app = appDoServidor(servidor);
  if (app !== "microsoft365") return app;
  const { recurso } = classificarOperacao(ferramenta, servidor);
  return recurso !== null && RECURSOS_DO_TEAMS.has(recurso) ? "teams" : app;
}

export interface AppDaPaleta {
  id: string;
  /** Ações nativas do Locum deste app. */
  nativas: string[];
  /** Servidores MCP ligados que pertencem ao app. */
  servidores: string[];
  /** Há servidor do app cuja lista de ferramentas nunca foi lida. */
  semLista: boolean;
}

const SEM_TRADUCAO: Traduzir = () => undefined;

function appsDe(conexoes: readonly ConexaoParaPaleta[], ferramentas: readonly OperacaoDoApp[]): AppDaPaleta[] {
  const apps = new Map<string, AppDaPaleta>();
  for (const [id, nativas] of Object.entries(NATIVAS_POR_APP)) apps.set(id, { id, nativas: [...nativas], servidores: [], semLista: false });
  for (const c of conexoes) {
    const padrao = appDoServidor(c.servidor);
    // O servidor aparece em cada app que tem ferramenta dele, e sempre no do próprio nome.
    const ids = new Set([padrao, ...ferramentas.filter((o) => o.servidor === c.servidor).map((o) => o.app)]);
    for (const id of ids) {
      const app = apps.get(id) ?? { id, nativas: [], servidores: [], semLista: false };
      app.servidores.push(c.servidor);
      app.semLista ||= c.ferramentas === null && id === padrao;
      apps.set(id, app);
    }
  }
  return [...apps.values()];
}

export function appsDaPaleta(conexoes: readonly ConexaoParaPaleta[]): AppDaPaleta[] {
  return appsDe(conexoes, conexoes.flatMap((c) => doServidor(c, SEM_TRADUCAO)));
}

/** O nome que `marcaDoServidor` reconhece para o ícone do app: o do catálogo de Conexões, ou o servidor. */
export function fonteDaMarca(app: AppDaPaleta): string {
  if (app.id === "tracker") return app.servidores[0] ?? "atlassian";
  if (app.id === "microsoft365") return "ms365";
  return app.id;
}

/** O servidor que o nó sem operação guarda: o primeiro do app, ou o id dele quando só há ações do Locum. */
export function servidorDoNoVazio(app: AppDaPaleta): string {
  return app.servidores[0] ?? app.id;
}

export function nomeDoApp(id: string, traduzir: Traduzir): string {
  return traduzir(`app.${id}`) ?? humanizar(id);
}

/** Uma operação que a pessoa pode escolher dentro de um app. */
export interface OperacaoDoApp {
  /** Estável e única: `teams.react` ou `ms365/set-chat-message-reaction`. */
  chave: string;
  app: string;
  tipo: "nativa" | "ferramenta";
  /** Só nas nativas: `teams.react`. */
  acao?: string;
  servidor?: string;
  ferramenta?: string;
  /** "Reagir", "Listar canais": o nome legível. */
  titulo: string;
  recurso: string | null;
  /** Só lê, pelo critério do executor. Nativa sempre escreve. */
  leitura: boolean;
  descricao: string;
  classificavel?: FerramentaClassificavel;
  inputSchema?: Record<string, unknown>;
}

function nativa(app: string, acao: string, traduzir: Traduzir): OperacaoDoApp {
  return {
    chave: acao,
    app,
    tipo: "nativa",
    acao,
    titulo: traduzir(`native.${acao.replace(".", "_")}`) ?? humanizar(acao.replace(".", " ")),
    recurso: null,
    leitura: false,
    descricao: "",
  };
}

function doServidor(c: ConexaoParaPaleta, traduzir: Traduzir): OperacaoDoApp[] {
  return (c.ferramentas ?? []).map((f) => ({
    chave: `${c.servidor}/${f.name}`,
    app: appDaFerramenta(c.servidor, f.name),
    tipo: "ferramenta",
    servidor: c.servidor,
    ferramenta: f.name,
    titulo: tituloDaOperacao(f.name, traduzir, c.servidor),
    recurso: classificarOperacao(f.name, c.servidor).recurso,
    leitura: ehLeituraNaAcao(f),
    descricao: f.description ?? "",
    classificavel: f,
    ...(f.inputSchema !== undefined ? { inputSchema: f.inputSchema } : {}),
  }));
}

function separar(app: string, nativas: readonly OperacaoDoApp[], ferramentas: readonly OperacaoDoApp[]) {
  const doApp = ferramentas.filter((o) => o.app === app);
  return {
    nativas: nativas.filter((o) => o.app === app),
    grupos: agruparPor(doApp, (o) => o.recurso),
    servidores: [...new Set(doApp.map((o) => o.servidor!))],
  };
}

function nativasDaPaleta(traduzir: Traduzir): OperacaoDoApp[] {
  return Object.entries(NATIVAS_POR_APP).flatMap(([app, acoes]) => acoes.map((a) => nativa(app, a, traduzir)));
}

/**
 * As ações do Locum primeiro; as ferramentas dos servidores do app, por
 * recurso. `servidores` são os que dão ferramenta ao app: com mais de um, cada
 * operação mostra o dela.
 */
export function operacoesDoApp(
  app: string,
  conexoes: readonly ConexaoParaPaleta[],
  traduzir: Traduzir,
): {
  nativas: OperacaoDoApp[];
  grupos: { recurso: string | null; itens: OperacaoDoApp[] }[];
  servidores: string[];
} {
  return separar(app, nativasDaPaleta(traduzir), conexoes.flatMap((c) => doServidor(c, traduzir)));
}

/**
 * A busca global: apps pelo nome e operações pelo título, pelo nome da
 * ferramenta ou pela descrição. Ação nativa sai antes da ferramenta. Busca
 * vazia devolve só os apps, sem lista de operações. Cada ferramenta é
 * classificada uma vez.
 */
export function buscarNaPaleta(
  conexoes: readonly ConexaoParaPaleta[],
  busca: string,
  traduzir: Traduzir,
): { apps: AppDaPaleta[]; operacoes: OperacaoDoApp[] } {
  const ferramentas = conexoes.flatMap((c) => doServidor(c, traduzir));
  const apps = appsDe(conexoes, ferramentas);
  if (busca.trim() === "") return { apps, operacoes: [] };
  const ordem = new Map(apps.map((a, i) => [a.id, i]));
  const porApp = (a: OperacaoDoApp, b: OperacaoDoApp): number => (ordem.get(a.app) ?? 0) - (ordem.get(b.app) ?? 0);
  const todas = [...nativasDaPaleta(traduzir), ...[...ferramentas].sort(porApp)];
  return {
    apps: apps.filter((a) => casaBusca(busca, nomeDoApp(a.id, traduzir), a.id)),
    operacoes: todas.filter((o) => casaBusca(busca, o.titulo, o.ferramenta, o.acao, o.descricao)),
  };
}

export type OperacaoDoPasso =
  | { tipo: "vazia" }
  | { tipo: "nativa"; acao: string }
  | { tipo: "ferramenta"; servidor: string; ferramenta: string }
  | { tipo: "modelo" }
  | { tipo: "logica"; op: string };

/** App e operação de um passo gravado, lidos de `action`, `server` e `tool`. Sem migração. */
export function reconhecerPasso(passo: Step): { app: string; operacao: OperacaoDoPasso } {
  if (passo.type === "model") return { app: "ia", operacao: { tipo: "modelo" } };
  if (passo.type === "logic") return { app: "logica", operacao: { tipo: "logica", op: passo.op } };
  if (passo.action !== "mcp.call") return { app: passo.action.split(".")[0]!, operacao: { tipo: "nativa", acao: passo.action } };
  const params = (passo.params ?? {}) as { server?: unknown; tool?: unknown };
  const servidor = typeof params.server === "string" ? params.server : "";
  const ferramenta = typeof params.tool === "string" ? params.tool : "";
  return {
    app: servidor === "" ? "mcp" : ferramenta === "" ? appDoServidor(servidor) : appDaFerramenta(servidor, ferramenta),
    operacao: ferramenta === "" ? { tipo: "vazia" } : { tipo: "ferramenta", servidor, ferramenta },
  };
}

/**
 * O nó de um app com a operação ainda por escolher: um `mcp.call` sem
 * ferramenta, que `reconhecerPasso` lê como app sem operação. O servidor
 * guardado é o do app, ou o id dele quando o app só tem ações do Locum.
 */
export function passoSemOperacao(spec: AgentSpec, app: string, nome: string, servidor?: string): PassoDeAcao {
  return {
    type: "action",
    key: novaChave(spec, slug(app) || "acao-em-app"),
    name: nome,
    needs: [],
    optional: false,
    action: "mcp.call",
    mode: "approve",
    params: { server: servidor ?? app, tool: "", args: {} },
  };
}

/** O nome que o passo ganharia sozinho: se é este, a pessoa não renomeou. */
function nomePadrao(passo: PassoDeAcao, spec: AgentSpec): string | null {
  const { operacao } = reconhecerPasso(passo);
  if (operacao.tipo === "vazia") return passo.name;
  if (operacao.tipo === "ferramenta") return humanizar(operacao.ferramenta);
  if (operacao.tipo === "nativa") return PASSOS.find((p) => p.id === operacao.acao)?.novo(spec).name ?? null;
  return null;
}

/** A fonte do ícone de marca do app do passo, para o card do canvas. */
export function fonteDaMarcaDoPasso(passo: Step): string {
  const { app, operacao } = reconhecerPasso(passo);
  return fonteDaMarca({ id: app, nativas: [], servidores: operacao.tipo === "ferramenta" ? [operacao.servidor] : [], semLista: false });
}

/** Se o passo é de um app com lista de operações (e não do Locum por dentro, como digest e contexto). */
export function temTrocaDeOperacao(passo: Step): boolean {
  if (passo.type !== "action") return false;
  const { app, operacao } = reconhecerPasso(passo);
  return operacao.tipo === "nativa" ? (NATIVAS_POR_APP[app] ?? []).includes(operacao.acao) : app !== "mcp";
}

/** Se a pessoa deu um nome ao passo, em vez de ficar com o que a operação põe sozinha. */
export function foiRenomeado(passo: Step, spec: AgentSpec): boolean {
  if (passo.type !== "action") return false;
  const padrao = nomePadrao(passo, spec);
  return passo.name !== "" && padrao !== null && passo.name !== padrao;
}

/** O título legível da operação do passo, ou nulo para passo sem operação, de modelo e de lógica. */
export function tituloDaOperacaoDoPasso(passo: Step, traduzir: Traduzir): string | null {
  if (passo.type !== "action") return null;
  const { operacao } = reconhecerPasso(passo);
  if (operacao.tipo === "nativa") return nativa("", operacao.acao, traduzir).titulo;
  if (operacao.tipo === "ferramenta") return tituloDaOperacao(operacao.ferramenta, traduzir, operacao.servidor);
  return null;
}

/**
 * O passo depois de escolher ou trocar a operação. A chave, as dependências, a
 * condição e o nome renomeado ficam. Os argumentos que a nova ferramenta
 * também declara ficam. O modo é recalculado pela regra de escrita: escrita
 * volta para aprovação, e `autoEscrita` nunca passa para a ferramenta nova.
 */
export function passoDaOperacao(spec: AgentSpec, op: OperacaoDoApp, anterior?: Step): Step {
  const antes = anterior?.type === "action" ? anterior : undefined;
  if (antes !== undefined && ehAOperacao(antes, op)) return antes;
  const novo: PassoDeAcao =
    op.tipo === "ferramenta"
      ? (passoDeFerramenta(spec, op.servidor!, op.classificavel ?? { name: op.ferramenta! }) as PassoDeAcao)
      : (PASSOS.find((p) => p.id === op.acao)?.novo(spec) as PassoDeAcao | undefined) ?? {
          type: "action",
          key: novaChave(spec, op.acao!.replace(".", "-")),
          name: op.titulo,
          needs: [],
          optional: false,
          action: op.acao!,
          mode: "approve",
        };
  if (antes === undefined) return novo;

  // O nó sem operação nasce como o da busca: a leitura em automático, a escrita em aprovação.
  const vazio = reconhecerPasso(antes).operacao.tipo === "vazia";
  const resultado: PassoDeAcao = {
    ...novo,
    key: antes.key,
    name: foiRenomeado(antes, spec) ? antes.name : novo.name,
    needs: antes.needs,
    optional: antes.optional,
    ...(antes.when !== undefined ? { when: antes.when } : {}),
    ...(antes.input !== undefined ? { input: antes.input } : {}),
    // O destino é o do tracker cadastrado: só a ação do tracker o entende.
    ...(antes.target !== undefined && op.acao === "tracker.create_issue" ? { target: antes.target } : {}),
  };
  if (op.tipo === "ferramenta") {
    const argsAntes = ((antes.params as { args?: Record<string, unknown> } | undefined)?.args ?? {}) as Record<string, unknown>;
    // Sem schema não há como saber o que a ferramenta aceita: os argumentos ficam.
    const declarados = op.inputSchema === undefined ? null : Object.keys((op.inputSchema.properties ?? {}) as Record<string, unknown>);
    const args = declarados === null ? argsAntes : Object.fromEntries(Object.entries(argsAntes).filter(([nome]) => declarados.includes(nome)));
    resultado.params = { server: op.servidor!, tool: op.ferramenta!, args };
    resultado.mode = vazio ? novo.mode : modoParaFerramenta(antes.mode, false, op.classificavel ?? { name: op.ferramenta! });
  } else {
    resultado.mode = vazio ? novo.mode : antes.mode === "auto" ? "approve" : antes.mode;
  }
  return resultado;
}

function ehAOperacao(passo: PassoDeAcao, op: OperacaoDoApp): boolean {
  const { operacao } = reconhecerPasso(passo);
  if (operacao.tipo === "nativa") return op.tipo === "nativa" && operacao.acao === op.acao;
  return operacao.tipo === "ferramenta" && op.tipo === "ferramenta" && operacao.servidor === op.servidor && operacao.ferramenta === op.ferramenta;
}
