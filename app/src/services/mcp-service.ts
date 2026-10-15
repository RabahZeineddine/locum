import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db as defaultDb, schema } from "../db/index.js";
import { isAuthError, McpRegistry, type McpConnectOutcome, type McpToolInfo } from "../mcp/registry.js";
import { McpServerConfig, McpSource, type McpServerInput } from "../config/types.js";
import {
  configMascarada,
  diferencas,
  homeDasFerramentas,
  impressao,
  NOME_DE_SEGREDO,
  OrigemResolver,
  rotuloDaOrigem,
  shellDeLogin,
  type Mudanca,
  type Resolvido,
} from "./mcp-origem.js";
import { CREDENTIAL_PLACEHOLDER, fillCredential, secretService, type SecretService } from "./secret-service.js";

/**
 * A margem para o que vai a um passo de Claude Code ou Codex. Eles recebem o
 * header pronto no arquivo de configuração e não renovam sozinhos, e o passo
 * dura até 15 min: com a margem curta, o token vencia no meio dele.
 */
export const RUN_REFRESH_MARGIN_MS = 16 * 60_000;

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
  /**
   * Cadastro manual: o que o Locum guarda. Vinculado: a última configuração
   * aceita, que vale enquanto a origem muda sem aceite ou some. A efetiva, a
   * que conecta, sai de `vinculos()`.
   */
  config: McpServerConfig;
  /** De onde a configuração vem; nulo é cadastro manual. */
  source: McpSource | null;
  enabled: boolean;
  credentialRef: string | null;
  health: McpServerHealth;
}

/**
 * O que se sabe da origem de um servidor vinculado, para a tela e para a
 * ferramenta de leitura. `mudou` é uma mudança sensível que espera aceite, e
 * até lá vale a anterior; `sumiu` é origem que não tem mais o servidor (plugin
 * desligado ou removido, arquivo apagado), e vale a última aceita.
 */
export interface McpVinculo {
  source: McpSource;
  /** Como a tela chama a origem: `akad@akad`, `usuário`, `Cursor`. */
  rotulo: string;
  /** O arquivo onde editar, quando se sabe qual é. */
  arquivo: string | null;
  estado: "ok" | "mudou" | "sumiu";
  /** Mudança sensível que a pessoa decidiu não aceitar; fica quieta até a origem mudar de novo. */
  mantida: boolean;
  mudancas: Mudanca[];
  /** O que de fato conecta agora, com o segredo mascarado. */
  efetivo: McpServerInput;
  /** Variável que a origem cita e esta máquina não tem. */
  faltando: string[];
}

interface Decisao {
  source: McpSource;
  estado: McpVinculo["estado"];
  /** A configuração a usar, sem o segredo no lugar do marcador. */
  config: McpServerConfig;
  resolvido: Resolvido | undefined;
  mudancas: Mudanca[];
  mantida: boolean;
}

/** Onde fica a última lista de ferramentas de cada servidor. */
const chaveDasFerramentas = (nome: string): string => `mcp.ferramentas.${nome}`;

/** Teto do erro guardado: o bastante para a tela, sem guardar página de HTML. */
const TETO_DO_ERRO = 500;

/**
 * Cadastro de servidores MCP. Linha de comando, servidor MCP proprio e
 * interface passam por aqui, porque a validacao de transporte e a regra de
 * quem entra no executor precisam valer para os tres.
 */
export class McpService {
  private refresher: ((name: string, margemMs?: number) => Promise<void>) | null = null;

  constructor(
    private readonly db: Db = defaultDb,
    private readonly secrets: SecretService = secretService,
    private readonly origem: OrigemResolver = new OrigemResolver({
      get home() {
        return homeDasFerramentas();
      },
      ambiente: shellDeLogin,
    }),
  ) {}

  /**
   * Quem renova token antes de conectar. Fica injetado, e não importado, porque
   * a renovação de OAuth depende deste serviço para gravar a credencial.
   */
  useRefresher(refresher: (name: string, margemMs?: number) => Promise<void>): void {
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
    // Daqui sai o que o executor entrega ao passo, que pode durar 15 min com
    // o mesmo header: renova com folga para o passo inteiro.
    await this.refreshAll(rows, RUN_REFRESH_MARGIN_MS);
    const atuais = await this.db
      .select()
      .from(schema.mcpServers)
      .where(eq(schema.mcpServers.enabled, true));
    return Promise.all(atuais.map((row) => this.connectable(row)));
  }

