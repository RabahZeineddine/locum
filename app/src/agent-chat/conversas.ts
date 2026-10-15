import { randomUUID } from "node:crypto";
import { stepCountIs, streamText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { SERVIDOR_CONTA, type ToolRef } from "../config/types.js";
import { BudgetExceeded, type assertWithinBudget, type recordSpend } from "../executor/budget.js";
import type { McpRegistry } from "../mcp/registry.js";
import { prefixoDoServidor } from "../runtimes/claude-account.js";
import { compactarHistorico, TETO_DO_HISTORICO } from "../services/chat-history.js";
import type { LibraryService, ResolvedProfile } from "../services/library-service.js";
import { costOf, type ModelPrice } from "../services/price-service.js";
import type { SettingsService } from "../services/settings-service.js";
import {
  aplicarEvento,
  chaveDoAgent,
  type Cartao,
  type EstadoDaConversa,
  type EventoDaConversa,
  type EventoDoAgent,
  type FalaDoAgent,
} from "./tipos.js";

/** Quantas falas ficam guardadas por conversa, como no assistente. */
const FALAS_GUARDADAS = 200;

/** O que o cartão mostra do resultado da ferramenta. */
const TETO_DO_RESULTADO = 600;

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
  perfil: ResolvedProfile;
  /** Chamado quando o Claude Code quer usar uma ferramenta que não estava liberada. Espera o clique. */
  aprovar: (nome: string, entrada: unknown) => Promise<DecisaoDaAssinatura>;
  emitir: (evento: EventoDoAgent) => void;
  sinal: AbortSignal;
}

export interface Gasto {
  usd: number;
  tokens: number;
}

export interface DepsDoChat {
  library: Pick<LibraryService, "resolveProfile">;
  mcp: () => Promise<Pick<McpRegistry, "toolsFor" | "toolsComAprovacao">>;
  modelo: (id: string) => Promise<ModeloEscolhido>;
  settings: Pick<SettingsService, "get" | "set">;
  orcamento: { checar: typeof assertWithinBudget; gastar: typeof recordSpend };
  preco: (provedor: string, modelo: string) => Promise<ModelPrice | undefined>;
  /** Sobe o Claude Code da assinatura. Ausente, o modelo `claude-code/...` não conversa. */
  assinatura?: (pedido: PedidoDaAssinatura) => Promise<{ sessao: string | undefined; gasto: Gasto }>;
  emitir: (evento: EventoDaConversa) => void;
  /** O texto de produto, no idioma da janela. */
  texto: (chave: string, variaveis?: Record<string, unknown>) => string;
  /** Teto do histórico mandado ao modelo. */
  teto?: number;
}

type Decisao = "executar" | "recusar";

interface Pendente {
  /** Só no caminho do Claude Code: o processo está parado esperando esta resposta. */
  resolver?: (decisao: Decisao | "expirou") => void;
  decisao?: Decisao;
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
  seq: number;
  /** Sobe quando a conversa é limpa: o que a volta antiga ainda emitir não vale mais. */
  geracao: number;
  cancelar?: AbortController;
}

const chaveDasFalas = (id: string): string => `chat.falas.${chaveDoAgent(id)}`;
const chaveDaSessao = (id: string): string => `chat.sessao.${chaveDoAgent(id)}`;

function cortar(texto: string): string {
  return texto.length > TETO_DO_RESULTADO ? `${texto.slice(0, TETO_DO_RESULTADO)}...` : texto;
}

function emTexto(valor: unknown): string {
  return typeof valor === "string" ? valor : JSON.stringify(valor) ?? "";
}

/**
 * As conversas com os agents da biblioteca.
 *
 * Cada agent conversa com o que `resolveProfile` entrega: system, modelo,
 * leitura liberada e skills. A leitura roda direto. A escrita que a pessoa
 * ligou na conexão (`confirmar`) para num cartão e só roda no clique, uma
 * chamada por vez: no caminho por API, pelo mecanismo de aprovação do AI SDK
 * (`needsApproval`, com a resposta devolvida na volta seguinte); no do Claude
 * Code, pela ferramenta de permissão do CLI, que fica esperando o clique.
 *
 * O cartão vive aqui, no processo principal, e não na janela: trocar de tela
 * não o perde. O que não sobrevive é o processo, e o cartão guardado volta
 * como expirado.
 */
