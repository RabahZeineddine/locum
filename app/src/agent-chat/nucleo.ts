import { createHash, randomUUID } from "node:crypto";
import { contarGastoDoProvedor } from "../runtimes/limites-lidos.js";
import { stepCountIs, streamText, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import type { MarcaDaConversa } from "./tipos.js";
import type { ToolRef } from "../config/types.js";
import { BudgetExceeded } from "../executor/budget.js";
import type { McpRegistry } from "../mcp/registry.js";
import { prefixoDoServidor } from "../runtimes/claude-account.js";
import { compactarHistorico, TETO_DO_HISTORICO } from "../services/chat-history.js";
import { pidVivo, VALIDADE_DA_TRAVA_MS } from "./trava.js";
import { costOf, type ModelPrice } from "../services/price-service.js";
import {
  aplicarEvento,
  type Cartao,
  type EstadoDaConversa,
  type EventoDaConversa,
  type EventoDoAgent,
  type FalaDoAgent,
} from "./tipos.js";

/** Quantas falas ficam guardadas por conversa, como no assistente. */
const FALAS_GUARDADAS = 200;

/** O que o cartão mostra do resultado da ferramenta. */
const TETO_DO_RESULTADO = 4_000;

export type ModeloEscolhido =
  | { via: "api"; provedor: string; modelo: string; model: LanguageModel }
  | { via: "claude-code"; modelo: string };

/** O que o Claude Code ouve de quem decide: roda a chamada como veio, ou nega com a explicação. */
export type DecisaoDaAssinatura = { permitir: true; entrada: unknown } | { permitir: false; mensagem: string };

export interface PedidoDaAssinatura {
  texto: string;
  modelo: string;
  system: string;
  sessao: string | undefined;
  /** A leitura liberada: entra em `--allowedTools`. */
  leitura: ToolRef[];
  /** A escrita que pede clique: passa pela ferramenta de permissão. */
  confirmar: ToolRef[];
  /** As ferramentas do próprio Locum para esta conversa: sobem num servidor MCP local e entram liberadas. */
  locais: FerramentaLocal[];
  maxSteps: number;
  /** Chamado quando o Claude Code quer usar uma ferramenta que não estava liberada. Espera o clique. */
  aprovar: (nome: string, entrada: unknown, usoId?: string) => Promise<DecisaoDaAssinatura>;
  emitir: (evento: EventoDoAgent) => void;
  sinal: AbortSignal;
}

export interface Gasto {
  usd: number;
  tokens: number;
}

/**
 * Uma ferramenta que o Locum dá à conversa, fora das conexões MCP do agent. É o que
 * a conversa do run usa para agir (ADR 0009): uma definição só, que vira ferramenta do
 * AI SDK no caminho por API e ferramenta de um servidor MCP local no do Claude Code.
 */
export interface FerramentaLocal {
  nome: string;
  descricao: string;
  /** A forma da entrada, no formato do `McpServer` (campos zod). */
  entrada: z.ZodRawShape;
  executar: (entrada: Record<string, unknown>, sinal: AbortSignal) => Promise<unknown>;
}

/** O que muda de uma conversa para outra a cada volta: quem é o contexto do modelo e para onde vai o gasto. */
export interface ContextoDaVolta {
  /** Id do modelo da conversa (`provedor/modelo`). */
  modelo: string;
  /** O system para o runtime (`native` ou `claude-code`). */
  system: (runtimeId: string) => string;
  maxSteps: number;
  temperature?: number;
  leitura: ToolRef[];
  confirmar: ToolRef[];
  locais: FerramentaLocal[];
  /** Antes de cada volta: lança `BudgetExceeded` quando o teto estourou. */
  checar: (gasto: Gasto) => Promise<void>;
  /** Depois da volta, com o que ela gastou. `novaMensagem` é falso na continuação depois de um clique. */
  gastar: (gasto: Gasto, novaMensagem: boolean) => Promise<void>;
}

export type CampoGuardado = "falas" | "sessao" | "trava";

/** Onde a conversa guarda falas, sessão do Claude Code e trava entre processos. */
export interface Armazem {
  ler: (id: string, campo: CampoGuardado) => Promise<string | undefined>;
  gravar: (id: string, campo: CampoGuardado, valor: string) => Promise<void>;
}

/** Tudo que o núcleo de turno não sabe sozinho: de quem é a conversa, onde ela mora e com que contexto ela roda. */
export interface ProvedorDeConversa {
  /** A chave da conversa nos eventos. */
  chave: (id: string) => string;
  armazem: Armazem;
  contexto: (id: string) => Promise<ContextoDaVolta>;
  /** O que o estado mostra além das falas. */
  estado: (id: string) => Promise<DoProvedorNoEstado>;
  /** Um texto que muda quando algo do que `estado` mostra além das falas muda (o alvo e o gasto do run, por exemplo). Ausente, só as falas contam. */
  marca?: (id: string) => Promise<string>;
}

export type DoProvedorNoEstado = Pick<EstadoDaConversa, "semServidor" | "semSkill" | "contaIgnorada"> & Partial<Pick<EstadoDaConversa, "run">>;

export interface DepsDoNucleo {
  mcp: () => Promise<Pick<McpRegistry, "toolsFor" | "toolsComAprovacao">>;
  modelo: (id: string) => Promise<ModeloEscolhido>;
  preco: (provedor: string, modelo: string) => Promise<ModelPrice | undefined>;
  /** Sobe o Claude Code da assinatura. Ausente, o modelo `claude-code/...` não conversa. */
  assinatura?: (pedido: PedidoDaAssinatura) => Promise<{ sessao: string | undefined; gasto: Gasto }>;
  emitir: (evento: EventoDaConversa) => void;
  /** O texto de produto, no idioma da janela. */
  texto: (chave: string, variaveis?: Record<string, unknown>) => string;
  /** Teto do histórico mandado ao modelo. */
  teto?: number;
  /** Quem é este processo e como saber se o outro ainda vive. Ausente, o pid real. */
  processo?: { pid: number; vivo: (pid: number) => boolean };
  /** O relógio, em ms. Ausente, `Date.now`. */
  agora?: () => number;
  /** Prazos, em ms: do cartão à espera de clique e da trava sem renovação. */
  prazos?: { cartaoMs?: number; travaMs?: number };
}

/** O cartão de uma volta por API que ninguém decide não segura a conversa para sempre. */
const PRAZO_DO_CARTAO_MS = 10 * 60 * 1000;

type Decisao = "executar" | "recusar";

interface Pendente {
  /** Só no caminho do Claude Code: o processo está parado esperando esta resposta. */
  resolver?: (decisao: Decisao | "expirou") => void;
  decisao?: Decisao;
  /** Até quando o cartão espera o clique. Só no caminho por API, onde ninguém fica parado nele. */
  ate?: number;
}

interface Conversa {
  id: string;
  falas: FalaDoAgent[];
  /** O que o modelo enxerga. Nulo até a primeira volta, quando nasce das falas guardadas. */
  historico: ModelMessage[] | null;
  pendentes: Map<string, Pendente>;
  /** Id da chamada no modelo para o do cartão, para o resultado cair nele. */
  chamadas: Map<string, string>;
  respondendo: boolean;
  resumido: boolean;
  /** O que a conversa já gastou, para o teto por execução valer sobre ela inteira. */
  gasto: Gasto;
  seq: number;
  /** Sobe quando a conversa é limpa: o que a volta antiga ainda emitir não vale mais. */
  geracao: number;
  cancelar?: AbortController;
  /** Renova a trava enquanto a conversa é deste processo. */
  batimento?: ReturnType<typeof setInterval>;
}

function cortar(texto: string): string {
  return texto.length > TETO_DO_RESULTADO ? `${texto.slice(0, TETO_DO_RESULTADO)}...` : texto;
}

/** As ferramentas locais como o AI SDK as quer: sem `needsApproval`, porque nenhuma escreve fora (ADR 0009). */
function ferramentasLocais(locais: FerramentaLocal[], sinal: AbortSignal): ToolSet {
  return Object.fromEntries(
    locais.map((l) => [
      l.nome,
      tool({
        description: l.descricao,
        inputSchema: z.object(l.entrada),
        execute: async (entrada: Record<string, unknown>) => l.executar(entrada, sinal),
      }),
    ]),
  );
}

/** O resultado de uma ferramenta como a pessoa lê: o texto do `content` do MCP, ou o JSON quando não há texto. */
export function legivel(valor: unknown): string {
  if (typeof valor === "string") return cortar(valor);
  const conteudo = (valor as { content?: unknown } | null)?.content;
  if (Array.isArray(conteudo)) {
    const textos = (conteudo as { type?: string; text?: unknown }[]).flatMap((p) =>
      p?.type === "text" && typeof p.text === "string" ? [p.text] : [],
    );
    if (textos.length > 0) return cortar(textos.join("\n"));
  }
  return cortar(JSON.stringify(valor, null, 2) ?? "");
}

/**
 * O motor de turno de uma conversa: trava entre processos, falas guardadas,
 * cancelamento, compactação e eventos. Quem a conversa é (o agent da biblioteca
 * ou um run) vem do `ProvedorDeConversa`, que dá a chave, o armazém e o contexto
 * de cada volta.
 *
 * Com o contexto de um agent, a leitura liberada roda direto. A escrita que a pessoa
 * ligou na conexão (`confirmar`) para num cartão e só roda no clique, uma
 * chamada por vez: no caminho por API, pelo mecanismo de aprovação do AI SDK
 * (`needsApproval`, com a resposta devolvida na volta seguinte); no do Claude
 * Code, pela ferramenta de permissão do CLI, que fica esperando o clique.
 *
 * O cartão vive aqui, no processo principal, e não na janela: trocar de tela
 * não o perde. O que não sobrevive é o processo, e o cartão guardado volta
 * como expirado.
 */
export class NucleoDeConversa {
  private readonly conversas = new Map<string, Promise<Conversa>>();

  constructor(
    private readonly deps: DepsDoNucleo,
    private readonly provedor: ProvedorDeConversa,
  ) {}

  private agora(): number {
    return (this.deps.agora ?? Date.now)();
  }

  private get travaMs(): number {
    return this.deps.prazos?.travaMs ?? VALIDADE_DA_TRAVA_MS;
  }

  /** Há uma volta em andamento, deste processo ou de outro. Mais leve que `estado`: não monta o que o provedor mostra. */
  async ocupada(id: string): Promise<boolean> {
    const conversa = await this.obter(id);
    return conversa.respondendo || (await this.outroNaConversa(id)) !== null;
  }

  /**
   * O retrato mais leve que há: se há volta em andamento e uma marca que muda quando as falas guardadas
   * ou o que o provedor mostra além delas mudam. A janela a consulta de tempos em tempos e só pede o
   * `estado` inteiro quando a marca anda.
   */
  async marca(id: string): Promise<MarcaDaConversa> {
    const guardadas = (await this.provedor.armazem.ler(id, "falas")) ?? "";
    const doProvedor = (await this.provedor.marca?.(id)) ?? "";
    return { ocupada: await this.ocupada(id), versao: createHash("sha1").update(guardadas).update("\0").update(doProvedor).digest("hex") };
  }

  async estado(id: string): Promise<EstadoDaConversa> {
    const conversa = await this.obter(id);
    await this.expirarVencidos(conversa);
    if (conversa.respondendo || conversa.pendentes.size > 0) await this.renovarTrava(conversa);
    const outro = await this.outroNaConversa(id);
    await this.reler(conversa, outro !== null);
    const doProvedor = await this.provedor.estado(id);
    return {
      falas: conversa.falas.map((f) => ({ ...f, cartoes: f.cartoes.map((c) => ({ ...c })) })),
      respondendo: conversa.respondendo || outro !== null,
      outroProcesso: outro !== null,
      resumido: conversa.resumido,
      ...doProvedor,
      seq: conversa.seq,
    };
  }

  /**
   * Uma mensagem da pessoa. Volta quando a volta termina, ou para num cartão
   * (caminho por API). `aoComecar` avisa que a conversa foi tomada e a volta
   * vai correr: antes disso, recusa chega como erro de quem chamou.
   */
  async enviar(id: string, texto: string, aoComecar?: () => void): Promise<void> {
    const conversa = await this.obter(id);
    if (conversa.respondendo) {
      this.emitir(conversa, { tipo: "erro", mensagem: this.deps.texto("agentChat.errors.busy") });
      return;
    }
    if (conversa.pendentes.size > 0) {
      this.emitir(conversa, { tipo: "erro", mensagem: this.deps.texto("agentChat.errors.pending") });
      return;
    }
    // O outro processo pode ter falado desde a última vez: parte do que está no disco, e não da memória.
    await this.tomarTrava(conversa);
    await this.reler(conversa, false);
    conversa.falas.push({ de: "user", texto, ferramentas: [], cartoes: [] }, { de: "assistant", texto: "", ferramentas: [], cartoes: [] });
    // A pergunta fica guardada já: se o processo morrer no meio da volta, ela não some.
    await this.salvar(conversa);
    aoComecar?.();
    await this.rodar(conversa, { texto });
  }

  /** O clique do cartão. Para o modelo por API, a volta continua daqui. */
  async decidir(id: string, cartao: string, decisao: Decisao): Promise<void> {
    const conversa = await this.obter(id);
    await this.expirarVencidos(conversa);
    // Outro processo tomou a conversa (ou o pid foi reaproveitado): o cartão que ficou aqui não vale mais.
    if (conversa.pendentes.size > 0 && !(await this.renovarTrava(conversa))) {
      this.expirarPendentes(conversa);
      throw new Error(this.deps.texto("agentChat.errors.expired"));
    }
    const pendente = conversa.pendentes.get(cartao);
    if (pendente === undefined) {
      if ((await this.outroNaConversa(id)) !== null) throw new Error(this.deps.texto("agentChat.errors.otherProcess"));
      throw new Error(this.deps.texto("agentChat.errors.expired"));
    }
    // No caminho por API o cartão só vale com a volta terminada: antes, o passo ainda corre.
    if (pendente.resolver === undefined && conversa.respondendo) throw new Error(this.deps.texto("agentChat.errors.busy"));

    // "Executado" só depois que a ferramenta responde; até lá, executando.
    this.emitir(conversa, { tipo: "cartao-estado", id: cartao, estado: decisao === "executar" ? "executando" : "recusado" });
    // O clique fica guardado antes de a ferramenta rodar: se o processo morrer no meio, o cartão volta como "sem saber se saiu".
    await this.salvar(conversa);
    if (pendente.resolver !== undefined) {
      conversa.pendentes.delete(cartao);
      pendente.resolver(decisao);
      return;
    }
    pendente.decisao = decisao;
    // Todas as escritas da volta precisam de resposta, senão uma chamada fica sem resultado.
    if ([...conversa.pendentes.values()].some((p) => p.decisao === undefined)) return;

    const respostas = [...conversa.pendentes.entries()].map(([approvalId, p]) => ({
      type: "tool-approval-response" as const,
      approvalId,
      approved: p.decisao === "executar",
      ...(p.decisao === "executar" ? {} : { reason: "A pessoa recusou esta chamada. Não insista sem ela pedir." }),
    }));
    conversa.pendentes.clear();
    await this.rodar(conversa, { continuacao: { role: "tool", content: respostas } });
  }

  /**
   * Toma a conversa do outro processo: o cartão que ele deixava à espera
   * expira e a vez fica livre. É a saída quando o dono da trava não responde
   * mais (o pid pode ter sido reaproveitado por outro programa).
   */
  async tomar(id: string): Promise<void> {
    const conversa = await this.obter(id);
    if (conversa.respondendo || conversa.pendentes.size > 0) return;
    if ((await this.outroNaConversa(id)) === null) return;
    conversa.falas = await this.lerFalas(id, false);
    conversa.historico = null;
    conversa.seq += 1;
    await this.salvar(conversa);
    await this.provedor.armazem.gravar(id, "trava", "");
  }

  /** Interrompe a volta e expira o que ainda espera clique. */
  cancelar(id: string): void {
    const pronta = this.conversas.get(id);
    if (pronta === undefined) return;
    void pronta.then(async (conversa) => {
      conversa.cancelar?.abort();
      if (this.expirarPendentes(conversa)) {
        await this.salvar(conversa);
        await this.soltarSeQuieta(conversa);
      }
    });
  }

  /** Recomeça do zero: esquece as falas, a sessão do Claude Code e qualquer cartão pendente. */
  async limpar(id: string): Promise<void> {
    const conversa = await this.obter(id);
    if ((await this.outroNaConversa(id)) !== null) throw new Error(this.deps.texto("agentChat.errors.otherProcess"));
    conversa.geracao += 1;
    conversa.cancelar?.abort();
    for (const p of conversa.pendentes.values()) p.resolver?.("expirou");
    conversa.pendentes.clear();
    conversa.falas = [];
    conversa.historico = [];
    conversa.resumido = false;
    conversa.respondendo = false;
    conversa.gasto = { usd: 0, tokens: 0 };
    conversa.chamadas.clear();
    await this.provedor.armazem.gravar(id, "falas", "[]");
    await this.provedor.armazem.gravar(id, "sessao", "");
    await this.soltarSeQuieta(conversa);
  }

  /* -------------------------------------------------------------- interno */

  private obter(id: string): Promise<Conversa> {
    let pronta = this.conversas.get(id);
    if (pronta === undefined) {
      pronta = this.carregar(id);
      this.conversas.set(id, pronta);
    }
    return pronta;
  }

  private async carregar(id: string): Promise<Conversa> {
    const falas = await this.lerFalas(id, false);
    return { id, falas, historico: null, pendentes: new Map(), chamadas: new Map(), respondendo: false, resumido: false, gasto: { usd: 0, tokens: 0 }, seq: 0, geracao: 0 };
  }

  /**
   * As falas guardadas. Cartão velho de um processo que já não existe não tem
   * quem o decida: o que esperava o clique expira, e o que já tinha o clique e
   * não registrou o fim vira "incerto", porque a escrita pode ter saído. Com o
   * outro processo vivo e dono da conversa, os cartões ficam como ele os deixou.
   */
  private async lerFalas(id: string, donoVivo: boolean): Promise<FalaDoAgent[]> {
    try {
      const guardadas = JSON.parse((await this.provedor.armazem.ler(id, "falas")) ?? "[]") as Partial<FalaDoAgent>[];
      return guardadas.map((f) => ({
        de: f.de === "user" ? "user" : "assistant",
        texto: f.texto ?? "",
        ferramentas: f.ferramentas ?? [],
        cartoes: (f.cartoes ?? []).map((c) => {
          if (donoVivo) return c;
          if (c.estado === "pendente") return { ...c, estado: "expirado" as const };
          if (c.estado === "executando") return { ...c, estado: "incerto" as const };
          return c;
        }),
      }));
    } catch {
      return [];
    }
  }

  /** Quem é o outro processo com a conversa nas mãos, se houver um vivo. */
  private async outroNaConversa(id: string): Promise<number | null> {
    const processo = this.deps.processo ?? { pid: process.pid, vivo: pidVivo };
    try {
      const trava = JSON.parse((await this.provedor.armazem.ler(id, "trava")) || "null") as { pid?: number; em?: number } | null;
      if (trava === null || typeof trava.pid !== "number" || trava.pid === processo.pid) return null;
      if (this.agora() - (trava.em ?? 0) > this.travaMs || !processo.vivo(trava.pid)) return null;
      return trava.pid;
    } catch {
      return null;
    }
  }

  /** Esta conversa passa a ser deste processo; recusa se o outro está no meio de uma fala. */
  private async tomarTrava(conversa: Conversa): Promise<void> {
    if ((await this.outroNaConversa(conversa.id)) !== null) throw new Error(this.deps.texto("agentChat.errors.otherProcess"));
    const pid = this.deps.processo?.pid ?? process.pid;
    await this.provedor.armazem.gravar(conversa.id, "trava", JSON.stringify({ pid, em: this.agora() }));
    // Quem gravou por último vale: se o outro tomou no mesmo instante, este recua.
    if ((await this.outroNaConversa(conversa.id)) !== null) throw new Error(this.deps.texto("agentChat.errors.otherProcess"));
    if (conversa.batimento === undefined) {
      conversa.batimento = setInterval(() => void this.renovarTrava(conversa), Math.max(1, Math.floor(this.travaMs / 3)));
      conversa.batimento.unref();
    }
  }

  /**
   * Renova a trava que este processo tem. Falso quando ela já é de outro (ou
   * foi solta): aí a conversa deixou de ser daqui e o batimento para.
   */
  private async renovarTrava(conversa: Conversa): Promise<boolean> {
    const pid = this.deps.processo?.pid ?? process.pid;
    try {
      const trava = JSON.parse((await this.provedor.armazem.ler(conversa.id, "trava")) || "null") as { pid?: number } | null;
      if (trava?.pid === pid) {
        await this.provedor.armazem.gravar(conversa.id, "trava", JSON.stringify({ pid, em: this.agora() }));
        return true;
      }
    } catch {
      return false;
    }
    this.pararBatimento(conversa);
    return false;
  }

  private pararBatimento(conversa: Conversa): void {
    if (conversa.batimento !== undefined) clearInterval(conversa.batimento);
    conversa.batimento = undefined;
  }

  /** Expira o cartão de volta por API cujo prazo passou, e solta a conversa. */
  private async expirarVencidos(conversa: Conversa): Promise<void> {
    const agora = this.agora();
    if (![...conversa.pendentes.values()].some((p) => p.ate !== undefined && p.ate <= agora)) return;
    if (this.expirarPendentes(conversa)) {
      await this.salvar(conversa);
      await this.soltarSeQuieta(conversa);
    }
  }

  /** Sem volta em andamento nem cartão à espera, a conversa deixa de ser deste processo. */
  private async soltarSeQuieta(conversa: Conversa): Promise<void> {
    if (conversa.respondendo || conversa.pendentes.size > 0) return;
    const pid = this.deps.processo?.pid ?? process.pid;
    const trava = JSON.parse((await this.provedor.armazem.ler(conversa.id, "trava")) || "null") as { pid?: number } | null;
    if (trava?.pid === pid) await this.provedor.armazem.gravar(conversa.id, "trava", "");
    this.pararBatimento(conversa);
  }

  /**
   * Traz do disco o que o outro processo gravou. Só com a conversa quieta
   * neste: durante uma volta daqui, a memória é a que vale. O histórico do
   * modelo nasce de novo das falas quando elas mudaram.
   */
  private async reler(conversa: Conversa, donoVivo: boolean): Promise<void> {
    if (conversa.respondendo || conversa.pendentes.size > 0) return;
    const lidas = await this.lerFalas(conversa.id, donoVivo);
    if (JSON.stringify(lidas) === JSON.stringify(conversa.falas)) return;
    conversa.falas = lidas;
    conversa.historico = null;
    conversa.seq += 1;
  }

  private async salvar(conversa: Conversa): Promise<void> {
    await this.provedor.armazem.gravar(conversa.id, "falas", JSON.stringify(conversa.falas.slice(-FALAS_GUARDADAS)));
  }

  /** Aplica o evento na fala em andamento e o entrega à janela. */
  private emitir(conversa: Conversa, evento: EventoDoAgent): void {
    conversa.seq += 1;
    if (evento.tipo === "resumido") conversa.resumido = true;
    const ultima = conversa.falas.at(-1);
    if (ultima?.de === "assistant") conversa.falas[conversa.falas.length - 1] = aplicarEvento(ultima, evento);
    this.deps.emitir({ ...evento, chave: this.provedor.chave(conversa.id), seq: conversa.seq });
  }

  /** Marca como expirado o que esperava clique. Verdadeiro quando havia algo. */
  private expirarPendentes(conversa: Conversa): boolean {
    if (conversa.pendentes.size === 0) return false;
    for (const [id, p] of conversa.pendentes) {
      this.emitir(conversa, { tipo: "cartao-estado", id, estado: "expirado" });
      p.resolver?.("expirou");
    }
    conversa.pendentes.clear();
    // A chamada que pediu aprovação ficou sem resultado, e provedor nenhum aceita isso: sai do histórico.
    this.tirarPedidoSemResposta(conversa);
    return true;
  }

  private async historicoDe(conversa: Conversa): Promise<ModelMessage[]> {
    if (conversa.historico !== null) return conversa.historico;
    // Processo novo: o modelo não lembra, mas as falas guardadas dizem o que foi dito.
    const lembrado: ModelMessage[] = [];
    for (const fala of conversa.falas.slice(0, -2)) {
      if (fala.texto.trim() !== "") lembrado.push({ role: fala.de, content: fala.texto });
    }
    conversa.historico = lembrado;
    return lembrado;
  }

  private async rodar(
    conversa: Conversa,
    entrada: { texto: string } | { continuacao: ModelMessage },
  ): Promise<void> {
    const geracao = conversa.geracao;
    const controle = new AbortController();
    conversa.cancelar = controle;
    conversa.respondendo = true;
    let terminou = false;
    let houveErro = false;
    const emitir = (evento: EventoDoAgent): void => {
      if (evento.tipo === "fim") terminou = true;
      if (evento.tipo === "erro") houveErro = true;
      if (conversa.geracao === geracao) this.emitir(conversa, evento);
    };
    // Os cartões da volta por API só aparecem quando ela termina bem.
    const cartoesNovos: Cartao[] = [];
    let deuCerto = false;
    let motivo = this.deps.texto("agentChat.errors.noResult");
    try {
      const contexto = await this.provedor.contexto(conversa.id);
      const modelo = await this.deps.modelo(contexto.modelo);
      // Antes de cada volta, e não só da conversa: a continuação depois do clique também gasta.
      // O teto por execução vale sobre a conversa inteira desde que foi limpa pela última vez.
      await contexto.checar(conversa.gasto);

      const novaMensagem = "texto" in entrada;
      const gasto =
        modelo.via === "claude-code"
          ? await this.pelaAssinatura(conversa, contexto, modelo.modelo, "texto" in entrada ? entrada.texto : "", controle.signal, emitir)
          : await this.pelaApi(conversa, contexto, modelo, entrada, controle.signal, emitir, (c) => cartoesNovos.push(c));
      if (gasto !== null) {
        conversa.gasto = { usd: conversa.gasto.usd + gasto.usd, tokens: conversa.gasto.tokens + gasto.tokens };
        await contexto.gastar(gasto, novaMensagem);
      }
      deuCerto = !controle.signal.aborted && !houveErro;
    } catch (err) {
      motivo = this.mensagemDeErro(err);
      emitir({ tipo: "erro", mensagem: motivo });
    } finally {
      // Quem escuta espera um fim; erro do Claude Code ou falha antes do modelo não o trazem.
      if (!terminou) emitir({ tipo: "fim", motivo: "erro" });
      if (conversa.geracao === geracao) {
        conversa.respondendo = false;
        if (conversa.cancelar === controle) conversa.cancelar = undefined;
        // O Claude Code terminou (ou morreu) com cartão à espera: ninguém mais recebe o clique.
        this.expirarDoClaude(conversa);
        // Clicou em Executar e a volta acabou sem a ferramenta responder: não fica "executando" para sempre.
        this.fecharExecutando(conversa, motivo);
        if (!deuCerto && !("texto" in entrada)) this.desfazerContinuacao(conversa);
        if (deuCerto) {
          // A volta terminou bem: agora o cartão pode ser decidido.
          const prazo = this.deps.prazos?.cartaoMs ?? PRAZO_DO_CARTAO_MS;
          for (const cartao of cartoesNovos) {
            conversa.pendentes.set(cartao.id, { ate: this.agora() + prazo });
            this.emitir(conversa, { tipo: "cartao", cartao });
          }
          if (cartoesNovos.length > 0) setTimeout(() => void this.expirarVencidos(conversa), prazo + 50).unref();
        } else if (cartoesNovos.length > 0) {
          // Parar ou falhar antes do fim: o pedido de aprovação ficou sem quem o decida, e sem resposta no histórico.
          this.tirarPedidoSemResposta(conversa);
        }
        await this.salvar(conversa);
        await this.soltarSeQuieta(conversa);
      }
    }
  }

  /** Cartão que o clique mandou executar e que a volta deixou sem resposta da ferramenta. */
  private fecharExecutando(conversa: Conversa, motivo: string): void {
    for (const c of conversa.falas.at(-1)?.cartoes ?? []) {
      if (c.estado === "executando") this.emitir(conversa, { tipo: "cartao-estado", id: c.id, estado: "falhou", resultado: cortar(motivo) });
    }
  }

  /** Tira do histórico o pedido de aprovação sem resposta, para a conversa seguir sem limpar. */
  private tirarPedidoSemResposta(conversa: Conversa): void {
    const h = conversa.historico;
    const ultima = h?.at(-1);
    if (ultima?.role === "assistant" && Array.isArray(ultima.content) && ultima.content.some((p) => p.type === "tool-approval-request")) h!.pop();
  }

  /** A continuação falhou antes de a ferramenta rodar: sai também a resposta de aprovação que já tinha entrado. */
  private desfazerContinuacao(conversa: Conversa): void {
    const h = conversa.historico;
    while (h?.at(-1)?.role === "tool" && (h.at(-1)!.content as { type: string }[]).some((p) => p.type === "tool-approval-response")) h.pop();
    this.tirarPedidoSemResposta(conversa);
  }

  /** Expira só o que esperava o processo do Claude Code, que já não está lá. */
  private expirarDoClaude(conversa: Conversa): void {
    for (const [id, p] of conversa.pendentes) {
      if (p.resolver === undefined) continue;
      this.emitir(conversa, { tipo: "cartao-estado", id, estado: "expirado" });
      p.resolver("expirou");
      conversa.pendentes.delete(id);
    }
  }

  private mensagemDeErro(err: unknown): string {
    if (err instanceof BudgetExceeded) {
      const valor = (n: number): string => (err.unit === "usd" ? `${n.toFixed(2)} USD` : `${Math.round(n)} tokens`);
      return this.deps.texto("agentChat.errors.budget", {
        scope: this.deps.texto(`agentChat.scopes.${err.scope}`),
        limit: valor(err.limit),
        spent: valor(err.spent),
      });
    }
    return err instanceof Error ? err.message : String(err);
  }

  /** Por modelo de API: o laço de ferramentas é do AI SDK, e a escrita volta como pedido de aprovação. */
  private async pelaApi(
    conversa: Conversa,
    contexto: ContextoDaVolta,
    modelo: Extract<ModeloEscolhido, { via: "api" }>,
    entrada: { texto: string } | { continuacao: ModelMessage },
    sinal: AbortSignal,
    emitir: (e: EventoDoAgent) => void,
    guardarCartao: (c: Cartao) => void,
  ): Promise<Gasto | null> {
    const system = contexto.system("native");
    const historico = await this.historicoDe(conversa);
    if ("texto" in entrada) {
      historico.push({ role: "user", content: entrada.texto });
      // Guardado já enxuto, e não só enviado enxuto: o processo fica de pé o dia inteiro.
      const { mensagens, resumido } = compactarHistorico(historico, this.deps.teto ?? TETO_DO_HISTORICO);
      conversa.historico = mensagens;
      if (resumido) emitir({ tipo: "resumido" });
    } else {
      historico.push(entrada.continuacao);
    }
    const mensagens = conversa.historico!;

    const { leitura, confirmar } = contexto;
    // Sem conexão nenhuma (a conversa do run) não há registro a subir.
    const mcp = leitura.length + confirmar.length === 0 ? undefined : await this.deps.mcp();
    const lidas = await mcp?.toolsFor(leitura);
    let escritas: Awaited<ReturnType<NonNullable<typeof mcp>["toolsComAprovacao"]>> | undefined;
    try {
      escritas = await mcp?.toolsComAprovacao(confirmar);
      const tools: ToolSet = { ...lidas?.tools, ...escritas?.tools, ...ferramentasLocais(contexto.locais, sinal) };
      const dono = new Map<string, ToolRef>(
        [...leitura, ...confirmar].map((ref) => [`${ref.server}__${ref.tool}`, ref]),
      );

      const resultado = streamText({
        model: modelo.model,
        ...(system === "" ? {} : { system }),
        messages: mensagens,
        tools,
        stopWhen: stepCountIs(contexto.maxSteps),
        ...(contexto.temperature === undefined ? {} : { temperature: contexto.temperature }),
        abortSignal: sinal,
      });

      let pediuAprovacao = false;
      let cancelado = false;
      // Texto de antes e de depois de uma ferramenta vem em blocos separados; sem a quebra, colam.
      let teveTexto = conversa.falas.at(-1)?.texto.trim() !== "";
      // Depois do clique, o texto novo continua o anterior: também quebra.
      let quebrar = !("texto" in entrada);
      for await (const parte of resultado.fullStream) {
        if (parte.type === "text-delta") {
          if (quebrar && teveTexto) emitir({ tipo: "texto", delta: "\n\n" });
          quebrar = false;
          teveTexto = true;
          emitir({ tipo: "texto", delta: parte.text });
        }
        else if (parte.type === "tool-call") {
          quebrar = true;
          emitir({ tipo: "ferramenta", nome: parte.toolName, entrada: parte.input });
        }
        else if (parte.type === "tool-approval-request") {
          const ref = dono.get(parte.toolCall.toolName);
          const cartao: Cartao = {
            id: parte.approvalId,
            servidor: ref?.server ?? "",
            ferramenta: ref?.tool ?? parte.toolCall.toolName,
            argumentos: parte.toolCall.input,
            estado: "pendente",
          };
          conversa.chamadas.set(parte.toolCall.toolCallId, cartao.id);
          pediuAprovacao = true;
          guardarCartao(cartao);
        } else if (parte.type === "tool-result") {
          emitir({ tipo: "resultado", nome: parte.toolName });
          this.resultadoDoCartao(conversa, parte.toolCallId, "executado", legivel(parte.output), emitir);
        } else if (parte.type === "tool-error") {
          emitir({ tipo: "resultado", nome: parte.toolName });
          this.resultadoDoCartao(conversa, parte.toolCallId, "falhou", legivel(parte.error instanceof Error ? parte.error.message : parte.error), emitir);
        } else if (parte.type === "abort") cancelado = true;
        else if (parte.type === "error") emitir({ tipo: "erro", mensagem: String(parte.error) });
      }
      const gastoDaVolta = async (): Promise<Gasto> => {
        const uso = await resultado.totalUsage;
        const entrou = uso.inputTokens ?? 0;
        const saiu = uso.outputTokens ?? 0;
        const preco = await this.deps.preco(modelo.provedor, modelo.modelo);
        const gasto = { usd: preco === undefined ? 0 : costOf(preco, entrou, saiu), tokens: entrou + saiu };
        contarGastoDoProvedor(modelo.provedor, gasto);
        return gasto;
      };
      if (cancelado || sinal.aborted) {
        emitir({ tipo: "fim", motivo: "cancelado" });
        // O que já foi consumido conta, quando o provedor chegou a dizer.
        return gastoDaVolta().catch(() => null);
      }

      mensagens.push(...(await resultado.response).messages);
      emitir({ tipo: "fim", motivo: pediuAprovacao ? "aguardando" : await resultado.finishReason });
      return gastoDaVolta().catch(() => null);
    } finally {
      escritas?.release();
      lidas?.release();
    }
  }

  /** O que a ferramenta devolveu, no cartão que a pediu. */
  private resultadoDoCartao(
    conversa: Conversa,
    chamada: string,
    estado: "executado" | "falhou",
    resultado: string,
    emitir: (e: EventoDoAgent) => void,
  ): void {
    const id = conversa.chamadas.get(chamada);
    const cartao = conversa.falas.at(-1)?.cartoes.find((c) => c.id === id);
    if (cartao?.estado === "executando") emitir({ tipo: "cartao-estado", id: cartao.id, estado, resultado });
  }

  /** Pela assinatura do Claude Code: o CLI faz o laço, e aqui só o clique das escritas. */
  private async pelaAssinatura(
    conversa: Conversa,
    contexto: ContextoDaVolta,
    modelo: string,
    texto: string,
    sinal: AbortSignal,
    emitir: (e: EventoDoAgent) => void,
  ): Promise<Gasto | null> {
    const assinatura = this.deps.assinatura;
    if (assinatura === undefined) throw new Error(this.deps.texto("agentChat.errors.noClaude"));
    const nomes = new Map(contexto.confirmar.map((ref) => [`${prefixoDoServidor(ref.server)}${ref.tool}`, ref]));

    const aprovar = async (nome: string, entrada: unknown, usoId?: string): Promise<DecisaoDaAssinatura> => {
      const ref = nomes.get(nome);
      // Só a escrita que a pessoa ligou neste agent pede clique: o resto é negado sem incomodar.
      if (ref === undefined) return { permitir: false, mensagem: `A ferramenta ${nome} não faz parte deste agent.` };
      if (sinal.aborted) return { permitir: false, mensagem: "A conversa foi interrompida." };

      const cartao: Cartao = { id: randomUUID(), servidor: ref.server, ferramenta: ref.tool, argumentos: entrada, estado: "pendente" };
      if (usoId !== undefined) conversa.chamadas.set(usoId, cartao.id);
      const decisao = await new Promise<Decisao | "expirou">((resolver) => {
        conversa.pendentes.set(cartao.id, { resolver });
        emitir({ tipo: "cartao", cartao });
      });
      if (decisao === "executar") return { permitir: true, entrada };
      return {
        permitir: false,
        mensagem:
          decisao === "recusar"
            ? "A pessoa recusou esta chamada. Não insista sem ela pedir."
            : "A pessoa não chegou a decidir: a conversa foi interrompida.",
      };
    };

    // O que a ferramenta devolveu chega no fluxo, ligado à chamada pelo id: é aí que o cartão vira executado.
    const daVolta = (evento: EventoDoAgent): void => {
      if (evento.tipo === "resultado" && evento.id !== undefined) {
        const cartao = conversa.chamadas.get(evento.id);
        // Só o que a pessoa mandou executar muda: a recusa continua recusa, mesmo com o erro que o CLI devolve.
        if (cartao !== undefined && conversa.falas.at(-1)?.cartoes.find((c) => c.id === cartao)?.estado === "executando") {
          emitir({ tipo: "cartao-estado", id: cartao, estado: evento.erro === true ? "falhou" : "executado", resultado: cortar(evento.texto ?? "") });
        }
      }
      emitir(evento);
    };

    const sessao = (await this.provedor.armazem.ler(conversa.id, "sessao")) || undefined;
    const { sessao: nova, gasto } = await assinatura({
      texto,
      modelo,
      system: contexto.system("claude-code"),
      sessao,
      leitura: contexto.leitura,
      confirmar: contexto.confirmar,
      locais: contexto.locais,
      maxSteps: contexto.maxSteps,
      aprovar,
      emitir: daVolta,
      sinal,
    });
    if (nova) await this.provedor.armazem.gravar(conversa.id, "sessao", nova);
    // Volta cancelada também gastou o que o CLI chegou a contar.
    return gasto.usd > 0 || gasto.tokens > 0 ? gasto : sinal.aborted ? null : gasto;
  }
}
