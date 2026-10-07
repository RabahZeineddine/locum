import { eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { McpRegistry } from "../mcp/registry.js";
import type { McpCaller } from "../sources/mcp-poll.js";
import { ATLASSIAN_SERVER, JiraAtlassianAdapter } from "../trackers/jira-atlassian.js";
import {
  buildTracker,
  isTrackerKind,
  TRACKER_DEFAULT_BASE_URL,
  type TrackerAdapter,
  type TrackerIssue,
  type TrackerIssueDraft,
  type TrackerKind,
  type TrackerProject,
} from "../trackers/registry.js";
import { mcpService } from "./mcp-service.js";
import { secretService, type SecretService } from "./secret-service.js";
import { settingsService, type SettingsService } from "./settings-service.js";

type Db = typeof defaultDb;

/**
 * Onde a credencial de um tracker mora no cofre.
 *
 * Endereço por convenção, como o dos provedores: o tracker já é identificado
 * pelo id do cadastro, e pedir a alguém que invente um endereço para gravar um
 * token seria cerimônia sem escolha real por trás. Quem apontou o
 * `credential_ref` para outro lugar pela linha de comando continua valendo,
 * porque a leitura segue o cadastro e só cai aqui quando não há.
 */
export function trackerCredentialRef(id: string): string {
  return `tracker/${id}`;
}

/**
 * Onde mora o token da conexão Atlassian, que o `jira-atlassian` usa.
 *
 * É o endereço que o `McpOAuthService` grava para o servidor da vitrine. O
 * tracker só pergunta se ele existe; quem lê e renova é o serviço de OAuth.
 */
const ATLASSIAN_TOKEN_REF = `mcp/${ATLASSIAN_SERVER}`;

/** Credencial que vem de uma conexão OAuth/MCP, e não de um token avulso guardado pelo tracker. */
function refDeConexao(kind: string): string | null {
  if (kind === "jira-atlassian") return ATLASSIAN_TOKEN_REF;
  if (kind === "shortcut") return "mcp/shortcut";
  return null;
}

function pelaConexao(kind: string): boolean {
  return refDeConexao(kind) !== null;
}

/**
 * Chama uma ferramenta de um servidor MCP habilitado, abrindo e fechando a
 * conexão na mesma chamada, como a resposta no Slack faz.
 */
const chamarMcp: McpCaller = async (server, tool, args) => {
  const registry = McpRegistry.fromList(await mcpService.enabledConfigs());
  if (!registry.has(server)) throw new Error(`servidor MCP "${server}" nao esta conectado`);
  try {
    return await registry.callTool(server, tool, args);
  } finally {
    await registry.closeAll();
  }
};

/** O que a última conferência descobriu, guardado por referência de cofre. */
const CONFERIDO_EM = "checkedAt";
const PROJETOS = "projects";

/** Um tracker como ele aparece para quem administra. Nunca com o segredo. */
export interface TrackerInfo {
  id: string;
  kind: TrackerKind;
  label: string;
  baseUrl: string;
  /** Destino padrão do cadastro, ou nulo quando ninguém escolheu ainda. */
  project: string | null;
  /** O e-mail que o Jira exige junto do token. Nulo no GitHub e pela Atlassian. */
  account: string | null;
  enabled: boolean;
  /** Endereço do segredo no cofre. O valor não cabe neste tipo, de propósito. */
  ref: string;
  /**
   * Existe texto cifrado guardado. Vale mesmo sem keychain neste processo. No
   * `jira-atlassian`, diz se a conexão Atlassian está autorizada.
   */
  stored: boolean;
  /** Este processo alcança o keychain, isto é, dá para gravar valor. */
  vault: boolean;
  /** Segundos desde a época, ou nulo quando nunca foi conferido. */
  checkedAt: number | null;
  /** Quantos destinos a última conferência enxergou. */
  projectCount: number | null;
}

/**
 * O desfecho de um teste de conexão.
 *
 * `missing` é a falta de credencial, e não chega a sair da máquina: perguntar
 * os projetos sem token gastaria uma viagem para ouvir o que já se sabe daqui.
 */
export type TrackerCheck =
  | { ok: true; count: number; checkedAt: number }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "refused"; message: string };

export interface TrackerRegistration {
  id: string;
  kind: string;
  label: string;
  /** Vazio cai no endereço de fábrica do tipo, que só o GitHub tem. */
  baseUrl?: string;
  project?: string | null;
  account?: string | null;
}

