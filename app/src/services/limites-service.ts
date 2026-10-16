import { and, eq, like, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { clienteHttp } from "../net/http.js";
import { today } from "../executor/budget.js";
import { aoGastar, aoLerLimites, type Limite, type LimiteLido } from "../runtimes/limites-lidos.js";
import { settingsService, type SettingsService } from "./settings-service.js";

type Db = typeof defaultDb;

export type { Limite } from "../runtimes/limites-lidos.js";

const CHAVE_RETRATO = "limites.retrato";
const CHAVE_CONFIG = "limites.config";

/** Janela de assinatura: pausa a automação a partir de 95%. */
export const LIMIAR_PADRAO_JANELA = 0.95;
/** Orçamento local: pausa ao chegar no teto. */
export const LIMIAR_PADRAO_ORCAMENTO = 1;
/** O gateway não é consultado de novo antes disto, pedido ou não. */
export const INTERVALO_DO_GATEWAY_MS = 10 * 60_000;

export interface OrcamentoDoProvedor {
  diaUsd?: number;
  mesUsd?: number;
}

export interface ConfigDeLimites {
  /** Pausar automações perto do limite. Ligado quando nunca foi decidido. */
  protecao: boolean;
  limiarJanela: number;
  limiarOrcamento: number;
  orcamentos: Record<string, OrcamentoDoProvedor>;
  /** Ajuste fino por provedor; ausente vale o global. */
  limiares: Record<string, { janela?: number; orcamento?: number }>;
  /**
   * Quando o provedor está no limite, usar o substituto de `model_fallbacks`.
   * Desligado de fábrica: trocar de provedor muda custo e comportamento, e só
   * vale para provedor de API com orçamento local, que é o que segura o gasto.
   */
  usarSubstituto: boolean;
  /** Provedores cadastrados que o dono diz serem LiteLLM: só esses recebem a pergunta ao `key/info`. */
  gateways: string[];
}

export const CONFIG_PADRAO: ConfigDeLimites = {
  protecao: true,
  limiarJanela: LIMIAR_PADRAO_JANELA,
  limiarOrcamento: LIMIAR_PADRAO_ORCAMENTO,
  orcamentos: {},
  limiares: {},
  usarSubstituto: false,
  gateways: [],
};

type Retrato = Record<string, { quando: number; limites: LimiteLido[] }>;

export type EstadoDoLimite = "ok" | "aviso" | "erro";

/** Quem está no limite agora, e até quando. */
export interface Bloqueio {
  provedor: string;
  limite: Limite;
  /** Epoch em ms em que o limite solta. */
  ate: number;
  /** Por que um substituto livre não foi usado, quando havia. */
  nota?: string;
}

/** O começo do motivo de uma troca por limite: a Fila e a execução o reconhecem por aqui. */
export const PREFIXO_DA_TROCA_POR_LIMITE = "feito com ";

export type Decisao =
  | { tipo: "livre"; modelo: string }
  | { tipo: "substitui"; modelo: string; de: string; motivo: string }
  | { tipo: "pausa"; bloqueio: Bloqueio };

/** O gateway dá o endereço e a chave de um provedor cadastrado. Ausente, não há o que consultar. */
export type FonteDoGateway = (provedor: string) => { url: string; headers: Record<string, string> } | null;

export interface DependenciasDosLimites {
  db?: Db;
  settings?: SettingsService;
  fetch?: typeof fetch;
  gateway?: FonteDoGateway;
  agora?: () => number;
}

function dois(n: number): string {
  return String(n).padStart(2, "0");
}

function numeroOuNada(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Quanto do teto já foi, para a cor do ponto: ok abaixo de 75%, aviso até o limiar, erro dali em diante. */
export function estadoDoUso(uso: number, limiar: number): EstadoDoLimite {
  if (uso >= limiar) return "erro";
  return uso >= 0.75 ? "aviso" : "ok";
}

/**
 * Os limites de cada provedor num modelo só.
 *
 * Cada fonte (assinatura do Claude Code e do Codex, cabeçalho de taxa da API,
 * gateway, orçamento local) traduz o que sabe para `Limite`, e quem decide
 * pausar uma automação lê daqui sem conhecer a fonte. Guarda o último retrato
 * de cada provedor em settings; o orçamento local não é guardado, é calculado
 * do gasto registrado a cada leitura. Nada de credencial passa por aqui.
 */
export class LimitesService {
  private readonly db: Db;
  private readonly settings: SettingsService;
  private readonly buscar: typeof fetch;
  private gateway: FonteDoGateway;
  private readonly agora: () => number;
  private readonly ultimaConsultaDoGateway = new Map<string, number>();
  /** Escritas em fila: duas leituras ao mesmo tempo não pisam uma na outra. */
  private fila: Promise<unknown> = Promise.resolve();

  constructor(deps: DependenciasDosLimites = {}) {
    this.db = deps.db ?? defaultDb;
    this.settings = deps.settings ?? settingsService;
    this.buscar = deps.fetch ?? clienteHttp;
    this.gateway = deps.gateway ?? (() => null);
    this.agora = deps.agora ?? Date.now;
  }

  /** Diz de onde vem o endereço e a chave do gateway de cada provedor cadastrado. */
  usarGateway(fonte: FonteDoGateway): void {
    this.gateway = fonte;
  }

  /** Liga as fontes passivas: leitura e gasto que os runtimes publicam em toda chamada. */
  ligar(): () => void {
    const parar = [
      aoLerLimites((provedor, limites, quando) => void this.registrar(provedor, limites, quando).catch(() => undefined)),
      aoGastar((provedor, gasto) => void this.gastar(provedor, gasto).catch(() => undefined)),
    ];
    return () => parar.forEach((p) => p());
  }

  private serial<T>(trabalho: () => Promise<T>): Promise<T> {
    const proximo = this.fila.then(trabalho, trabalho);
    this.fila = proximo.catch(() => undefined);
    return proximo;
  }

  async config(): Promise<ConfigDeLimites> {
    const bruto = await this.settings.get(CHAVE_CONFIG);
    if (bruto === undefined) return CONFIG_PADRAO;
    try {
      const c = JSON.parse(bruto) as Partial<ConfigDeLimites>;
      const limiar = (v: unknown, padrao: number): number => (typeof v === "number" && v > 0 && v <= 1.5 ? v : padrao);
      return {
        protecao: c.protecao !== false,
        limiarJanela: limiar(c.limiarJanela, LIMIAR_PADRAO_JANELA),
        limiarOrcamento: limiar(c.limiarOrcamento, LIMIAR_PADRAO_ORCAMENTO),
        orcamentos: typeof c.orcamentos === "object" && c.orcamentos !== null ? c.orcamentos : {},
        limiares: typeof c.limiares === "object" && c.limiares !== null ? c.limiares : {},
        usarSubstituto: c.usarSubstituto === true,
        gateways: Array.isArray(c.gateways) ? c.gateways.filter((g): g is string => typeof g === "string") : [],
      };
    } catch {
      return CONFIG_PADRAO;
    }
  }

  async gravarConfig(parcial: Partial<ConfigDeLimites>): Promise<ConfigDeLimites> {
    // Limiar vazio ou zero pausaria tudo o tempo todo: recusa em vez de gravar.
    const valido = (v: number | undefined, teto: number, nome: string): void => {
      if (v !== undefined && !(Number.isFinite(v) && v > 0 && v <= teto)) throw new Error(`${nome} precisa estar entre 1% e ${Math.round(teto * 100)}%`);
    };
    valido(parcial.limiarJanela, 1, "limiar da janela");
    valido(parcial.limiarOrcamento, 1.5, "limiar do orçamento");
    for (const [provedor, l] of Object.entries(parcial.limiares ?? {})) {
      valido(l.janela, 1, `limiar da janela de ${provedor}`);
      valido(l.orcamento, 1.5, `limiar do orçamento de ${provedor}`);
    }
    const atual = await this.config();
    const nova = { ...atual, ...parcial };
    if (parcial.limiares !== undefined) {
      // Por provedor: gravar um não apaga os outros, e vazio tira o ajuste.
      nova.limiares = { ...atual.limiares, ...parcial.limiares };
      for (const [p, l] of Object.entries(nova.limiares)) if (l.janela === undefined && l.orcamento === undefined) delete nova.limiares[p];
    }
    await this.settings.set(CHAVE_CONFIG, JSON.stringify(nova));
    return nova;
  }

  /** O teto em dólar por dia e por mês de um provedor de API. Zero ou vazio tira o teto. */
  async definirOrcamento(provedor: string, orc: OrcamentoDoProvedor): Promise<void> {
    const atual = await this.config();
    const limpo: OrcamentoDoProvedor = {};
    const dia = numeroOuNada(orc.diaUsd);
    const mes = numeroOuNada(orc.mesUsd);
    if (dia !== undefined) limpo.diaUsd = dia;
    if (mes !== undefined) limpo.mesUsd = mes;
    const orcamentos = { ...atual.orcamentos };
    if (Object.keys(limpo).length === 0) delete orcamentos[provedor];
    else orcamentos[provedor] = limpo;
    await this.gravarConfig({ orcamentos });
  }

  /** Tira tudo que se guardou de um provedor: sem a chave, o orçamento e a leitura dele não valem mais. */
  async esquecer(provedor: string): Promise<void> {
    const c = await this.config();
    const orcamentos = { ...c.orcamentos };
    const limiares = { ...c.limiares };
    delete orcamentos[provedor];
    delete limiares[provedor];
    await this.settings.set(CHAVE_CONFIG, JSON.stringify({ ...c, orcamentos, limiares, gateways: c.gateways.filter((g) => g !== provedor) }));
    await this.serial(async () => this.alterarRetrato((retrato) => void delete retrato[provedor]));
    this.ultimaConsultaDoGateway.delete(provedor);
  }

  private async lerRetrato(): Promise<Retrato> {
    const bruto = await this.settings.get(CHAVE_RETRATO);
    if (bruto === undefined) return {};
    try {
      const r = JSON.parse(bruto) as Retrato;
      return typeof r === "object" && r !== null ? r : {};
    } catch {
      return {};
    }
  }

  /**
   * Guarda o que uma fonte leu. Por chave e origem, a leitura mais nova
   * substitui a anterior; as outras chaves do provedor ficam como estavam.
   */
  registrar(provedor: string, lidos: LimiteLido[], quando: number = this.agora()): Promise<void> {
    if (lidos.length === 0) return Promise.resolve();
    return this.serial(async () =>
      this.alterarRetrato((retrato) => {
        const atual = retrato[provedor]?.limites ?? [];
        const mantidos = atual.filter((a) => !lidos.some((l) => l.chave === a.chave && l.origem === a.origem));
        retrato[provedor] = { quando, limites: [...mantidos, ...lidos] };
      }),
    );
  }

  /**
   * Lê, muda e grava o retrato numa transação só, e imediata: o app e o
   * `--mcp` rodam em processos separados sobre o mesmo banco, e duas leituras
   * ao mesmo tempo não podem apagar uma à outra.
   */
  private alterarRetrato(mudar: (retrato: Retrato) => void): void {
    this.db.transaction(
      (tx) => {
        const [linha] = tx.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, CHAVE_RETRATO)).all();
        let retrato: Retrato = {};
        try {
          const lido = JSON.parse(linha?.value ?? "{}") as Retrato;
          if (typeof lido === "object" && lido !== null) retrato = lido;
        } catch {}
        mudar(retrato);
        const value = JSON.stringify(retrato);
        tx.insert(schema.settings)
          .values({ key: CHAVE_RETRATO, value })
          .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: sql`(unixepoch())` } })
          .run();
      },
      { behavior: "immediate" },
    );
  }

  /** Soma o gasto cobrado de uma chamada de API ao dia do provedor. */
  async gastar(provedor: string, gasto: { usd: number; tokens: number }, dia: string = today(new Date(this.agora()))): Promise<void> {
    await this.db
      .insert(schema.usageProviderDaily)
      .values({ day: dia, provider: provedor, costUsd: gasto.usd, tokens: gasto.tokens, requests: 1 })
      .onConflictDoUpdate({
        target: [schema.usageProviderDaily.day, schema.usageProviderDaily.provider],
        set: {
          costUsd: sql`${schema.usageProviderDaily.costUsd} + ${gasto.usd}`,
          tokens: sql`${schema.usageProviderDaily.tokens} + ${gasto.tokens}`,
          requests: sql`${schema.usageProviderDaily.requests} + 1`,
        },
      });
  }

  /** O orçamento local de um provedor, calculado do gasto: dia e mês, cada um só se tiver teto. */
  private async orcamentoLocal(provedor: string, orc: OrcamentoDoProvedor | undefined, agoraMs: number): Promise<Limite[]> {
    if (orc === undefined) return [];
    const agora = new Date(agoraMs);
    const quando = Math.floor(agoraMs / 1000);
    const saida: Limite[] = [];
    if (orc.diaUsd !== undefined) {
      const [linha] = await this.db
        .select({ usd: schema.usageProviderDaily.costUsd })
        .from(schema.usageProviderDaily)
        .where(and(eq(schema.usageProviderDaily.day, today(agora)), eq(schema.usageProviderDaily.provider, provedor)));
      const usado = linha?.usd ?? 0;
      const virada = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + 1).getTime();
      saida.push({ provedor, chave: "dia", tipo: "orcamento", uso: usado / orc.diaUsd, usado, teto: orc.diaUsd, unidade: "usd", resetaEm: Math.floor(virada / 1000), origem: "orcamento-local", quando });
    }
    if (orc.mesUsd !== undefined) {
      const prefixo = `${agora.getFullYear()}-${dois(agora.getMonth() + 1)}-%`;
      const [linha] = await this.db
        .select({ usd: sql<number>`coalesce(sum(${schema.usageProviderDaily.costUsd}), 0)` })
        .from(schema.usageProviderDaily)
        .where(and(like(schema.usageProviderDaily.day, prefixo), eq(schema.usageProviderDaily.provider, provedor)));
      const usado = Number(linha?.usd ?? 0);
      const virada = new Date(agora.getFullYear(), agora.getMonth() + 1, 1).getTime();
      saida.push({ provedor, chave: "mes", tipo: "orcamento", uso: usado / orc.mesUsd, usado, teto: orc.mesUsd, unidade: "usd", resetaEm: Math.floor(virada / 1000), origem: "orcamento-local", quando });
    }
    return saida;
  }

  /**
   * Todos os limites conhecidos, com o orçamento local recalculado agora.
   * Leitura cujo reset já passou vale zero: a janela virou e ainda não houve
   * leitura nova.
   */
  async listar(agoraMs: number = this.agora()): Promise<Limite[]> {
    const [retrato, config] = await Promise.all([this.lerRetrato(), this.config()]);
    const saida: Limite[] = [];
    for (const [provedor, entrada] of Object.entries(retrato)) {
      for (const l of entrada.limites) {
        const vencido = l.resetaEm !== undefined && l.resetaEm * 1000 <= agoraMs;
        const { resetaEm: _, usado: __, ...resto } = l;
        saida.push(
          vencido
            ? { provedor, ...resto, uso: 0, quando: Math.floor(entrada.quando / 1000) }
            : { provedor, ...l, quando: Math.floor(entrada.quando / 1000) },
        );
      }
    }
    const comOrcamento = new Set([...Object.keys(config.orcamentos)]);
    for (const provedor of comOrcamento) saida.push(...(await this.orcamentoLocal(provedor, config.orcamentos[provedor], agoraMs)));
    return saida;
  }

  /** Os limites de um provedor só. */
  async doProvedor(provedor: string, agoraMs?: number): Promise<Limite[]> {
    return (await this.listar(agoraMs)).filter((l) => l.provedor === provedor);
  }

  private limiarDe(l: Limite, config: ConfigDeLimites): number {
    const fino = config.limiares[l.provedor];
    return l.tipo === "orcamento" ? (fino?.orcamento ?? config.limiarOrcamento) : (fino?.janela ?? config.limiarJanela);
  }

  /** O estado de um limite contra o limiar do provedor. */
  async estado(l: Limite): Promise<EstadoDoLimite> {
    return estadoDoUso(l.uso, this.limiarDe(l, await this.config()));
  }

  /**
   * Se o provedor está no limite agora, e até quando. Só janela e orçamento
   * seguram automação: a taxa por minuto some sozinha antes de valer a pausa.
   * Janela sem reset conhecido não segura, porque a pausa nunca soltaria.
   */
  async bloqueio(provedor: string, agoraMs: number = this.agora()): Promise<Bloqueio | null> {
    const config = await this.config();
    if (!config.protecao) return null;
    let pior: Bloqueio | null = null;
    for (const l of await this.doProvedor(provedor, agoraMs)) {
      if (l.tipo === "taxa" || l.resetaEm === undefined) continue;
      if (l.uso < this.limiarDe(l, config)) continue;
      const ate = l.resetaEm * 1000;
      if (ate <= agoraMs) continue;
      if (pior === null || ate > pior.ate) pior = { provedor, limite: l, ate };
    }
    return pior;
  }

  /**
   * O que fazer com um modelo pedido por execução automática: rodar, trocar
   * pelo substituto configurado em `model_fallbacks` ou pausar. O substituto é
   * o primeiro da cadeia cujo provedor existe e não está no limite.
   */
  async decidir(
    modelo: string,
    deps: { fallbacks: { fromModel: string; toModel: string; order: number }[]; disponivel: (provedor: string) => boolean },
    agoraMs: number = this.agora(),
  ): Promise<Decisao> {
    const provedorDe = (id: string): string => id.slice(0, Math.max(id.indexOf("/"), 0));
    const config = await this.config();
    const visitados = new Set<string>();
    let primeiro: Bloqueio | null = null;
    let nota: string | undefined;
    const fila = [modelo];
    while (fila.length > 0) {
      const atual = fila.shift()!;
      if (visitados.has(atual)) continue;
      visitados.add(atual);
      const provedor = provedorDe(atual);
      if (deps.disponivel(provedor)) {
        const b = await this.bloqueio(provedor, agoraMs);
        if (b === null) {
          if (atual === modelo) return { tipo: "livre", modelo };
          // Substituto livre: só vale com a opção ligada e com orçamento local no provedor dele.
          const orc = config.orcamentos[provedor];
          if (!config.usarSubstituto) nota ??= `substituto ${atual} não usado: a opção de usar o substituto está desligada`;
          else if (orc === undefined) nota ??= `substituto ${atual} não usado: ${provedor} não tem orçamento local definido`;
          else
            return { tipo: "substitui", modelo: atual, de: modelo, motivo: `${PREFIXO_DA_TROCA_POR_LIMITE}${atual} por limite do ${provedorDe(modelo)}` };
        } else primeiro ??= b;
      }
      for (const f of deps.fallbacks.filter((x) => x.fromModel === atual).sort((a, b) => a.order - b.order)) fila.push(f.toModel);
    }
    if (primeiro === null) return { tipo: "livre", modelo };
    return { tipo: "pausa", bloqueio: nota === undefined ? primeiro : { ...primeiro, nota } };
  }

  /**
   * Pergunta ao gateway compatível com OpenAI (LiteLLM) o orçamento da chave:
   * `GET {base sem /v1}/key/info` com a mesma chave. Só a pedido, e no máximo
   * a cada 10 minutos por provedor. Falha, 404 ou corpo estranho: nada, sem erro.
   */
  async consultarGateway(provedor: string, forcar = false): Promise<boolean> {
    if (!(await this.config()).gateways.includes(provedor)) return false;
    const alvo = this.gateway(provedor);
    if (alvo === null) return false;
    const agora = this.agora();
    const ultima = this.ultimaConsultaDoGateway.get(provedor);
    if (ultima !== undefined && agora - ultima < INTERVALO_DO_GATEWAY_MS && !forcar) return false;
    this.ultimaConsultaDoGateway.set(provedor, agora);
    try {
      const resposta = await this.buscar(alvo.url, { headers: alvo.headers, signal: AbortSignal.timeout(8000) });
      if (!resposta.ok) return false;
      const corpo = (await resposta.json()) as { info?: Record<string, unknown> } & Record<string, unknown>;
      const info = (typeof corpo.info === "object" && corpo.info !== null ? corpo.info : corpo) as Record<string, unknown>;
      const gasto = typeof info.spend === "number" ? info.spend : null;
      const teto = numeroOuNada(info.max_budget);
      if (gasto === null || teto === undefined) return false;
      const reset = typeof info.budget_reset_at === "string" ? Date.parse(info.budget_reset_at) : NaN;
      await this.registrar(
        provedor,
        [
          {
            chave: "orcamento",
            tipo: "orcamento",
            uso: Math.min(1, Math.max(0, gasto / teto)),
            usado: gasto,
            teto,
            unidade: "usd",
            ...(Number.isNaN(reset) ? {} : { resetaEm: Math.floor(reset / 1000) }),
            origem: "gateway",
          },
        ],
        agora,
      );
      return true;
    } catch {
      return false;
    }
  }
}

/** Endereço do `key/info` a partir do catálogo do provedor: `{base}/models` vira `{base sem /v1}/key/info`. */
export function urlDoKeyInfo(urlDoCatalogo: string): string {
  const base = urlDoCatalogo.replace(/\/models\/?$/, "").replace(/\/v1\/?$/, "").replace(/\/$/, "");
  return `${base}/key/info`;
}

export const limitesService = new LimitesService();
