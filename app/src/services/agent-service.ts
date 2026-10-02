import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { AgentBudgetPatch, AgentSpec, requiredServers, type ActionMode, type ActionStep, type AgentBudget, type ToolRef } from "../config/types.js";
import { today } from "../executor/budget.js";
import { splitModelId } from "../providers/registry.js";
import { SUBSCRIPTION_RUNTIMES } from "../runtimes/types.js";

type Db = typeof defaultDb;

export type AgentRow = typeof schema.agents.$inferSelect;
export type AgentVersionRow = typeof schema.agentVersions.$inferSelect;

/** Resumo de um agent para a lista, já com o que ele usa e como acorda. */
export interface AgentOverview extends AgentRow {
  version: number;
  stepCount: number;
  actionCount: number;
  models: string[];
  toolCount: number;
  skillCount: number;
  budget: AgentBudget;
  triggers: { kind: string; enabled: boolean; config: unknown }[];
  lastRun: {
    id: string;
    status: string;
    endedAt: number | null;
    createdAt: number;
    costUsd: number;
    estimateUsd: number;
  } | null;
}

/** Quem esta gravando. Agent nao sobe modo de passo de acao; pessoa sobe. */
export type Actor = "human" | "agent";

const TETOS = ["perRunUsd", "perDayUsd", "perRunTokens", "perDayTokens"] as const;

/**
 * Quem não é pessoa só aperta o teto de gasto, nunca afrouxa.
 *
 * O teto é o que segura um agent ligado a gatilho que entrou em laço, e quem
 * fala pelo servidor MCP pode ser uma sessão que leu texto de terceiro. Tirar
 * ou subir o teto fica para a tela, onde quem decide é a pessoa.
 */
function refuseLooserBudget(antes: AgentSpec["budget"] | undefined, depois: AgentSpec["budget"]): void {
  if (antes === undefined) return;
  for (const teto of TETOS) {
    const atual = antes[teto];
    if (atual === undefined) continue;
    const novo = depois[teto];
    if (novo === undefined || novo > atual) {
      throw new Error(
        `o teto ${teto} só pode subir ou sair pela tela do Locum, onde a pessoa decide. ` +
          `Daqui ele só baixa (atual: ${atual}).`,
      );
    }
  }
}

/** Identificador de agent: vira nome em URL, em log e em arquivo exportado. */
export const ID_DE_AGENT = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * Agent do proprio sistema, semeado pela migracao e nunca por uma pessoa.
 *
 * `locum-context` e o unico ate aqui: ele existe so para a proposta de
 * contexto passar pela mesma fila de aprovacao de qualquer outro agent, e
 * nunca deveria aparecer em lista, orcamento ou tela de edicao, nem aceitar
 * escrita por ali. O reconhecimento e pelo id, e nao por comparar spec, porque
 * spec pode mudar de versao em versao e o id nao.
 */
export const RESERVED_AGENT_IDS = new Set(["locum-context"]);

export function isReserved(agentId: string): boolean {
  return RESERVED_AGENT_IDS.has(agentId);
}

function refuseReserved(agentId: string): void {
  if (isReserved(agentId)) {
    throw new Error(`"${agentId}" e um agent do sistema e nao aceita escrita`);
  }
}

/** Passo de acao que teve o modo rebaixado na gravacao. */
export interface ActionDowngrade {
  step: string;
  from: ActionMode;
  to: "approve";
}

/** Linha de versao com o spec ja validado, que e como o resto do sistema usa. */
export interface AgentVersion extends Omit<AgentVersionRow, "spec"> {
  spec: AgentSpec;
  /** Vazio quando nada foi rebaixado. */
  downgrades: ActionDowngrade[];
}

/** Teto de gasto de um agent, com o que ja foi consumido hoje. */
export interface AgentBudgetView {
  agentId: string;
  name: string;
  enabled: boolean;
  /** Versao de onde o teto saiu, ou nulo em agent sem versao gravada. */
  version: number | null;
  perRunUsd: number | null;
  perDayUsd: number | null;
  perRunTokens: number | null;
  perDayTokens: number | null;
  spentTodayUsd: number;
  tokensToday: number;
  runsToday: number;
  /**
   * Modelos pedidos pelos passos sem preço cadastrado. O custo deles fica em
   * zero, e o teto em dólar não os alcança: para eles só o teto em tokens vale.
   */
  unpricedModels: string[];
}