/**
 * Trackers de tarefa: cadastrar, testar, procurar e criar.
 *
 * Mora num serviço pela mesma razão dos provedores: a interface cadastra, o
 * passo de ação procura antes de propor, e a linha de comando precisa das duas
 * coisas. A regra de qual credencial vale e de como o endereço é montado não
 * pode ter três versões.
 *
 * Criar tarefa existe aqui e não tem canal na ponte. Não é esquecimento: pela
 * regra do marco, abrir tarefa nunca é automático, então o único caminho até
 * `createIssue` é o passo de ação, que nasce em modo de aprovação e para na
 * fila até alguém clicar. Um canal de janela seria um segundo caminho, sem
 * fila no meio.
 */
export class TrackerService {
  constructor(
    private readonly db: Db = defaultDb,
    private readonly secrets: SecretService = secretService,
    private readonly settings: SettingsService = settingsService,
    private readonly mcp: McpCaller = chamarMcp,
  ) {}

  private chave(ref: string, sufixo: string): string {
    return `tracker:${ref}:${sufixo}`;
  }

  async list(): Promise<TrackerInfo[]> {
    const rows = await this.db.select().from(schema.trackers);

    return Promise.all(
      rows.map(async (row) => {
        const ref = row.credentialRef ?? trackerCredentialRef(row.id);
        const refConexao = refDeConexao(row.kind);
        const temCredencial = this.secrets.has(ref) || (refConexao !== null && this.secrets.has(refConexao));
        const [conferidoEm, projetos] = await Promise.all([
          this.settings.get(this.chave(ref, CONFERIDO_EM)),
          this.settings.get(this.chave(ref, PROJETOS)),
        ]);

        return {
          id: row.id,
          // Linha editada à mão com um tipo que não existe vira `jira` na
          // leitura em vez de derrubar a tela inteira: quem cadastra passa
          // pela validação do `register`, e uma lista que não abre esconderia
          // também os cadastros bons.
          kind: isTrackerKind(row.kind) ? row.kind : "jira",
          label: row.label,
          baseUrl: row.baseUrl,
          project: row.project,
          account: row.account,
          enabled: row.enabled,
          ref,
          stored: temCredencial,
          vault: this.secrets.available,
          checkedAt: conferidoEm === undefined ? null : Number(conferidoEm),
          projectCount: projetos === undefined ? null : Number(projetos),
        };
      }),
    );
  }

  /**
   * Cadastra um tracker.
   *
   * O identificador é normalizado e recusado se sobrar qualquer outra coisa,
   * pela mesma razão do provedor cadastrado: ele vira parte do endereço no
   * cofre, e `Meu-Jira` e `meu-jira` seriam dois cadastros para quem lê e um só
   * para o sistema de arquivos do macOS, que não distingue maiúscula.
   *
   * O e-mail é exigido no Jira aqui, e não só na hora de conectar. O erro
   * aparece para quem está preenchendo o formulário, que é quem sabe qual conta
   * é, e não algumas horas depois dentro de uma execução.
   */
  async register(input: TrackerRegistration): Promise<void> {
    const id = input.id.trim().toLowerCase();
    const label = input.label.trim();
    const account = input.account?.trim() ?? "";

    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(id)) {
      throw new Error(
        `identificador "${input.id}" invalido: use de 2 a 32 caracteres entre minuscula, numero e hifen`,
      );
    }
    if (!isTrackerKind(input.kind)) {
      throw new Error(`tipo de tracker "${input.kind}" nao existe`);
    }
    if (label.length === 0) throw new Error("tracker sem nome nao se cadastra");
    if (input.kind === "jira" && account.length === 0) {
      throw new Error("o Jira autentica por e-mail e token, entao o e-mail da conta e obrigatorio");
    }

    let baseUrl = (input.baseUrl?.trim() ?? "") || TRACKER_DEFAULT_BASE_URL[input.kind];
    if (baseUrl.length === 0) throw new Error("tracker sem endereco base nao se cadastra");
    // Pela Atlassian o endereço é o do site, e quem copia da barra do navegador
    // costuma trazer só `empresa.atlassian.net`.
    if (input.kind === "jira-atlassian" && !/^https?:\/\//.test(baseUrl)) baseUrl = `https://${baseUrl}`;

    let endereco: URL;
    try {
      endereco = new URL(baseUrl);
    } catch {
      throw new Error(`endereco "${baseUrl}" nao e uma URL`);
    }
    if (endereco.protocol !== "http:" && endereco.protocol !== "https:") {
      throw new Error(`endereco "${baseUrl}" precisa ser http ou https`);
    }

    const ocupado = await this.db.select().from(schema.trackers).where(eq(schema.trackers.id, id));
    if (ocupado.length > 0) throw new Error(`o identificador "${id}" ja esta cadastrado`);

    await this.db.insert(schema.trackers).values({
      id,
      kind: input.kind,
      label,
      baseUrl,
      project: input.project?.trim() || null,
      account: account.length === 0 ? null : account,
      credentialRef: trackerCredentialRef(id),
      enabled: true,
    });
  }

