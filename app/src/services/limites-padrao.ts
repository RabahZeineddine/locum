import { agentService } from "./agent-service.js";
import { libraryService } from "./library-service.js";
import { limitesService, urlDoKeyInfo, type Bloqueio } from "./limites-service.js";
import { machineId } from "./machine-service.js";
import { pausaDoAgent, type DependenciasDaPausa } from "./pausa-por-limite.js";
import { providerService } from "./provider-service.js";

/** As dependências desta máquina: agents, cadeia de substituição e provedores disponíveis. */
export function dependenciasDaPausa(): DependenciasDaPausa {
  return {
    limites: limitesService,
    versao: (id) => agentService.getLatestVersion(id),
    fallbacks: () => providerService.getFallbacks(machineId),
    disponivel: (p) => providerService.entries()[p]?.available() ?? false,
    modeloDoPerfil: async (id) => (await libraryService.resolveProfile(id)).version.spec.model,
  };
}

/** A pausa de um agent nesta máquina. Nulo quando pode rodar. */
export function pausaPadrao(agentId: string, agoraMs?: number): Promise<Bloqueio | null> {
  return pausaDoAgent(agentId, dependenciasDaPausa(), agoraMs);
}

/**
 * Liga as fontes passivas e o gateway. Chamado uma vez na subida do app e do
 * servidor MCP. O endereço e a chave do gateway vêm do catálogo do provedor
 * cadastrado, sem ler segredo aqui.
 */
let desligar: (() => void) | undefined;

export function ligarLimites(): () => void {
  if (desligar !== undefined) return desligar;
  limitesService.usarGateway((provedor) => {
    const entrada = providerService.entries()[provedor];
    if (entrada?.registered === undefined || entrada.catalog === undefined || !entrada.available()) return null;
    const { url, headers } = entrada.catalog();
    return { url: urlDoKeyInfo(url), headers };
  });
  const parar = limitesService.ligar();
  desligar = () => {
    parar();
    desligar = undefined;
  };
  return desligar;
}

export interface LimiteComEstado {
  provedor: string;
  chave: string;
  tipo: "janela" | "orcamento" | "taxa";
  uso: number;
  usado?: number;
  teto?: number;
  unidade?: "usd" | "tokens" | "req" | "%";
  resetaEm?: number;
  origem: "assinatura" | "orcamento-local" | "cabecalho-api" | "gateway";
  quando: number;
  estado: "ok" | "aviso" | "erro";
}

export interface ProvedorComLimites {
  provedor: string;
  /** Roda por assinatura: o Atualizar custa uma chamada mínima. */
  assinatura: boolean;
  /** Gateway cadastrado: o Atualizar pergunta o orçamento da chave. */
  gateway: boolean;
  /** Pode ter orçamento local: provedor de API. */
  aceitaOrcamento: boolean;
  orcamento: { diaUsd?: number; mesUsd?: number };
  /** Limiares só deste provedor, em fração; ausente vale o global. */
  limiares: { janela?: number; orcamento?: number };
  /** Cadastrado: pode ser marcado como LiteLLM. */
  gatewayPossivel: boolean;
  limites: LimiteComEstado[];
  /** Epoch em ms em que a pausa solta, ou nulo. */
  pausaAte: number | null;
}

export interface VisaoDosLimites {
  protecao: boolean;
  limiarJanela: number;
  limiarOrcamento: number;
  usarSubstituto: boolean;
  gateways: string[];
  provedores: ProvedorComLimites[];
}

/** Tudo que a tela e o MCP mostram dos limites: um item por provedor com limite ou orçamento. */
export async function visaoDosLimites(agoraMs: number = Date.now()): Promise<VisaoDosLimites> {
  const config = await limitesService.config();
  const todos = await limitesService.listar(agoraMs);
  const entradas = providerService.entries();
  const nomes = new Set<string>(todos.map((l) => l.provedor));
  for (const [nome, entrada] of Object.entries(entradas)) if (entrada.available() && nome !== "codex") nomes.add(nome);
  const provedores: ProvedorComLimites[] = [];
  for (const provedor of [...nomes].sort()) {
    const entrada = entradas[provedor];
    if (entrada === undefined && !todos.some((l) => l.provedor === provedor)) continue;
    const assinatura = provedor === "claude-code" || provedor === "codex";
    const limites: LimiteComEstado[] = [];
    for (const l of todos.filter((x) => x.provedor === provedor)) limites.push({ ...l, estado: await limitesService.estado(l) });
    const bloqueio = await limitesService.bloqueio(provedor, agoraMs);
    provedores.push({
      provedor,
      assinatura,
      gateway: entrada?.registered !== undefined && config.gateways.includes(provedor),
      aceitaOrcamento: !assinatura,
      orcamento: config.orcamentos[provedor] ?? {},
      limiares: config.limiares[provedor] ?? {},
      gatewayPossivel: entrada?.registered !== undefined,
      limites,
      pausaAte: bloqueio?.ate ?? null,
    });
  }
  return { protecao: config.protecao, limiarJanela: config.limiarJanela, limiarOrcamento: config.limiarOrcamento, usarSubstituto: config.usarSubstituto, gateways: config.gateways, provedores };
}

/**
 * O botão Atualizar. Claude Code: uma chamada mínima ao Haiku (custa cota),
 * porque é o jeito de o `claude -p` entregar o retrato. Gateway: o `key/info`,
 * no máximo a cada 10 minutos. O resto não tem o que perguntar: vem sozinho
 * nas chamadas.
 */
export async function atualizarLimites(provedor: string): Promise<{ chamou: boolean }> {
  if (provedor === "claude-code") {
    const { ClaudeCodeRuntime } = await import("../runtimes/claude-code.js");
    await new ClaudeCodeRuntime(new Map()).run({ provider: "claude-code", model: "haiku", prompt: "ok", promptPorStdin: true, tools: {}, maxSteps: 1 });
    return { chamou: true };
  }
  return { chamou: await limitesService.consultarGateway(provedor) };
}
