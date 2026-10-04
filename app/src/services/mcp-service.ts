import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { isAuthError, McpRegistry, type McpConnectOutcome, type McpToolInfo } from "../mcp/registry.js";
import { McpServerConfig, type McpServerInput } from "../config/types.js";
import { CREDENTIAL_PLACEHOLDER, fillCredential, secretService, type SecretService } from "./secret-service.js";

export type { McpToolInfo };
export { isAuthError };

type Db = typeof defaultDb;

export type McpServerRow = typeof schema.mcpServers.$inferSelect;

/** Resultado de uma tentativa de conexao, para a tela e para a linha de comando. */
export interface McpConnectionCheck {
  name: string;
  ok: boolean;
  elapsedMs: number;
  toolCount: number;
  error?: string;
}

/**
 * O que se sabe da última vez que o servidor foi procurado. `needsAuth` vale
 * quando a falha mais recente veio depois do último sucesso e tem cara de
 * credencial recusada ou vencida.
 */
export interface McpServerHealth {
  lastOkAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  needsAuth: boolean;
}

/** Cadastro somado ao que so interessa a quem administra, nao a quem conecta. */
export interface McpServerEntry {
  config: McpServerConfig;
  enabled: boolean;
  credentialRef: string | null;
  health: McpServerHealth;
}

/** Teto do erro guardado: o bastante para a tela, sem guardar página de HTML. */
const TETO_DO_ERRO = 500;

/**
 * Cadastro de servidores MCP. Linha de comando, servidor MCP proprio e
 * interface passam por aqui, porque a validacao de transporte e a regra de
 * quem entra no executor precisam valer para os tres.
 */
export class McpService {
  private refresher: ((name: string) => Promise<void>) | null = null;

  constructor(
    private readonly db: Db = defaultDb,
    private readonly secrets: SecretService = secretService,
  ) {}

  /**
   * Quem renova token antes de conectar. Fica injetado, e não importado, porque
   * a renovação de OAuth depende deste serviço para gravar a credencial.
   */
  useRefresher(refresher: (name: string) => Promise<void>): void {
    this.refresher = refresher;
  }

  async list(): Promise<McpServerEntry[]> {
    const rows = await this.db.select().from(schema.mcpServers);
    return rows.map(toEntry);
  }

  async get(name: string): Promise<McpServerEntry | undefined> {
    const row = await this.row(name);
    return row ? toEntry(row) : undefined;
  }

  /**
   * So o que o executor deve enxergar. Servidor desabilitado some do registro
   * em vez de virar erro de conexao no meio de um passo.
   */
  async enabledConfigs(): Promise<McpServerConfig[]> {
    const rows = await this.db
      .select()
      .from(schema.mcpServers)
      .where(eq(schema.mcpServers.enabled, true));
    await this.refreshAll(rows);
    const atuais = await this.db
      .select()
      .from(schema.mcpServers)
      .where(eq(schema.mcpServers.enabled, true));
    return atuais.map((row) => this.connectable(row));
  }

  /**
   * Cadastra ou atualiza pelo nome, que e a chave que o passo referencia.
   *
   * A credencial vinculada foi entregue para um destino. Se a atualizacao muda
   * o destino (transporte, endereco ou comando), o vinculo cai, e quem mudou
   * conecta de novo: senao bastaria regravar o nome com outra URL e o mesmo
   * marcador para o token sair para um servidor que ninguem autorizou.
   */
  async register(config: McpServerInput): Promise<McpServerEntry> {
    const parsed = McpServerConfig.parse(config);
    const anterior = await this.row(parsed.name);
    const mudouDestino =
      anterior !== undefined &&
      (anterior.transport !== parsed.transport ||
        (anterior.url ?? null) !== (parsed.url ?? null) ||
        JSON.stringify(anterior.command ?? null) !== JSON.stringify(parsed.command ?? null));
    const values = {
      ...(mudouDestino && anterior.credentialRef !== null ? { credentialRef: null } : {}),
      name: parsed.name,
      transport: parsed.transport,
      command: parsed.command ?? null,
      env: parsed.env ?? null,
      url: parsed.url ?? null,
      headers: parsed.headers ?? null,
      scope: parsed.scope,
      idleTimeoutMs: parsed.idleTimeoutMs,
    };

    await this.db
      .insert(schema.mcpServers)
      .values({ id: randomUUID(), ...values })
      .onConflictDoUpdate({ target: schema.mcpServers.name, set: values });

    return toEntry((await this.row(parsed.name))!);
  }