  /**
   * Remove o cadastro e a credencial junto.
   *
   * Deixar o segredo no cofre guardaria um token que nada mais lê, sob um
   * endereço que ninguém mais sabe de quem era. Não há aviso de uso como no
   * provedor porque um passo aponta para o tracker pelo id do cadastro, e o
   * passo que apontar para um cadastro que sumiu falha na proposta, antes de
   * qualquer coisa sair.
   */
  async remove(id: string): Promise<boolean> {
    const [row] = await this.db.select().from(schema.trackers).where(eq(schema.trackers.id, id));
    if (row === undefined) return false;

    const ref = row.credentialRef ?? trackerCredentialRef(id);
    this.secrets.remove(ref);
    await this.esquecerConferencia(ref);
    await this.db.delete(schema.trackers).where(eq(schema.trackers.id, id));
    return true;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const alteradas = await this.db
      .update(schema.trackers)
      .set({ enabled })
      .where(eq(schema.trackers.id, id))
      .returning({ id: schema.trackers.id });
    if (alteradas.length === 0) throw new Error(`tracker "${id}" nao existe`);
  }

  /**
   * O destino padrão do cadastro, ou nulo quando ninguém escolheu ainda.
   *
   * Existe para o passo de ação, que precisa do destino para montar a proposta
   * e não pode carregar a lista inteira de trackers para achar uma string.
   */
  async defaultProject(id: string): Promise<string | null> {
    return (await this.linha(id)).project;
  }

  /** Qual destino padrão as tarefas deste tracker usam. */
  async setProject(id: string, project: string | null): Promise<void> {
    const limpo = project?.trim() ?? "";
    const alteradas = await this.db
      .update(schema.trackers)
      .set({ project: limpo.length === 0 ? null : limpo })
      .where(eq(schema.trackers.id, id))
      .returning({ id: schema.trackers.id });
    if (alteradas.length === 0) throw new Error(`tracker "${id}" nao existe`);
  }

  /**
   * Guarda o token e joga fora o que a conferência anterior tinha descoberto.
   *
   * A contagem de projetos descreve o token que estava ali, e não o cadastro:
   * mantê-la depois da troca faria a tela afirmar, com cara de dado conferido,
   * um acesso que o token novo pode nem ter.
   */
  async setSecret(id: string, secret: string): Promise<void> {
    const row = await this.linha(id);
    const limpo = secret.trim();
    if (limpo.length === 0) throw new Error("credencial vazia nao se guarda, use clearSecret");

    if (pelaConexao(row.kind)) {
      throw new Error(`o tracker "${id}" usa a conexão Atlassian e nao guarda credencial propria`);
    }
    const ref = row.credentialRef ?? trackerCredentialRef(id);
    this.secrets.set(ref, limpo);
    await this.esquecerConferencia(ref);
  }

  /** Devolve se havia algo para apagar. */
  async clearSecret(id: string): Promise<boolean> {
    const row = await this.linha(id);
    const ref = row.credentialRef ?? trackerCredentialRef(id);
    const havia = this.secrets.remove(ref);
    await this.esquecerConferencia(ref);
    return havia;
  }

  /**
   * Os destinos visíveis para a credencial deste tracker.
   *
   * É leitura, e é a mesma chamada que o teste de conexão faz. Não é
   * coincidência: a pergunta "esta credencial presta?" não tem resposta melhor
   * que "o que ela alcança", e um endpoint de saúde que responde bem sem
   * permissão de projeto nenhum mentiria justamente no caso que importa.
   */
  async listProjects(id: string): Promise<TrackerProject[]> {
    return (await this.adapter(id)).listProjects();
  }