export class ConversasDeAgent {
  private readonly conversas = new Map<string, Promise<Conversa>>();

  constructor(private readonly deps: DepsDoChat) {}

  async estado(id: string): Promise<EstadoDaConversa> {
    const conversa = await this.obter(id);
    const perfil = await this.deps.library.resolveProfile(id);
    return {
      falas: conversa.falas.map((f) => ({ ...f, cartoes: f.cartoes.map((c) => ({ ...c })) })),
      respondendo: conversa.respondendo,
      resumido: conversa.resumido,
      semServidor: perfil.semServidor,
      seq: conversa.seq,
    };
  }

  /** Uma mensagem da pessoa. Volta quando a volta termina, ou para num cartão (caminho por API). */
  async enviar(id: string, texto: string): Promise<void> {
    const conversa = await this.obter(id);
    if (conversa.respondendo) {
      this.emitir(conversa, { tipo: "erro", mensagem: this.deps.texto("agentChat.errors.busy") });
      return;
    }
    if (conversa.pendentes.size > 0) {
      this.emitir(conversa, { tipo: "erro", mensagem: this.deps.texto("agentChat.errors.pending") });
      return;
    }
    conversa.falas.push({ de: "user", texto, ferramentas: [], cartoes: [] }, { de: "assistant", texto: "", ferramentas: [], cartoes: [] });
    await this.rodar(conversa, { texto });
  }