  async remove(name: string): Promise<boolean> {
    const deleted = await this.db
      .delete(schema.mcpServers)
      .where(eq(schema.mcpServers.name, name))
      .returning();
    return deleted.length > 0;
  }

  /**
   * Aponta o servidor para uma credencial do cofre. O segredo entra onde o
   * cadastro tiver o marcador `${credential}`, em `env` ou em `headers`, e
   * `null` desfaz o vinculo. Isto grava so o endereco, nunca o valor.
   */
  async setCredentialRef(name: string, ref: string | null): Promise<void> {
    if (ref !== null) this.secrets.pathFor(ref);

    const updated = await this.db
      .update(schema.mcpServers)
      .set({ credentialRef: ref })
      .where(eq(schema.mcpServers.name, name))
      .returning();
    if (updated.length === 0) throw new Error(`servidor MCP "${name}" nao cadastrado`);
  }

  /**
   * Guarda um token colado pela pessoa, para servidor que não autoriza por
   * OAuth (chave de API, token pessoal). O valor vai para o cofre em
   * `mcp/<nome>`; o cadastro ganha o marcador no cabeçalho (http) ou na
   * variável (stdio) indicada. Em `Authorization`, valor sem esquema ganha
   * "Bearer ", que é o que esses servidores esperam.
   */
  async setCredential(name: string, entrada: { campo: string; valor: string }): Promise<McpServerEntry> {
    const row = await this.row(name);
    if (row === undefined) throw new Error(`servidor MCP "${name}" nao cadastrado`);
    const campo = entrada.campo.trim();
    const valor = entrada.valor.trim();
    if (campo === "" || valor === "") throw new Error("informe o campo e o valor da credencial");
    if (!/^[A-Za-z0-9_-]+$/.test(campo)) throw new Error(`"${campo}" não serve de nome de cabeçalho ou variável`);

    const { config } = toEntry(row);
    const ref = `mcp/${name}`;
    const http = config.transport !== "stdio";
    const final = http && campo.toLowerCase() === "authorization" && !/^(bearer|basic|token)\s/i.test(valor) ? `Bearer ${valor}` : valor;
    this.secrets.set(ref, final);
    await this.register(
      http
        ? { ...config, headers: { ...(config.headers ?? {}), [campo]: CREDENTIAL_PLACEHOLDER } }
        : { ...config, env: { ...(config.env ?? {}), [campo]: CREDENTIAL_PLACEHOLDER } },
    );
    await this.setCredentialRef(name, ref);
    return toEntry((await this.row(name))!);
  }

  /** Títulos das iniciativas que usam cada servidor, para a tela dizer quem depende dele. */
  async usage(): Promise<Record<string, string[]>> {
    const linhas = await this.db
      .select({ servidor: schema.initiativeMcpServers.serverName, titulo: schema.initiatives.title })
      .from(schema.initiativeMcpServers)
      .innerJoin(schema.initiatives, eq(schema.initiatives.id, schema.initiativeMcpServers.initiativeId));
    const uso: Record<string, string[]> = {};
    for (const { servidor, titulo } of linhas) (uso[servidor] ??= []).push(titulo);
    return uso;
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const updated = await this.db
      .update(schema.mcpServers)
      .set({ enabled })
      .where(eq(schema.mcpServers.name, name))
      .returning();
    if (updated.length === 0) throw new Error(`servidor MCP "${name}" nao cadastrado`);
  }