  /**
   * Cadastra ou atualiza pelo nome, que e a chave que o passo referencia.
   *
   * A credencial vinculada foi entregue para um destino. Se a atualizacao muda
   * o destino (transporte, endereco ou comando), o vinculo cai, e quem mudou
   * conecta de novo: senao bastaria regravar o nome com outra URL e o mesmo
   * marcador para o token sair para um servidor que ninguem autorizou.
   *
   * Servidor vinculado a uma origem não aceita outro comando, endereço, env ou
   * cabeçalho por aqui: isso se edita na origem, ou se desvincula. O que é do
   * Locum (escopo, tempo ocioso, o marcador da credencial) continua valendo.
   * `vinculo` é a importação, que escolhe a origem de propósito.
   */
  async register(config: McpServerInput, vinculo?: { source: McpSource; hash: string }): Promise<McpServerEntry> {
    const parsed = McpServerConfig.parse(config);
    const anterior = await this.row(parsed.name);
    if (vinculo === undefined && anterior?.source != null) {
      const source = McpSource.parse(anterior.source);
      if (mudaOQueEDaOrigem(toEntry(anterior).config, parsed)) {
        throw new Error(
          `servidor MCP "${parsed.name}" está vinculado a ${rotuloDaOrigem(source)}: edite na origem` +
            `${this.origem.arquivoDe(source) === undefined ? "" : ` (${this.origem.arquivoDe(source)})`} ou desvincule antes`,
        );
      }
    }
    return this.salvar(parsed, anterior, vinculo === undefined ? {} : { source: vinculo.source, sourceHash: vinculo.hash, sourceKeptHash: null });
  }

  private async salvar(
    parsed: McpServerConfig,
    anterior: McpServerRow | undefined,
    origem: { source?: McpSource | null; sourceHash?: string | null; sourceKeptHash?: string | null },
  ): Promise<McpServerEntry> {
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
      ...origem,
    };

    await this.db
      .insert(schema.mcpServers)
      .values({ id: randomUUID(), ...values })
      .onConflictDoUpdate({ target: schema.mcpServers.name, set: values });