/**
 * Cadastro de agents. Linha de comando, servidor MCP e interface passam por
 * aqui, porque a regra de versao imutavel precisa valer para os tres.
 */
export class AgentService {
  constructor(private readonly db: Db = defaultDb) {}

  async list(): Promise<AgentRow[]> {
    const rows = await this.db.select().from(schema.agents);
    return rows.filter((row) => !isReserved(row.id));
  }

  async get(agentId: string): Promise<AgentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, agentId));
    return row;
  }

  async listVersions(agentId: string): Promise<AgentVersion[]> {
    const rows = await this.db
      .select()
      .from(schema.agentVersions)
      .where(eq(schema.agentVersions.agentId, agentId))
      .orderBy(desc(schema.agentVersions.version));
    return rows.map(parseVersion);
  }

  async getLatestVersion(agentId: string): Promise<AgentVersion | undefined> {
    const row = await this.latestRow(agentId);
    return row ? parseVersion(row) : undefined;
  }

  /**
   * O teto de gasto de cada agent e quanto ja foi gasto hoje.
   *
   * O teto sai da versao do topo, porque e de la que o executor le, e o gasto
   * sai de `usage_daily`, que e onde ele acumula. Juntar os dois e o que
   * responde a pergunta que interessa a quem administra, que nao e "qual o
   * limite" nem "quanto gastei", e sim "quanto falta".
   *
   * Sao tres consultas e nao uma por agent: perguntar pela versao do topo
   * dentro de um laco releria a tabela inteira a cada volta, e quem chama isto
   * quer a lista, nunca uma linha so.
   */
  async budgets(): Promise<AgentBudgetView[]> {
    const rows = (await this.db.select().from(schema.agents)).filter((row) => !isReserved(row.id));
    const versions = await this.db
      .select()
      .from(schema.agentVersions)
      .orderBy(desc(schema.agentVersions.version));
    const usage = await this.db
      .select()
      .from(schema.usageDaily)
      .where(eq(schema.usageDaily.day, today()));
    const prices = await this.db.select().from(schema.modelPrices);
    const tabelados = new Set(prices.map((p) => `${p.provider}/${p.model}`));

    // As versoes chegam da mais nova para a mais velha, entao a primeira de
    // cada agent e a do topo e as seguintes nao substituem.
    const topo = new Map<string, AgentVersionRow>();
    for (const version of versions) {
      if (!topo.has(version.agentId)) topo.set(version.agentId, version);
    }
    const gasto = new Map(usage.map((u) => [u.agentId, u]));

    return rows.map((agent) => {
      const version = topo.get(agent.id);
      const spec = version ? AgentSpec.parse(version.spec) : undefined;
      const budget: AgentBudget = spec?.budget ?? {};
      const hoje = gasto.get(agent.id);
      // A assinatura não cobra por token, então não entra como modelo sem preço.
      const semPreco = new Set<string>();
      for (const step of spec?.steps ?? []) {
        if (step.type !== "model") continue;
        const { provider, model } = splitModelId(step.model);
        if (!SUBSCRIPTION_RUNTIMES.has(provider) && !tabelados.has(`${provider}/${model}`)) semPreco.add(step.model);
      }
      return {
        agentId: agent.id,
        name: agent.name,
        enabled: agent.enabled,
        version: version?.version ?? null,
        perRunUsd: budget.perRunUsd ?? null,
        perDayUsd: budget.perDayUsd ?? null,
        perRunTokens: budget.perRunTokens ?? null,
        perDayTokens: budget.perDayTokens ?? null,
        spentTodayUsd: hoje?.costUsd ?? 0,
        tokensToday: hoje?.tokens ?? 0,
        runsToday: hoje?.runs ?? 0,
        unpricedModels: [...semPreco],
      };
    });
  }

  /**
   * Grava o spec como versao nova. Spec identico ao topo devolve a versao que
   * ja existe: reeditar sem mudar nada nao pode inflar o historico nem
   * desconectar os runs antigos da versao que eles executaram.
   *
   * O `actor` decide se o spec pode subir o modo de um passo de acao. Um agent
   * nao pode: `approve` e o teto do que ele grava, e qualquer `draft` ou `auto`
   * que ele mande e rebaixado, com o rebaixamento devolvido na resposta.
   *
   * Sem essa trava o ADR 0002 seria contornavel em dois passos. O servidor MCP
   * nao expoe aprovacao, mas expoe `upsert_agent` e `run_agent`: gravar um passo
   * de acao em `auto` e mandar rodar publicaria sem clique nenhum. A regra nao e
   * "nao existe ferramenta de aprovar", e sim "nada sai sem uma pessoa ter dito
   * que sai", e e essa que precisa valer.
   */
  async upsert(
    spec: AgentSpec,
    note?: string,
    actor: Actor = "agent",
  ): Promise<AgentVersion> {
    const parsed = AgentSpec.parse(spec);
    const latest = await this.latestRow(parsed.id);
    if (actor !== "human") {
      refuseLooserBudget((latest?.spec as AgentSpec | undefined)?.budget, parsed.budget);
      await this.refuseNewWriteServerTools(parsed, latest?.spec);
    }
    const guarded = actor === "human" ? { spec: parsed, downgrades: [] } : demoteActions(parsed, latest?.spec);

    return this.write(guarded, latest, note);
  }

  private async write(
    guarded: { spec: AgentSpec; downgrades: ActionDowngrade[] },
    latest: AgentVersionRow | undefined,
    note?: string,
  ): Promise<AgentVersion> {
    const parsed = guarded.spec;
    refuseReserved(parsed.id);
    if (latest && sameSpec(latest.spec, parsed)) {
      return { ...parseVersion(latest), downgrades: guarded.downgrades };
    }

    await this.assertWithinInitiativeScope(parsed);

    // Juntos: a versão que falha, por queda ou pelo índice único quando o
    // servidor MCP grava a mesma versão em paralelo, não pode deixar para trás
    // um agent sem spec, que `get` daria por existente.
    const inserted = this.db.transaction((tx) => {
      tx.insert(schema.agents)
        .values({ id: parsed.id, name: parsed.name })
        .onConflictDoUpdate({
          target: schema.agents.id,
          set: { name: parsed.name },
        })
        .run();

      return tx
        .insert(schema.agentVersions)
        .values({
          id: randomUUID(),
          agentId: parsed.id,
          version: (latest?.version ?? 0) + 1,
          spec: parsed as unknown as object,
          note: note ?? null,
        })
        .returning()
        .get();
    });

    return { ...parseVersion(inserted), downgrades: guarded.downgrades };
  }

  /**
   * Ajusta o teto de gasto gravando versao nova.
   *
   * O orcamento mora no spec porque e de la que o executor le antes de cada
   * passo. Mexer nele e mexer no spec, entao vale a mesma regra de versao
   * imutavel: run antigo continua apontando para o teto sob o qual ele rodou.
   */
  async setBudget(
    agentId: string,
    patch: AgentBudgetPatch,
    note?: string,
    actor: Actor = "agent",
  ): Promise<AgentVersion> {
    const parsed = AgentBudgetPatch.parse(patch);
    const latest = await this.getLatestVersion(agentId);
    if (!latest) throw new Error(`agent "${agentId}" nao cadastrado`);

    const budget = { ...latest.spec.budget };
    for (const key of ["perRunUsd", "perDayUsd", "perRunTokens", "perDayTokens"] as const) {
      const value = parsed[key];
      if (value === undefined) continue;
      if (value === null) delete budget[key];
      else budget[key] = value;
    }

    if (actor !== "human") refuseLooserBudget(latest.spec.budget, budget);
    // Mexer no orcamento nao mexe em passo de acao, entao nao ha o que rebaixar.
    return this.upsert({ ...latest.spec, budget }, note ?? "orcamento ajustado", "human");
  }

  /**
   * Grava o que uma pessoa editou na tela, como versão nova.
   *
   * O identificador do spec tem que ser o do agent aberto. Sem essa trava, um
   * spec com outro `id` criaria um agent novo em silêncio, e a pessoa acharia
   * que tinha editado o que estava na tela.
   *
   * Grava como pessoa, e não como agent: é o clique de quem editou, então pode
   * subir o modo de um passo de ação. A nota é obrigatória porque é o que o
   * histórico mostra, e versão sem motivo é versão que ninguém entende depois.
   */
  async saveEdited(agentId: string, spec: AgentSpec, note: string): Promise<AgentVersion> {
    const motivo = note.trim();
    if (motivo.length === 0) throw new Error("diga o que mudou: a nota vira o registro da versão");
    if (spec.id !== agentId) {
      throw new Error(`o spec diz ser "${spec.id}" e a tela editava "${agentId}"`);
    }
    if (!(await this.get(agentId))) throw new Error(`agent "${agentId}" não existe`);
    return this.upsert(spec, motivo, "human");
  }

  /**
   * Agent novo a partir de um existente.
   *
   * Criar do zero, com passos vazios, raramente é o que se quer e é difícil de
   * acertar: o jeito real de ter um agent novo é partir de um que funciona e
   * mudar o que for diferente. A cópia sai como pessoa, então mantém o modo dos
   * passos de ação do original.
   */
  async duplicate(fromId: string, newId: string, newName: string): Promise<AgentVersion> {
    const id = newId.trim();
    const nome = newName.trim();
    if (!ID_DE_AGENT.test(id)) {
      throw new Error("identificador em minúsculas, números e hífen, de 2 a 63 caracteres");
    }
    if (nome.length === 0) throw new Error("o agent novo precisa de nome");
    refuseReserved(fromId);
    if (await this.get(id)) throw new Error(`já existe um agent "${id}"`);

    const origem = await this.getLatestVersion(fromId);
    if (!origem) throw new Error(`agent "${fromId}" não existe`);

    return this.upsert({ ...origem.spec, id, name: nome }, `duplicado de ${fromId}`, "human");
  }

  /**
   * Grava o rascunho que o "Criar com IA" montou, depois do clique de quem
   * pediu.
   *
   * Grava como agent, e não como pessoa, mesmo vindo de um clique: o conteúdo
   * foi escrito por um modelo, e é o rebaixamento de modo que garante que passo
   * de ação nasce em `approve`. Agent que já existe é recusado, porque o
   * rascunho é para criar e não deve virar versão nova de outro por coincidência
   * de nome.
   *
   * Não passa pela trava de ferramenta de servidor `write` de `upsert`: o
   * rascunho saiu do pedido da própria pessoa, que viu as ferramentas antes de
   * clicar. Agent novo também não tem teto anterior para afrouxar.
   */
  async saveDraft(spec: AgentSpec, descricao: string): Promise<AgentVersion> {
    const parsed = AgentSpec.parse(spec);
    if (!ID_DE_AGENT.test(parsed.id)) {
      throw new Error("identificador em minúsculas, números e hífen, de 2 a 63 caracteres");
    }
    refuseReserved(parsed.id);
    if (await this.get(parsed.id)) throw new Error(`já existe um agent "${parsed.id}"`);
    const pedido = descricao.trim().replace(/\s+/g, " ").slice(0, 200);
    return this.write(demoteActions(parsed, undefined), undefined, `criado com IA: ${pedido}`);
  }

  /**
   * Grava um agent a partir do texto de um arquivo, como uma pessoa faria.
   *
   * É a porta de entrada de agent no Locum, que não traz nenhum de fábrica:
   * quem usa escreve o seu, ou pega um de `examples/agents/`, e importa. Agent
   * que já existe ganha versão nova, com a anterior no histórico, e spec igual
   * ao gravado não cria versão nenhuma. O ator é pessoa porque o arquivo foi
   * escolhido por alguém; o que chega por agent entra pelo `upsert` do servidor
   * MCP, com o rebaixamento de modo.
   */
  async importSpec(
    texto: string,
    origem: string,
  ): Promise<{ version: AgentVersion; created: boolean }> {
    let bruto: unknown;
    try {
      bruto = JSON.parse(texto);
    } catch (err) {
      throw new Error(`${origem} não é JSON válido: ${err instanceof Error ? err.message : err}`);
    }
    const lido = AgentSpec.safeParse(bruto);
    if (!lido.success) {
      const onde = lido.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`)
        .join("; ");
      throw new Error(`${origem} não é um agent válido: ${onde}`);
    }
    // A mesma regra do `duplicate`: o id vira nome em URL, em log e em arquivo.
    if (!ID_DE_AGENT.test(lido.data.id)) {
      throw new Error(`${origem}: o id "${lido.data.id}" precisa ser minúsculas, números e hífen, de 2 a 63 caracteres`);
    }
    const created = (await this.get(lido.data.id)) === undefined;
    const version = await this.upsert(lido.data, `importado de ${origem}`, "human");
    return { version, created };
  }

  /**
   * O spec da versão mais recente, no formato que o `importSpec` lê de volta.
   *
   * Exportar e importar é o caminho de levar um agent para outra máquina, e o
   * sincronismo entre máquinas, quando vier, vai andar por este mesmo formato.
   */
  async exportSpec(agentId: string): Promise<string> {
    refuseReserved(agentId);
    const versao = await this.getLatestVersion(agentId);
    if (!versao) throw new Error(`agent "${agentId}" não existe`);
    return `${JSON.stringify(versao.spec, null, 2)}\n`;
  }

  /**
   * O que a lista de agents precisa mostrar sem abrir nenhum deles.
   *
   * Uma linha com nome e "habilitado" não responde nenhuma pergunta real: em
   * que modelo ele roda, de quanto em quanto tempo acorda, quanto gastou, se a
   * última execução deu certo. Montado aqui e não na janela porque seriam
   * quatro leituras por agent, e a regra de qual versão conta é desta camada.
   */
  async overview(): Promise<AgentOverview[]> {
    const linhas = await this.list();
    const gatilhos = await this.db.select().from(schema.triggers);

    return Promise.all(
      linhas.map(async (agent) => {
        const versao = await this.getLatestVersion(agent.id);
        const spec = versao?.spec;

        const modelos = [
          ...new Set(
            (spec?.steps ?? [])
              .filter((step): step is Extract<typeof step, { type: "model" }> => step.type === "model")
              .map((step) => step.model),
          ),
        ];

        const ferramentas = new Set<string>();
        for (const step of spec?.steps ?? []) {
          if (step.type !== "model") continue;
          for (const ref of step.tools ?? spec?.defaultTools ?? []) {
            ferramentas.add(`${ref.server}.${ref.tool}`);
          }
        }

        const [ultima] = await this.db
          .select({
            id: schema.runs.id,
            status: schema.runs.status,
            endedAt: schema.runs.endedAt,
            createdAt: schema.runs.createdAt,
            costUsd: schema.runs.costUsd,
            estimateUsd: schema.runs.estimateUsd,
          })
          .from(schema.runs)
          .innerJoin(schema.agentVersions, eq(schema.runs.agentVersionId, schema.agentVersions.id))
          .where(eq(schema.agentVersions.agentId, agent.id))
          .orderBy(desc(schema.runs.createdAt))
          .limit(1);

        return {
          ...agent,
          version: versao?.version ?? 0,
          stepCount: spec?.steps.length ?? 0,
          actionCount: (spec?.steps ?? []).filter((s) => s.type === "action").length,
          models: modelos,
          toolCount: ferramentas.size,
          skillCount: spec?.skills.length ?? 0,
          budget: spec?.budget ?? {},
          triggers: gatilhos
            .filter((g) => g.agentId === agent.id)
            .map((g) => ({ kind: g.kind, enabled: g.enabled, config: g.config })),
          lastRun: ultima ?? null,
        };
      }),
    );
  }

  /**
   * Recusa gravar spec que passa a exigir servidor de fora da iniciativa do
   * agent. So roda para agent que ja existe e ja esta ligado: agent novo e
   * agent sem iniciativa (`initiativeId` nulo) nao tem iniciativa para checar.
   */
  /**
   * Quem não é pessoa não põe em passo ferramenta nova de servidor `write`.
   *
   * A classe da ferramenta no passo é declarada por quem grava, e só
   * `external_write` é barrada em `toolsFor`. Sem esta trava, uma sessão do
   * servidor MCP declararia como `read` a ferramenta que comenta num PR e ela
   * rodaria sem passar pela fila. O servidor `write` é o que a pessoa marcou
   * como capaz de mudar estado; ferramenta dele que já estava no spec gravado
   * passa, porque alguém a pôs ali antes, e a nova fica para a tela.
   */
  private async refuseNewWriteServerTools(spec: AgentSpec, stored: unknown): Promise<void> {
    const escrita = new Set(
      (await this.db.select({ name: schema.mcpServers.name, scope: schema.mcpServers.scope }).from(schema.mcpServers))
        .filter((linha) => linha.scope === "write")
        .map((linha) => linha.name),
    );
    if (escrita.size === 0) return;

    const anterior = AgentSpec.safeParse(stored);
    const jaEstavam = new Set(anterior.success ? toolRefs(anterior.data).map(chaveDaTool) : []);
    const novas = toolRefs(spec).filter((ref) => escrita.has(ref.server) && !jaEstavam.has(chaveDaTool(ref)));
    if (novas.length === 0) return;

    const nomes = [...new Set(novas.map(chaveDaTool))].join(", ");
    throw new Error(
      `${nomes} é de servidor com escopo write; ferramenta assim só entra em passo pela tela do Locum, onde a pessoa decide. ` +
        `Escrita externa vai como passo de ação, pela fila de aprovação.`,
    );
  }

  private async assertWithinInitiativeScope(spec: AgentSpec): Promise<void> {
    const [agent] = await this.db
      .select({ initiativeId: schema.agents.initiativeId })
      .from(schema.agents)
      .where(eq(schema.agents.id, spec.id));
    if (!agent?.initiativeId) return;

    const servidores = new Set(
      (
        await this.db
          .select({ serverName: schema.initiativeMcpServers.serverName })
          .from(schema.initiativeMcpServers)
          .where(eq(schema.initiativeMcpServers.initiativeId, agent.initiativeId))
      ).map((r) => r.serverName),
    );

    const fora = requiredServers(spec).filter((servidor) => !servidores.has(servidor));
    if (fora.length > 0) {
      throw new Error(`agent ligado a uma iniciativa nao pode usar servidor fora dela: ${fora.join(", ")}`);
    }
  }

  private async latestRow(agentId: string): Promise<AgentVersionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.agentVersions)
      .where(eq(schema.agentVersions.agentId, agentId))
      .orderBy(desc(schema.agentVersions.version))
      .limit(1);
    return row;
  }
}

function parseVersion(row: AgentVersionRow): AgentVersion {
  return { ...row, spec: AgentSpec.parse(row.spec), downgrades: [] };
}

/**
 * Rebaixa para `approve` todo passo de acao que suba o modo em relacao ao que
 * ja estava gravado. Modo que a versao anterior ja tinha para aquele mesmo
 * passo passa: significa que uma pessoa autorizou antes, e reeditar outra parte
 * do spec nao pode derrubar essa autorizacao.
 *
 * "Mesmo passo" e mesma chave, mesma acao, mesmo destino e mesma entrada. So a
 * chave nao basta: quem nao e pessoa trocaria o `github.review_comment`
 * autorizado por um `slack.post` em outro canal debaixo da mesma chave, e a
 * autorizacao dada para uma coisa passaria a valer para outra.
 */
function demoteActions(
  spec: AgentSpec,
  stored: AgentSpec | unknown,
): { spec: AgentSpec; downgrades: ActionDowngrade[] } {
  const previous = new Map<string, ActionStep>();
  const parsedStored = stored === undefined ? undefined : AgentSpec.safeParse(stored);
  if (parsedStored?.success) {
    for (const step of parsedStored.data.steps) {
      if (step.type === "action") previous.set(step.key, step);
    }
  }

  const downgrades: ActionDowngrade[] = [];
  const steps = spec.steps.map((step) => {
    if (step.type !== "action" || step.mode === "approve") return step;
    const antes = previous.get(step.key);
    if (
      antes !== undefined &&
      antes.mode === step.mode &&
      antes.action === step.action &&
      antes.target === step.target &&
      antes.input === step.input
    ) {
      return step;
    }

    downgrades.push({ step: step.key, from: step.mode, to: "approve" });
    return { ...step, mode: "approve" as const };
  });

  return { spec: { ...spec, steps }, downgrades };
}

/** Toda ferramenta que o spec põe em passo, contando a herdada de `defaultTools`. */
function toolRefs(spec: AgentSpec): ToolRef[] {
  return [...spec.defaultTools, ...spec.steps.flatMap((step) => (step.type === "model" ? (step.tools ?? []) : []))];
}

const chaveDaTool = (ref: ToolRef): string => `${ref.server}.${ref.tool}`;

/**
 * O lado gravado passa pelo zod antes da comparacao porque o JSON so bate se as
 * duas pontas tiverem a mesma ordem de chaves, e a ordem vem do parse. Spec
 * gravado por uma versao antiga do schema pode nao passar, e ai conta como
 * diferente, que e o desfecho certo: vale gravar de novo.
 */
function sameSpec(stored: unknown, spec: AgentSpec): boolean {
  const normalized = AgentSpec.safeParse(stored);
  if (!normalized.success) return false;
  return JSON.stringify(normalized.data) === JSON.stringify(spec);
}

export const agentService = new AgentService();