  /**
   * Sobe o servidor cadastrado e conta o que ele expoe.
   *
   * Nao lanca quando a conexao falha: falhar e um desfecho normal aqui, e quem
   * administra quer ver o motivo na tela, nao um erro subindo a pilha.
   * Servidor desabilitado tambem e testavel, porque o caminho natural e testar
   * antes de habilitar.
   */
  async testConnection(name: string): Promise<McpConnectionCheck> {
    const started = Date.now();
    try {
      const tools = await this.probe(name, (registry) => registry.describeTools(name));
      // O observador do registro também grava, mas sem esperar; aqui a tela
      // relê o cadastro logo depois e precisa ver o desfecho.
      await this.recordConnection(name, { ok: true });
      return { name, ok: true, elapsedMs: Date.now() - started, toolCount: tools.length };
    } catch (err) {
      await this.recordConnection(name, { ok: false, error: err instanceof Error ? err.message : String(err) });
      return {
        name,
        ok: false,
        elapsedMs: Date.now() - started,
        toolCount: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Guarda o desfecho de uma conexão. Chamado pelo observador do registro, para
   * qualquer conexão do processo; servidor que não está no cadastro é ignorado
   * pelo `where`.
   */
  async recordConnection(name: string, outcome: McpConnectOutcome, at: Date = new Date()): Promise<void> {
    await this.db
      .update(schema.mcpServers)
      .set(
        outcome.ok
          ? { lastOkAt: at }
          : { lastFailureAt: at, lastError: outcome.error.slice(0, TETO_DO_ERRO) },
      )
      .where(eq(schema.mcpServers.name, name));
  }

  /** Catalogo de ferramentas do servidor, para escolher quais marcar num passo. */
  async listTools(name: string): Promise<McpToolInfo[]> {
    return this.probe(name, (registry) => registry.describeTools(name));
  }

  /**
   * Registro descartavel com um servidor so. O registro do executor fica vivo
   * entre execuções, mas conferir cadastro e operacao avulsa: abre, olha e
   * fecha, sem deixar processo para tras.
   */
  private async probe<T>(name: string, fn: (registry: McpRegistry) => Promise<T>): Promise<T> {
    if (!(await this.row(name))) throw new Error(`servidor MCP "${name}" nao cadastrado`);
    await this.refreshAll([{ name }]);
    const row = (await this.row(name))!;

    const registry = McpRegistry.fromList([this.connectable(row)]);
    try {
      return await fn(registry);
    } finally {
      await registry.closeAll();
    }
  }

  /**
   * Renova o que estiver para vencer. Falha de renovação não derruba a
   * conexão: o servidor responde 401 com o token velho, e a tela mostra
   * "reconectar", que é o desfecho certo para refresh token revogado.
   */
  private async refreshAll(rows: { name: string }[]): Promise<void> {
    if (this.refresher === null) return;
    for (const { name } of rows) {
      await this.refresher(name).catch((err: unknown) => {
        console.error(`renovar o token de ${name} falhou: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  /**
   * O cadastro pronto para conectar, com a credencial ja no lugar do marcador.
   *
   * Existe separado do `toEntry` de proposito: o que vai para tela, log ou
   * ferramenta de leitura sai de la, com o marcador intacto, e so o que sobe um
   * processo ou abre uma conexao passa por aqui. Assim nao ha caminho em que um
   * segredo decifrado escape por uma listagem.
   */
  private connectable(row: McpServerRow): McpServerConfig {
    const { config } = toEntry(row);
    const secret = row.credentialRef ? this.secrets.get(row.credentialRef) : undefined;
    return {
      ...config,
      env: fillCredential(config.env, secret, { envFallback: true }),
      headers: fillCredential(config.headers, secret, { envFallback: false }),
    };
  }

  private async row(name: string): Promise<McpServerRow | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.mcpServers)
      .where(eq(schema.mcpServers.name, name));
    return row;
  }
}

/**
 * O banco guarda command, env e headers como JSON solto. A volta passa pelo
 * zod para que linha gravada por uma versao antiga do schema estoure aqui, no
 * cadastro, e nao la na frente na hora de subir o processo.
 */
function toEntry(row: McpServerRow): McpServerEntry {
  return {
    config: McpServerConfig.parse({
      name: row.name,
      transport: row.transport,
      command: row.command ?? undefined,
      env: row.env ?? undefined,
      url: row.url ?? undefined,
      headers: row.headers ?? undefined,
      scope: row.scope,
      idleTimeoutMs: row.idleTimeoutMs,
    }),
    enabled: row.enabled,
    credentialRef: row.credentialRef,
    health: healthOf(row),
  };
}

function healthOf(row: McpServerRow): McpServerHealth {
  const lastOkAt = row.lastOkAt?.getTime() ?? null;
  const lastFailureAt = row.lastFailureAt?.getTime() ?? null;
  const failingNow = lastFailureAt !== null && (lastOkAt === null || lastFailureAt > lastOkAt);
  return {
    lastOkAt,
    lastFailureAt,
    lastError: row.lastError,
    needsAuth: failingNow && row.lastError !== null && isAuthError(row.lastError),
  };
}

export const mcpService = new McpService();

McpRegistry.observe((name, outcome) => {
  void mcpService.recordConnection(name, outcome).catch((err: unknown) => {
    console.error(`guardar a saúde de ${name} falhou: ${err instanceof Error ? err.message : String(err)}`);
  });
});