  /** O clique do cartão. Para o modelo por API, a volta continua daqui. */
  async decidir(id: string, cartao: string, decisao: Decisao): Promise<void> {
    const conversa = await this.obter(id);
    const pendente = conversa.pendentes.get(cartao);
    if (pendente === undefined) throw new Error(this.deps.texto("agentChat.errors.expired"));

    this.emitir(conversa, { tipo: "cartao-estado", id: cartao, estado: decisao === "executar" ? "executado" : "recusado" });
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

  /** Interrompe a volta e expira o que ainda espera clique. */
  cancelar(id: string): void {
    const pronta = this.conversas.get(id);
    if (pronta === undefined) return;
    void pronta.then(async (conversa) => {
      conversa.cancelar?.abort();
      if (this.expirarPendentes(conversa)) await this.salvar(conversa);
    });
  }

  /** Recomeça do zero: esquece as falas, a sessão do Claude Code e qualquer cartão pendente. */
  async limpar(id: string): Promise<void> {
    const conversa = await this.obter(id);
    conversa.geracao += 1;
    conversa.cancelar?.abort();
    for (const p of conversa.pendentes.values()) p.resolver?.("expirou");
    conversa.pendentes.clear();
    conversa.falas = [];
    conversa.historico = [];
    conversa.resumido = false;
    conversa.respondendo = false;
    await this.deps.settings.set(chaveDasFalas(id), "[]");
    await this.deps.settings.set(chaveDaSessao(id), "");
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
    let falas: FalaDoAgent[] = [];
    try {
      const guardadas = JSON.parse((await this.deps.settings.get(chaveDasFalas(id))) ?? "[]") as Partial<FalaDoAgent>[];
      falas = guardadas.map((f) => ({
        de: f.de === "user" ? "user" : "assistant",
        texto: f.texto ?? "",
        ferramentas: f.ferramentas ?? [],
        // Memória nova, cartão velho: quem decidiria já não está esperando.
        cartoes: (f.cartoes ?? []).map((c) => (c.estado === "pendente" ? { ...c, estado: "expirado" as const } : c)),
      }));
    } catch {
      falas = [];
    }
    return { id, falas, historico: null, pendentes: new Map(), chamadas: new Map(), respondendo: false, resumido: false, seq: 0, geracao: 0 };
  }

  private async salvar(conversa: Conversa): Promise<void> {
    await this.deps.settings.set(chaveDasFalas(conversa.id), JSON.stringify(conversa.falas.slice(-FALAS_GUARDADAS)));
  }

  /** Aplica o evento na fala em andamento e o entrega à janela. */
  private emitir(conversa: Conversa, evento: EventoDoAgent): void {
    conversa.seq += 1;
    if (evento.tipo === "resumido") conversa.resumido = true;
    const ultima = conversa.falas.at(-1);
    if (ultima?.de === "assistant") conversa.falas[conversa.falas.length - 1] = aplicarEvento(ultima, evento);
    this.deps.emitir({ ...evento, chave: chaveDoAgent(conversa.id), seq: conversa.seq });
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
    const ultima = conversa.historico?.at(-1);
    if (ultima?.role === "assistant" && Array.isArray(ultima.content) && ultima.content.some((p) => p.type === "tool-approval-request")) {
      conversa.historico!.pop();
    }
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
    const emitir = (evento: EventoDoAgent): void => {
      if (evento.tipo === "fim") terminou = true;
      if (conversa.geracao === geracao) this.emitir(conversa, evento);
    };
    try {
      const perfil = await this.deps.library.resolveProfile(conversa.id);
      const spec = perfil.version.spec;
      const modelo = await this.deps.modelo(spec.model);
      // Antes de cada volta, e não só da conversa: a continuação depois do clique também gasta.
      await this.deps.orcamento.checar(`biblioteca:${spec.id}`, { usd: 0, tokens: 0 }, spec.budget, spec.name);

      const novaMensagem = "texto" in entrada;
      const gasto =
        modelo.via === "claude-code"
          ? await this.pelaAssinatura(conversa, perfil, modelo.modelo, "texto" in entrada ? entrada.texto : "", controle.signal, emitir)
          : await this.pelaApi(conversa, perfil, modelo, entrada, controle.signal, emitir);
      if (gasto !== null) await this.deps.orcamento.gastar(`biblioteca:${spec.id}`, gasto, novaMensagem);
    } catch (err) {
      emitir({ tipo: "erro", mensagem: this.mensagemDeErro(err) });
    } finally {
      // Quem escuta espera um fim; erro do Claude Code ou falha antes do modelo não o trazem.
      if (!terminou) emitir({ tipo: "fim", motivo: "erro" });
      if (conversa.geracao === geracao) {
        conversa.respondendo = false;
        if (conversa.cancelar === controle) conversa.cancelar = undefined;
        await this.salvar(conversa);
      }
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
    perfil: ResolvedProfile,
    modelo: Extract<ModeloEscolhido, { via: "api" }>,
    entrada: { texto: string } | { continuacao: ModelMessage },
    sinal: AbortSignal,
    emitir: (e: EventoDoAgent) => void,
  ): Promise<Gasto | null> {
    const spec = perfil.version.spec;
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

    const mcp = await this.deps.mcp();
    // As da conta Claude só existem no runtime do Claude Code.
    const leitura = perfil.tools.filter((t) => t.server !== SERVIDOR_CONTA);
    const lidas = await mcp.toolsFor(leitura);
    let escritas: Awaited<ReturnType<typeof mcp.toolsComAprovacao>> | undefined;
    try {
      escritas = await mcp.toolsComAprovacao(perfil.confirmar);
      const tools: ToolSet = { ...lidas.tools, ...escritas.tools };
      const dono = new Map<string, ToolRef>(
        [...leitura, ...perfil.confirmar].map((ref) => [`${ref.server}__${ref.tool}`, ref]),
      );

      const resultado = streamText({
        model: modelo.model,
        ...(perfil.system === "" ? {} : { system: perfil.system }),
        messages: mensagens,
        tools,
        stopWhen: stepCountIs(spec.maxSteps),
        ...(spec.temperature === undefined ? {} : { temperature: spec.temperature }),
        abortSignal: sinal,
      });

      let pediuAprovacao = false;
      let cancelado = false;
      for await (const parte of resultado.fullStream) {
        if (parte.type === "text-delta") emitir({ tipo: "texto", delta: parte.text });
        else if (parte.type === "tool-call") emitir({ tipo: "ferramenta", nome: parte.toolName, entrada: parte.input });
        else if (parte.type === "tool-approval-request") {
          const ref = dono.get(parte.toolCall.toolName);
          const cartao: Cartao = {
            id: parte.approvalId,
            servidor: ref?.server ?? "",
            ferramenta: ref?.tool ?? parte.toolCall.toolName,
            argumentos: parte.toolCall.input,
            estado: "pendente",
          };
          conversa.pendentes.set(cartao.id, {});
          conversa.chamadas.set(parte.toolCall.toolCallId, cartao.id);
          pediuAprovacao = true;
          emitir({ tipo: "cartao", cartao });
        } else if (parte.type === "tool-result") {
          emitir({ tipo: "resultado", nome: parte.toolName });
          this.resultadoDoCartao(conversa, parte.toolCallId, cortar(emTexto(parte.output)), emitir);
        } else if (parte.type === "tool-error") {
          emitir({ tipo: "resultado", nome: parte.toolName });
          this.resultadoDoCartao(conversa, parte.toolCallId, cortar(emTexto(parte.error instanceof Error ? parte.error.message : parte.error)), emitir);
        } else if (parte.type === "abort") cancelado = true;
        else if (parte.type === "error") emitir({ tipo: "erro", mensagem: String(parte.error) });
      }
      if (cancelado || sinal.aborted) {
        emitir({ tipo: "fim", motivo: "cancelado" });
        return null;
      }

      mensagens.push(...(await resultado.response).messages);
      emitir({ tipo: "fim", motivo: pediuAprovacao ? "aguardando" : await resultado.finishReason });

      const uso = await resultado.totalUsage;
      const entrou = uso.inputTokens ?? 0;
      const saiu = uso.outputTokens ?? 0;
      const preco = await this.deps.preco(modelo.provedor, modelo.modelo);
      return { usd: preco === undefined ? 0 : costOf(preco, entrou, saiu), tokens: entrou + saiu };
    } finally {
      escritas?.release();
      lidas.release();
    }
  }

  /** O que a ferramenta devolveu, no cartão que a pediu. */
  private resultadoDoCartao(conversa: Conversa, chamada: string, resultado: string, emitir: (e: EventoDoAgent) => void): void {
    const id = conversa.chamadas.get(chamada);
    const cartao = conversa.falas.at(-1)?.cartoes.find((c) => c.id === id);
    if (cartao !== undefined) emitir({ tipo: "cartao-estado", id: cartao.id, estado: cartao.estado, resultado });
  }

  /** Pela assinatura do Claude Code: o CLI faz o laço, e aqui só o clique das escritas. */
  private async pelaAssinatura(
    conversa: Conversa,
    perfil: ResolvedProfile,
    modelo: string,
    texto: string,
    sinal: AbortSignal,
    emitir: (e: EventoDoAgent) => void,
  ): Promise<Gasto | null> {
    const assinatura = this.deps.assinatura;
    if (assinatura === undefined) throw new Error(this.deps.texto("agentChat.errors.noClaude"));
    const nomes = new Map(perfil.confirmar.map((ref) => [`${prefixoDoServidor(ref.server)}${ref.tool}`, ref]));

    const aprovar = async (nome: string, entrada: unknown): Promise<DecisaoDaAssinatura> => {
      const ref = nomes.get(nome);
      // Só a escrita que a pessoa ligou neste agent pede clique: o resto é negado sem incomodar.
      if (ref === undefined) return { permitir: false, mensagem: `A ferramenta ${nome} não faz parte deste agent.` };
      if (sinal.aborted) return { permitir: false, mensagem: "A conversa foi interrompida." };

      const cartao: Cartao = { id: randomUUID(), servidor: ref.server, ferramenta: ref.tool, argumentos: entrada, estado: "pendente" };
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

    const sessao = (await this.deps.settings.get(chaveDaSessao(conversa.id))) || undefined;
    const { sessao: nova, gasto } = await assinatura({ texto, modelo, system: perfil.system, sessao, perfil, aprovar, emitir, sinal });
    if (nova) await this.deps.settings.set(chaveDaSessao(conversa.id), nova);
    return sinal.aborted ? null : gasto;
  }
}
