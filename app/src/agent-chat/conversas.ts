import { randomUUID } from "node:crypto";
import { stepCountIs, streamText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { SERVIDOR_CONTA, type ToolRef } from "../config/types.js";
import { selectSkills, skillsPreamble, type LoadedSkill } from "../skills/loader.js";
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
  perfil: ResolvedProfile;
  /** Chamado quando o Claude Code quer usar uma ferramenta que não estava liberada. Espera o clique. */
  aprovar: (nome: string, entrada: unknown, usoId?: string) => Promise<DecisaoDaAssinatura>;
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
  /** Skills disponíveis. Ausente varre o disco. */
  skills?: Map<string, LoadedSkill>;
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
  /** O que a conversa já gastou, para o teto por execução valer sobre ela inteira. */
  gasto: Gasto;
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
      contaIgnorada: perfil.tools.filter((t) => t.server === SERVIDOR_CONTA).length,
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
    // No caminho por API o cartão só vale com a volta terminada: antes, o passo ainda corre.
    if (pendente.resolver === undefined && conversa.respondendo) throw new Error(this.deps.texto("agentChat.errors.busy"));

    // "Executado" só depois que a ferramenta responde; até lá, executando.
    this.emitir(conversa, { tipo: "cartao-estado", id: cartao, estado: decisao === "executar" ? "executando" : "recusado" });
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
    conversa.gasto = { usd: 0, tokens: 0 };
    conversa.chamadas.clear();
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
        cartoes: (f.cartoes ?? []).map((c) => (c.estado === "pendente" || c.estado === "executando" ? { ...c, estado: "expirado" as const } : c)),
      }));
    } catch {
      falas = [];
    }
    return { id, falas, historico: null, pendentes: new Map(), chamadas: new Map(), respondendo: false, resumido: false, gasto: { usd: 0, tokens: 0 }, seq: 0, geracao: 0 };
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
      const perfil = await this.deps.library.resolveProfile(conversa.id);
      const spec = perfil.version.spec;
      const modelo = await this.deps.modelo(spec.model);
      // Antes de cada volta, e não só da conversa: a continuação depois do clique também gasta.
      // O teto por execução vale sobre a conversa inteira desde que foi limpa pela última vez.
      await this.deps.orcamento.checar(`biblioteca:${spec.id}`, conversa.gasto, spec.budget, spec.name);

      const novaMensagem = "texto" in entrada;
      const gasto =
        modelo.via === "claude-code"
          ? await this.pelaAssinatura(conversa, perfil, modelo.modelo, "texto" in entrada ? entrada.texto : "", controle.signal, emitir)
          : await this.pelaApi(conversa, perfil, modelo, entrada, controle.signal, emitir, (c) => cartoesNovos.push(c));
      if (gasto !== null) {
        conversa.gasto = { usd: conversa.gasto.usd + gasto.usd, tokens: conversa.gasto.tokens + gasto.tokens };
        await this.deps.orcamento.gastar(`biblioteca:${spec.id}`, gasto, novaMensagem);
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
          for (const cartao of cartoesNovos) {
            conversa.pendentes.set(cartao.id, {});
            this.emitir(conversa, { tipo: "cartao", cartao });
          }
        } else if (cartoesNovos.length > 0) {
          // Parar ou falhar antes do fim: o pedido de aprovação ficou sem quem o decida, e sem resposta no histórico.
          this.tirarPedidoSemResposta(conversa);
        }
        await this.salvar(conversa);
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

  private systemDe(perfil: ResolvedProfile): string {
    // Sem evento por trás, só valem as skills de regra "sempre", como na consulta entre agents.
    const skills = selectSkills(perfil.version.spec.skills, { repo: "", changedFiles: [] }, this.deps.skills);
    return [perfil.system, skillsPreamble(skills, true)].filter((p) => p.length > 0).join("\n\n");
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
    guardarCartao: (c: Cartao) => void,
  ): Promise<Gasto | null> {
    const spec = perfil.version.spec;
    const system = this.systemDe(perfil);
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
        ...(system === "" ? {} : { system }),
        messages: mensagens,
        tools,
        stopWhen: stepCountIs(spec.maxSteps),
        ...(spec.temperature === undefined ? {} : { temperature: spec.temperature }),
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
        return { usd: preco === undefined ? 0 : costOf(preco, entrou, saiu), tokens: entrou + saiu };
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
      lidas.release();
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
    perfil: ResolvedProfile,
    modelo: string,
    texto: string,
    sinal: AbortSignal,
    emitir: (e: EventoDoAgent) => void,
  ): Promise<Gasto | null> {
    const assinatura = this.deps.assinatura;
    if (assinatura === undefined) throw new Error(this.deps.texto("agentChat.errors.noClaude"));
    const nomes = new Map(perfil.confirmar.map((ref) => [`${prefixoDoServidor(ref.server)}${ref.tool}`, ref]));

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

    const sessao = (await this.deps.settings.get(chaveDaSessao(conversa.id))) || undefined;
    const { sessao: nova, gasto } = await assinatura({
      texto,
      modelo,
      system: this.systemDe(perfil),
      sessao,
      perfil,
      aprovar,
      emitir: daVolta,
      sinal,
    });
    if (nova) await this.deps.settings.set(chaveDaSessao(conversa.id), nova);
    // Volta cancelada também gastou o que o CLI chegou a contar.
    return gasto.usd > 0 || gasto.tokens > 0 ? gasto : sinal.aborted ? null : gasto;
  }
}