    return toEntry((await this.row(parsed.name))!);
  }

  /**
   * Liga a uma origem um servidor que já estava cadastrado como cópia, para a
   * migração. A cópia vira a configuração aceita: o que a origem tem hoje de
   * diferente passa pelo aceite.
   */
  async vincular(name: string, source: McpSource): Promise<void> {
    const row = await this.row(name);
    if (row === undefined) throw new Error(`servidor MCP "${name}" nao cadastrado`);
    await this.db
      .update(schema.mcpServers)
      .set({ source, sourceHash: impressao(toEntry(row).config, source), sourceKeptHash: null })
      .where(eq(schema.mcpServers.name, name));
  }

  /** Estado de cada servidor vinculado: se a origem bate com o aceito, mudou ou sumiu. */
  async vinculos(): Promise<Record<string, McpVinculo>> {
    // Quem pergunta pelo estado quer o de agora, e não o de até 5 s atrás.
    this.origem.esquecer();
    const rows = (await this.db.select().from(schema.mcpServers)).filter((r) => r.source != null);
    const saida: Record<string, McpVinculo> = {};
    await Promise.all(
      rows.map(async (row) => {
        const d = await this.decidir(row);
        if (d === null) return;
        saida[row.name] = {
          source: d.source,
          rotulo: rotuloDaOrigem(d.source),
          arquivo: d.resolvido?.arquivo ?? this.origem.arquivoDe(d.source) ?? null,
          estado: d.estado,
          mantida: d.mantida,
          mudancas: d.mudancas,
          efetivo: configMascarada(d.config),
          faltando: d.resolvido?.faltando ?? [],
        };
      }),
    );
    return saida;
  }

  /** A pessoa aceita a mudança da origem: ela passa a ser a configuração aceita. */
  async aceitarOrigem(name: string): Promise<McpServerEntry> {
    this.origem.esquecer();
    const row = await this.row(name);
    const d = row === undefined ? null : await this.decidir(row);
    if (row === undefined || d === null) throw new Error(`servidor MCP "${name}" nao esta vinculado`);
    if (d.resolvido === undefined) throw new Error(`a origem de "${name}" nao tem mais o servidor`);
    const config = this.daOrigem(d.resolvido, toEntry(row).config, row);
    const entry = await this.salvar(config, row, { sourceHash: d.resolvido.hash, sourceKeptHash: null });
    // O segredo que a origem traz literal vai para o cofre, como na importação.
    if (d.resolvido.segredo !== undefined) {
      const ref = `mcp/${name}`;
      this.secrets.set(ref, d.resolvido.segredo);
      await this.setCredentialRef(name, ref);
    }
    return toEntry((await this.row(name))!);
  }

  /** Mantém a configuração anterior: a mudança sai do aviso, e volta se a origem mudar de novo. */
  async manterAnterior(name: string): Promise<void> {
    this.origem.esquecer();
    const row = await this.row(name);
    const d = row === undefined ? null : await this.decidir(row);
    if (d?.resolvido === undefined) throw new Error(`servidor MCP "${name}" nao tem mudanca da origem para manter`);
    await this.db.update(schema.mcpServers).set({ sourceKeptHash: d.resolvido.hash }).where(eq(schema.mcpServers.name, name));
  }

  /**
   * Corta o vínculo: o servidor vira cadastro manual, com a configuração que
   * valia agora como cópia editável. É decisão de quem desvincula, e não há
   * volta automática: importar de novo é o caminho para vincular outra vez.
   */
  async desvincular(name: string): Promise<McpServerEntry> {
    this.origem.esquecer();
    const row = await this.row(name);
    const d = row === undefined ? null : await this.decidir(row);
    if (row === undefined || d === null) throw new Error(`servidor MCP "${name}" nao esta vinculado`);
    const entry = await this.salvar(d.config, row, { source: null, sourceHash: null, sourceKeptHash: null });
    if (d.estado === "ok" && d.resolvido?.segredo !== undefined) {
      const ref = `mcp/${name}`;
      this.secrets.set(ref, d.resolvido.segredo);
      await this.setCredentialRef(name, ref);
    }
    return entry;
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
      await this.guardarFerramentas(name, tools);
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

  /**
   * Catalogo de ferramentas do servidor, para escolher quais marcar num passo.
   * Cada leitura boa fica guardada, e a tela mostra a guardada enquanto esta
   * sobe o servidor de novo: listar o ms365 leva segundos, e escolher
   * ferramenta não devia esperar isso toda vez.
   */
  async listTools(name: string): Promise<McpToolInfo[]> {
    const tools = await this.probe(name, (registry) => registry.describeTools(name));
    await this.guardarFerramentas(name, tools);
    return tools;
  }

  /** A última lista boa de ferramentas, sem subir o servidor. Nula quando nunca listou. */
  async cachedTools(name: string): Promise<{ at: number; tools: McpToolInfo[] } | null> {
    const [row] = await this.db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, chaveDasFerramentas(name)));
    if (row === undefined) return null;
    try {
      return JSON.parse(row.value) as { at: number; tools: McpToolInfo[] };
    } catch {
      return null;
    }
  }

  private async guardarFerramentas(name: string, tools: McpToolInfo[]): Promise<void> {
    const value = JSON.stringify({ at: Date.now(), tools });
    await this.db
      .insert(schema.settings)
      .values({ key: chaveDasFerramentas(name), value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value } });
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

    const registry = McpRegistry.fromList([await this.connectable(row)]);
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
  private async refreshAll(rows: { name: string }[], margemMs?: number): Promise<void> {
    if (this.refresher === null) return;
    for (const { name } of rows) {
      await this.refresher(name, margemMs).catch((err: unknown) => {
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
   *
   * Servidor vinculado conecta com a configuração da origem, lida agora, e não
   * com a cópia que ficou no banco.
   */
  private async connectable(row: McpServerRow): Promise<McpServerConfig> {
    const d = await this.decidir(row);
    const config = d === null ? toEntry(row).config : d.config;
    // O segredo que a origem traz literal vale enquanto a origem é a aceita; o
    // do cofre, nos outros casos e no OAuth.
    const doCofre = row.credentialRef ? this.secrets.get(row.credentialRef) : undefined;
    const secret = (d?.estado === "ok" ? d.resolvido?.segredo : undefined) ?? doCofre;
    return {
      ...config,
      env: fillCredential(config.env, secret, { envFallback: true }),
      headers: fillCredential(config.headers, secret, { envFallback: false }),
    };
  }

  /**
   * Decide qual configuração vale para um servidor vinculado. Origem igual à
   * aceita (a versão do plugin não conta) vale a da origem, e a cópia do banco
   * acompanha; origem mudada espera aceite e vale a anterior; origem que sumiu
   * vale a última aceita. `null` para cadastro manual.
   */
  private async decidir(row: McpServerRow): Promise<Decisao | null> {
    if (row.source == null) return null;
    const lida = McpSource.safeParse(row.source);
    if (!lida.success) return null;
    const source = lida.data;
    const aceita = toEntry(row).config;
    const r = await this.origem.resolver(source, row.name);
    if (r === undefined) return { source, estado: "sumiu", config: aceita, resolvido: undefined, mudancas: [], mantida: false };

    if (r.hash === row.sourceHash) {
      const nova = McpServerConfig.safeParse({ ...this.daOrigem(r, aceita, row), name: row.name, scope: row.scope, idleTimeoutMs: row.idleTimeoutMs });
      if (!nova.success) return { source, estado: "sumiu", config: aceita, resolvido: r, mudancas: [], mantida: false };
      if (JSON.stringify(configDeCopia(nova.data)) !== JSON.stringify(configDeCopia(aceita))) {
        // Só o caminho da versão mudou: a cópia aceita acompanha, e continua
        // servindo se a origem sumir depois.
        await this.db
          .update(schema.mcpServers)
          .set({ command: nova.data.command ?? null, env: nova.data.env ?? null, url: nova.data.url ?? null, headers: nova.data.headers ?? null })
          .where(eq(schema.mcpServers.name, row.name));
      }
      return { source, estado: "ok", config: nova.data, resolvido: r, mudancas: [], mantida: false };
    }
    return {
      source,
      estado: "mudou",
      config: aceita,
      resolvido: r,
      mudancas: diferencas(aceita, r.config, source, r.raiz),
      mantida: row.sourceKeptHash === r.hash,
    };
  }

  /**
   * A configuração da origem como cadastro do Locum. O marcador de credencial
   * que o Locum pôs (o OAuth, por exemplo) segue valendo, e uma chave de segredo
   * que a origem cita por variável e esta máquina não tem cai no marcador da
   * cópia aceita, que o cofre preenche.
   */
  private daOrigem(r: Resolvido, aceita: McpServerConfig, row: McpServerRow): McpServerConfig {
    const mapa = (nova: Record<string, string> | undefined, antes: Record<string, string> | undefined) => {
      const saida: Record<string, string> = { ...(nova ?? {}) };
      for (const [k, v] of Object.entries(saida)) {
        if (NOME_DE_SEGREDO.test(k) && v.includes("${") && antes?.[k] === CREDENTIAL_PLACEHOLDER) saida[k] = CREDENTIAL_PLACEHOLDER;
      }
      for (const [k, v] of Object.entries(antes ?? {})) if (v === CREDENTIAL_PLACEHOLDER && saida[k] === undefined) saida[k] = v;
      return Object.keys(saida).length === 0 ? undefined : saida;
    };
    const env = mapa(r.config.env, aceita.env);
    const headers = mapa(r.config.headers, aceita.headers);
    return McpServerConfig.parse({
      ...r.config,
      name: row.name,
      scope: row.scope,
      idleTimeoutMs: row.idleTimeoutMs,
      env,
      headers,
    });
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
    source: row.source == null ? null : (McpSource.safeParse(row.source).data ?? null),
    enabled: row.enabled,
    credentialRef: row.credentialRef,
    health: healthOf(row),
  };
}

/** O que a cópia guarda de uma configuração, para saber se ela precisa acompanhar a origem. */
function configDeCopia(c: McpServerConfig): unknown {
  return [c.transport, c.command ?? null, c.env ?? null, c.url ?? null, c.headers ?? null];
}

/**
 * Se `depois` muda algo que pertence à origem: transporte, comando, endereço,
 * variável ou cabeçalho. O marcador da credencial é do Locum e fica de fora.
 */
function mudaOQueEDaOrigem(antes: McpServerConfig, depois: McpServerConfig): boolean {
  const proprios = (r: Record<string, string> | undefined) =>
    Object.entries(r ?? {})
      .filter(([, v]) => v !== CREDENTIAL_PLACEHOLDER)
      .sort(([a], [b]) => a.localeCompare(b));
  return (
    JSON.stringify([antes.transport, antes.command ?? null, antes.url ?? null, proprios(antes.env), proprios(antes.headers)]) !==
    JSON.stringify([depois.transport, depois.command ?? null, depois.url ?? null, proprios(depois.env), proprios(depois.headers)])
  );
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
