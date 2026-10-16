/**
 * A paleta por app, sem React. Cada serviço (Teams, Slack, GitHub...) é um app
 * que junta as ações nativas do Locum e as ferramentas do servidor MCP dele, e
 * o passo guardado continua o mesmo: `mcp.call` com servidor e ferramenta, ou a
 * ação nativa. Nada daqui muda o formato do spec; o app e a operação são lidos
 * do que já está gravado.
 */
import { ehLeituraNaAcao, type FerramentaClassificavel } from "../../src/config/leitura";
import type { AgentSpec, Step } from "../../src/config/types";
import { novaChave, PASSOS } from "./automacao";
import { agruparPor, classificarOperacao, tituloDaOperacao, type Traduzir } from "./operacao-da-ferramenta";
import { casaBusca, humanizar, modoParaFerramenta, passoDeFerramenta, type ConexaoParaPaleta } from "./paleta-conexoes";

type PassoDeAcao = Extract<Step, { type: "action" }>;

/** As ações nativas de cada app do Locum, na ordem em que aparecem. */
const NATIVAS_POR_APP: Record<string, readonly string[]> = {
  teams: ["teams.post", "teams.react"],
  slack: ["slack.post", "slack.react"],
  github: ["github.review_comment"],
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
  const nome = servidor.toLowerCase();
  return APP_POR_NOME.find(([padrao]) => padrao.test(nome))?.[1] ?? nome;
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

export function appsDaPaleta(conexoes: readonly ConexaoParaPaleta[]): AppDaPaleta[] {
  const apps = new Map<string, AppDaPaleta>();
  for (const [id, nativas] of Object.entries(NATIVAS_POR_APP)) apps.set(id, { id, nativas: [...nativas], servidores: [], semLista: false });
  for (const c of conexoes) {
    const id = appDoServidor(c.servidor);
    const app = apps.get(id) ?? { id, nativas: [], servidores: [], semLista: false };
    app.servidores.push(c.servidor);
    app.semLista ||= c.ferramentas === null;
    apps.set(id, app);
  }
  return [...apps.values()];
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

function doServidor(app: string, c: ConexaoParaPaleta, traduzir: Traduzir): OperacaoDoApp[] {
  return (c.ferramentas ?? []).map((f) => ({
    chave: `${c.servidor}/${f.name}`,
    app,
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

/** As ações do Locum primeiro; as ferramentas dos servidores do app, por recurso. */
export function operacoesDoApp(
  app: string,
  conexoes: readonly ConexaoParaPaleta[],
  traduzir: Traduzir,
): { nativas: OperacaoDoApp[]; grupos: { recurso: string | null; itens: OperacaoDoApp[] }[] } {
  const nativas = (NATIVAS_POR_APP[app] ?? []).map((a) => nativa(app, a, traduzir));
  const ferramentas = conexoes.filter((c) => appDoServidor(c.servidor) === app).flatMap((c) => doServidor(app, c, traduzir));
  return { nativas, grupos: agruparPor(ferramentas, (o) => o.recurso) };
}

/**
 * A busca global: apps pelo nome e operações pelo título, pelo nome da
 * ferramenta ou pela descrição. Ação nativa sai antes da ferramenta. Busca
 * vazia devolve só os apps, sem lista de operações.
 */
export function buscarNaPaleta(
  conexoes: readonly ConexaoParaPaleta[],
  busca: string,
  traduzir: Traduzir,
): { apps: AppDaPaleta[]; operacoes: OperacaoDoApp[] } {
  const apps = appsDaPaleta(conexoes);
  if (busca.trim() === "") return { apps, operacoes: [] };
  const porApp = apps.map((a) => operacoesDoApp(a.id, conexoes, traduzir));
  const todas = [...porApp.flatMap((o) => o.nativas), ...porApp.flatMap((o) => o.grupos.flatMap((g) => g.itens))];
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
    app: servidor === "" ? "mcp" : appDoServidor(servidor),
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
    key: novaChave(spec, app),
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
  if (operacao.tipo === "ferramenta") return humanizar(operacao.ferramenta);
  if (operacao.tipo === "nativa") return PASSOS.find((p) => p.id === operacao.acao)?.novo(spec).name ?? null;
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

  const renomeado = antes.name !== "" && nomePadrao(antes, spec) !== null && antes.name !== nomePadrao(antes, spec);
  const resultado: PassoDeAcao = {
    ...novo,
    key: antes.key,
    name: renomeado ? antes.name : novo.name,
    needs: antes.needs,
    optional: antes.optional,
    ...(antes.when !== undefined ? { when: antes.when } : {}),
    ...(antes.input !== undefined ? { input: antes.input } : {}),
    ...(antes.target !== undefined ? { target: antes.target } : {}),
  };
  if (op.tipo === "ferramenta") {
    const declarados = Object.keys(((op.inputSchema?.properties ?? {}) as Record<string, unknown>));
    const argsAntes = ((antes.params as { args?: Record<string, unknown> } | undefined)?.args ?? {}) as Record<string, unknown>;
    const args = Object.fromEntries(Object.entries(argsAntes).filter(([nome]) => declarados.includes(nome)));
    resultado.params = { server: op.servidor!, tool: op.ferramenta!, args };
    resultado.mode = modoParaFerramenta(antes.mode, false, op.classificavel ?? { name: op.ferramenta! });
  } else {
    const mesma = reconhecerPasso(antes).operacao;
    if (mesma.tipo === "nativa" && mesma.acao === op.acao) {
      if (antes.params !== undefined) resultado.params = antes.params;
      resultado.mode = antes.mode;
    } else {
      resultado.mode = antes.mode === "auto" ? "approve" : antes.mode;
    }
  }
  return resultado;
}