  /**
   * Pergunta ao tracker quais destinos ele enxerga, e guarda a resposta.
   *
   * A recusa volta como dado, e não como erro subindo a pilha: quem clicou em
   * testar quer ver o motivo na tela, e credencial recusada é resposta legítima
   * de um teste de conexão.
   */
  async testConnection(id: string): Promise<TrackerCheck> {
    const row = await this.linha(id);
    const refConexao = refDeConexao(row.kind);
    const ref = row.credentialRef ?? trackerCredentialRef(id);
    const temCredencial = this.secrets.has(ref) || (refConexao !== null && this.secrets.has(refConexao));
    if (!temCredencial) return { ok: false, reason: "missing" };

    try {
      const projetos = await this.listProjects(id);
      const checkedAt = Math.floor(Date.now() / 1000);
      await this.settings.set(this.chave(ref, PROJETOS), String(projetos.length));
      await this.settings.set(this.chave(ref, CONFERIDO_EM), String(checkedAt));
      return { ok: true, count: projetos.length, checkedAt };
    } catch (erro) {
      // O adaptador já raspa a credencial da mensagem, nas duas formas em que
      // ela viaja. Aqui ela só é repassada.
      return { ok: false, reason: "refused", message: erro instanceof Error ? erro.message : String(erro) };
    }
  }

  /**
   * A tarefa que já cita este pull request, ou nulo.
   *
   * É o que impede a segunda execução sobre o mesmo pull request de abrir uma
   * segunda tarefa. Fica no serviço, e não no passo, porque a linha de comando
   * e o servidor MCP perguntam a mesma coisa.
   */
  async findIssueForPullRequest(
    id: string,
    pullRequestUrl: string,
    project?: string,
  ): Promise<TrackerIssue | null> {
    const row = await this.linha(id);
    const destino = project?.trim() || row.project;
    if (!destino) throw new Error(`o tracker "${id}" esta sem projeto de destino`);
    return (await this.adapter(id)).findByPullRequest(destino, pullRequestUrl);
  }

  /**
   * Cria a tarefa de verdade.
   *
   * Sem canal na ponte, e sem chamada em lugar nenhum que não venha de uma
   * decisão já tomada: quem chega aqui é a `ApprovalGate`, depois do clique. O
   * método existe porque o adaptador precisa de alguém que junte cadastro,
   * credencial e rascunho, e esse alguém é o serviço.
   */
  async createIssue(id: string, draft: TrackerIssueDraft): Promise<TrackerIssue> {
    const row = await this.linha(id);
    if (!row.enabled) throw new Error(`o tracker "${id}" esta desligado`);
    return (await this.adapter(id)).createIssue(draft);
  }

  private async linha(id: string): Promise<typeof schema.trackers.$inferSelect> {
    const [row] = await this.db.select().from(schema.trackers).where(eq(schema.trackers.id, id));
    if (row === undefined) throw new Error(`tracker "${id}" nao existe`);
    return row;
  }

  /**
   * Monta o adaptador com a credencial do cofre.
   *
   * O segredo entra aqui e não sai: ele vive no adaptador, que o usa para
   * montar cabeçalho, e nenhum dos tipos que este serviço devolve tem campo
   * onde ele coubesse.
   *
   * Sem keychain neste processo o cofre devolve indefinido, e a mensagem diz
   * isso em vez de "credencial ausente": quem roda pela linha de comando tem o
   * token guardado, só não tem como abri-lo, e as duas situações pedem coisas
   * diferentes de quem está lendo.
   */
  private async adapter(id: string): Promise<TrackerAdapter> {
    const row = await this.linha(id);
    if (row.kind === "jira-atlassian") {
      if (!this.secrets.has(ATLASSIAN_TOKEN_REF)) {
        throw new Error(`o tracker "${id}" usa a conexão Atlassian, que nao esta autorizada`);
      }
      return new JiraAtlassianAdapter(row.baseUrl, (tool, args) => this.mcp(ATLASSIAN_SERVER, tool, args));
    }

    const refConexao = refDeConexao(row.kind);
    const ref = row.credentialRef ?? trackerCredentialRef(id);
    const secret = this.secrets.get(ref) ?? (refConexao ? this.secrets.get(refConexao) : undefined);

    if (secret === undefined) {
      throw new Error(
        this.secrets.has(ref) || (refConexao && this.secrets.has(refConexao))
          ? `a credencial de "${id}" esta guardada mas o keychain nao abre neste processo`
          : `o tracker "${id}" esta sem credencial guardada`,
      );
    }
    if (!isTrackerKind(row.kind)) throw new Error(`tipo de tracker "${row.kind}" nao existe`);

    return buildTracker({ kind: row.kind, baseUrl: row.baseUrl, secret, account: row.account });
  }

  private async esquecerConferencia(ref: string): Promise<void> {
    await this.settings.remove(this.chave(ref, PROJETOS));
    await this.settings.remove(this.chave(ref, CONFERIDO_EM));
  }
}

export const trackerService = new TrackerService();
