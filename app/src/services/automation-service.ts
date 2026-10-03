import { TriggerConfig, type AgentSpec, type TriggerConfigInput } from "../config/types.js";
import { agentService, ID_DE_AGENT, isReserved, type AgentService, type AgentVersion } from "./agent-service.js";
import { executionService, type ExecutionService } from "./execution-service.js";
import { triggerService, type TriggerEntry, type TriggerService } from "./trigger-service.js";

/** Um gatilho como o canvas manda: com `id` quando já existia. */
export interface AutomationTriggerInput {
  id?: string;
  config: TriggerConfigInput;
  /** Ausente mantém o que estava, e gatilho novo nasce desligado. */
  enabled?: boolean;
}

export interface AutomationSaveInput {
  spec: AgentSpec;
  triggers: AutomationTriggerInput[];
  /** O que mudou. Vira a nota da versão, como no editor em lista. */
  note: string;
  /** Verdadeiro para automação nova: recusa se o id já existir. */
  create?: boolean;
}

export interface Automation {
  version: AgentVersion;
  triggers: TriggerEntry[];
}

/**
 * A automação: um agent e os gatilhos dele, editados juntos pelo canvas.
 *
 * Não tem tabela própria de propósito. O agent já é um grafo de passos e o
 * gatilho já aponta para ele; uma tabela de automação seria uma segunda
 * resposta para "o que roda quando chega mensagem no canal X". Este serviço
 * só junta as duas gravações na ordem que não deixa nada pela metade: valida
 * os gatilhos antes de gravar o spec, e só depois mexe na tabela de gatilhos.
 *
 * Gravar não liga nada. Gatilho novo nasce desligado, como em qualquer outro
 * caminho, e ligar é um clique de pessoa no interruptor da automação.
 */
export class AutomationService {
  constructor(
    private readonly agents: AgentService = agentService,
    private readonly triggers: TriggerService = triggerService,
    private readonly executions: ExecutionService = executionService,
  ) {}

  async get(agentId: string): Promise<Automation | null> {
    if (isReserved(agentId)) return null;
    const version = await this.agents.getLatestVersion(agentId);
    if (version === undefined) return null;
    return { version, triggers: await this.triggers.list(agentId) };
  }

  async save(input: AutomationSaveInput): Promise<Automation> {
    const agentId = input.spec.id;
    // Antes de qualquer escrita: um gatilho inválido não pode deixar para
    // trás um spec novo gravado com os gatilhos antigos.
    for (const gatilho of input.triggers) TriggerConfig.parse(gatilho.config);

    let version: AgentVersion;
    if (input.create === true) {
      if (!ID_DE_AGENT.test(agentId)) {
        throw new Error("identificador em minúsculas, números e hífen, de 2 a 63 caracteres");
      }
      if ((await this.agents.get(agentId)) !== undefined) throw new Error(`já existe uma automação "${agentId}"`);
      const nota = input.note.trim() || "criada no canvas";
      version = await this.agents.upsert(input.spec, nota, "human");
    } else {
      version = await this.agents.saveEdited(agentId, input.spec, input.note);
    }

    const atuais = await this.triggers.list(agentId);
    const mantidos = new Set<string>();
    for (const gatilho of input.triggers) {
      const salvo = await this.triggers.set(agentId, gatilho.config, {
        ...(gatilho.id === undefined ? {} : { id: gatilho.id }),
        ...(gatilho.enabled === undefined ? {} : { enabled: gatilho.enabled }),
      });
      mantidos.add(salvo.id);
    }
    for (const antigo of atuais) {
      if (!mantidos.has(antigo.id)) await this.triggers.remove(antigo.id);
    }

    return { version, triggers: await this.triggers.list(agentId) };
  }

  /**
   * Liga ou desliga a automação inteira: todos os gatilhos dela.
   *
   * O agent continua podendo rodar pelo botão. O que o interruptor controla é
   * se ela acorda sozinha, que é a pergunta que a pessoa faz ao olhar a lista.
   */
  async setEnabled(agentId: string, enabled: boolean): Promise<TriggerEntry[]> {
    for (const gatilho of await this.triggers.list(agentId)) {
      if (gatilho.enabled !== enabled) await this.triggers.setEnabled(gatilho.id, enabled);
    }
    return this.triggers.list(agentId);
  }

  /**
   * "Executar agora". Roda sem evento, como o gatilho de relógio, e aponta o
   * run para o gatilho manual quando a automação tem um, para a lista de
   * execuções dizer de onde ele veio.
   */
  async runNow(agentId: string): Promise<{ runId: string }> {
    if (isReserved(agentId)) throw new Error(`"${agentId}" e um agent do sistema e nao aceita escrita`);
    const manual = (await this.triggers.list(agentId)).find((g) => g.config.kind === "manual");
    const { runId } = await this.executions.startForEvent({
      eventId: null,
      agentId,
      ...(manual === undefined ? {} : { triggerId: manual.id }),
      wait: false,
    });
    return { runId };
  }

  /**
   * Um identificador livre a partir do nome, para a automação nova não pedir
   * que a pessoa invente um slug.
   */
  async suggestId(nome: string): Promise<string> {
    const base =
      nome
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50) || "automacao";
    const raiz = base.length < 2 ? `${base}-automacao` : base;
    for (let n = 1; n < 1000; n++) {
      const id = n === 1 ? raiz : `${raiz}-${n}`;
      if (!isReserved(id) && (await this.agents.get(id)) === undefined) return id;
    }
    throw new Error("não achei identificador livre para esse nome");
  }
}

export const automationService = new AutomationService();
