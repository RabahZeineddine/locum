import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServerInput } from "../config/types.js";
import { mcpService, type McpService } from "./mcp-service.js";
import { chaveDoClienteOAuth, type PreRegisteredClient } from "./mcp-oauth-service.js";
import { CREDENTIAL_PLACEHOLDER, secretService, type SecretService } from "./secret-service.js";
import { settingsService, type SettingsService } from "./settings-service.js";

/**
 * Traz para o Locum os servidores MCP que o Claude Code da pessoa já usa: os
 * de usuário, em `~/.claude.json`, e os dos plugins ligados. Depois de
 * importado o servidor é do Locum e roda com qualquer modelo, com ou sem
 * Claude na máquina. Os conectores do claude.ai não entram: rodam nos
 * servidores da Anthropic e só se alcançam pela conta (ver `claude-account`).
 */

export interface Candidato {
  name: string;
  /** "usuário" ou o plugin de onde veio, como `akad@akad`. */
  origem: string;
  transport: "stdio" | "http" | "sse";
  /** Resumo para a tela: comando ou endereço, sem segredo. */
  destino: string;
  /** Variável que não se resolveu: o servidor entra, mas sem ela não conecta. */
  faltando: string[];
  /** http sem cabeçalho: a autorização sai pelo OAuth do Locum depois de importar. */
  oauth: boolean;
  jaCadastrado: boolean;
}

/** O que se grava; fica fora do que vai para a tela por carregar segredo. */
interface Preparado extends Candidato {
  config: McpServerInput;
  segredo?: string;
  /** App OAuth que o plugin declara, para autorizar sem registro automático. */
  cliente?: PreRegisteredClient;
}

interface Entrada {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Como o Claude Code declara app OAuth já cadastrado no serviço. */
  oauth?: { clientId?: string; callbackPort?: number; scopes?: string[] | string };
}

export interface ImportDeps {
  home: string;
  /** Variáveis do shell de login, que o app aberto pelo Finder não herda. */
  ambiente: (nomes: string[]) => Promise<Record<string, string>>;
  mcp: Pick<McpService, "list" | "register" | "setEnabled" | "setCredentialRef">;
  secrets: Pick<SecretService, "set">;
  settings: Pick<SettingsService, "set">;
}

const NOME_DE_SEGREDO = /key|token|secret|password|passwd|auth|bearer|cookie/i;
const VARIAVEL = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

function lerJson(caminho: string): unknown {
  try {
    return JSON.parse(readFileSync(caminho, "utf8"));
  } catch {
    return undefined;
  }
}

function comoObjeto(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Servidores declarados pelos plugins ligados, com a pasta de cada plugin. */
export function servidoresDosPlugins(home: string): { origem: string; raiz: string; servidores: Record<string, Entrada> }[] {
  const ajustes = comoObjeto(lerJson(join(home, ".claude", "settings.json")));
  const ligados = comoObjeto(ajustes.enabledPlugins);
  const instalados = comoObjeto(comoObjeto(lerJson(join(home, ".claude", "plugins", "installed_plugins.json"))).plugins);

  const saida: { origem: string; raiz: string; servidores: Record<string, Entrada> }[] = [];
  for (const [origem, registro] of Object.entries(instalados)) {
    if (ligados[origem] !== true) continue;
    const primeiro = comoObjeto(Array.isArray(registro) ? registro[0] : registro);
    const raiz = typeof primeiro.installPath === "string" ? primeiro.installPath : undefined;
    if (raiz === undefined || !existsSync(raiz)) continue;

    const manifesto = comoObjeto(lerJson(join(raiz, ".claude-plugin", "plugin.json")));
    let declarado: unknown = manifesto.mcpServers;
    if (typeof declarado === "string") declarado = lerJson(join(raiz, declarado));
    if (declarado === undefined) declarado = lerJson(join(raiz, ".mcp.json"));
    const objeto = comoObjeto(declarado);
    const servidores = comoObjeto(objeto.mcpServers ?? objeto) as Record<string, Entrada>;
    if (Object.keys(servidores).length > 0) saida.push({ origem, raiz, servidores });
  }
  return saida;
}

/** Nomes de variável citados num servidor, fora o `CLAUDE_PLUGIN_ROOT`. */
export function variaveisCitadas(entrada: Entrada): string[] {
  const textos = [entrada.command ?? "", entrada.url ?? "", ...(entrada.args ?? []), ...Object.values(entrada.env ?? {}), ...Object.values(entrada.headers ?? {})];
  const nomes = new Set<string>();
  for (const texto of textos) for (const m of texto.matchAll(VARIAVEL)) if (m[1] !== "CLAUDE_PLUGIN_ROOT") nomes.add(m[1]!);
  return [...nomes];
}

/**
 * Monta o cadastro do Locum a partir do que o Claude Code declara.
 *
 * Valor com cara de segredo, em `env` ou `headers`, vai para o cofre: o
 * cadastro fica com `${credential}` no lugar. O Locum guarda uma credencial
 * por servidor, então o segundo segredo do mesmo servidor fica como faltando.
 */
export function preparar(
  name: string,
  origem: string,
  entrada: Entrada,
  raiz: string | undefined,
  ambiente: Record<string, string>,
  cadastrados: ReadonlySet<string>,
): Preparado {
  const faltando = new Set<string>();
  const expandir = (texto: string): string =>
    texto.replace(VARIAVEL, (inteiro, nome: string, padrao: string | undefined) => {
      if (nome === "CLAUDE_PLUGIN_ROOT" && raiz !== undefined) return raiz;
      const valor = ambiente[nome] ?? padrao;
      if (valor === undefined) {
        faltando.add(nome);
        return inteiro;
      }
      return valor;
    });

  let segredo: string | undefined;
  const separar = (registro: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (registro === undefined) return undefined;
    const out: Record<string, string> = {};
    for (const [chave, bruto] of Object.entries(registro)) {
      const valor = expandir(bruto);
      if (!NOME_DE_SEGREDO.test(chave) || valor.length === 0 || valor.includes("${")) {
        out[chave] = valor;
      } else if (segredo === undefined) {
        segredo = valor;
        out[chave] = CREDENTIAL_PLACEHOLDER;
      } else {
        faltando.add(chave);
      }
    }
    return out;
  };

  const transport = entrada.type === "http" || entrada.type === "sse" ? entrada.type : entrada.url !== undefined ? "http" : "stdio";
  const env = separar(entrada.env);
  const headers = separar(entrada.headers);
  const config: McpServerInput =
    transport === "stdio"
      ? { name, transport, command: [expandir(entrada.command ?? ""), ...(entrada.args ?? []).map(expandir)], ...(env ? { env } : {}), scope: "write" }
      : { name, transport, url: expandir(entrada.url ?? ""), ...(headers ? { headers } : {}), scope: "write" };

  const declarado = entrada.oauth;
  const cliente: PreRegisteredClient | undefined =
    transport !== "stdio" && typeof declarado?.clientId === "string" && typeof declarado.callbackPort === "number"
      ? {
          clientId: declarado.clientId,
          redirectUri: `http://localhost:${declarado.callbackPort}/callback`,
          ...(declarado.scopes === undefined
            ? {}
            : { scope: Array.isArray(declarado.scopes) ? declarado.scopes.join(" ") : declarado.scopes }),
        }
      : undefined;

  return {
    name,
    origem,
    transport,
    destino: transport === "stdio" ? (config.command ?? []).join(" ").replace(raiz ?? "\u0000", "<plugin>") : (config.url ?? ""),
    faltando: [...faltando],
    oauth: transport !== "stdio" && Object.keys(entrada.headers ?? {}).length === 0,
    jaCadastrado: cadastrados.has(name),
    config,
    ...(segredo === undefined ? {} : { segredo }),
    ...(cliente === undefined ? {} : { cliente }),
  };
}

function shellDeLogin(nomes: string[]): Promise<Record<string, string>> {
  if (nomes.length === 0) return Promise.resolve({});
  const marca = "__LOCUM_ENV__";
  const script = nomes.map((n) => `printf '${marca}%s=%s\\n' ${n} "$${n}"`).join("; ");
  return new Promise((resolve) => {
    const filho = execFile("/bin/zsh", ["-ilc", script], { timeout: 5_000, encoding: "utf8" }, (erro, stdout) => {
      const out: Record<string, string> = {};
      if (!erro) {
        for (const linha of stdout.split("\n")) {
          if (!linha.startsWith(marca)) continue;
          const [nome, ...resto] = linha.slice(marca.length).split("=");
          const valor = resto.join("=");
          if (nome && valor.length > 0) out[nome] = valor;
        }
      }
      resolve(out);
    });
    filho.stdin?.end();
  });
}

export class ClaudeImportService {
  constructor(
    private deps: ImportDeps = {
      home: homedir(),
      ambiente: shellDeLogin,
      mcp: mcpService,
      secrets: secretService,
      settings: settingsService,
    },
  ) {}

  private async preparados(): Promise<Preparado[]> {
    const cadastrados = new Set((await this.deps.mcp.list()).map((s) => s.config.name));
    const doUsuario = comoObjeto(comoObjeto(lerJson(join(this.deps.home, ".claude.json"))).mcpServers) as Record<string, Entrada>;
    const fontes = [
      { origem: "usuário", raiz: undefined as string | undefined, servidores: doUsuario },
      ...servidoresDosPlugins(this.deps.home),
    ];

    const nomes = new Set<string>();
    for (const f of fontes) for (const e of Object.values(f.servidores)) for (const n of variaveisCitadas(e)) nomes.add(n);
    const doShell = await this.deps.ambiente([...nomes].filter((n) => process.env[n] === undefined));
    const ambiente = { ...doShell, ...Object.fromEntries(Object.entries(process.env).filter((p): p is [string, string] => p[1] !== undefined)) };

    const saida: Preparado[] = [];
    for (const f of fontes) {
      for (const [nome, entrada] of Object.entries(f.servidores)) {
        // O próprio Locum, que a pessoa registrou no Claude Code, não se importa.
        if (nome === "locum" || (entrada.command ?? "").includes("Locum")) continue;
        if (saida.some((p) => p.name === nome)) continue;
        saida.push(preparar(nome, f.origem, entrada, f.raiz, ambiente, cadastrados));
      }
    }
    return saida;
  }

  /**
   * De onde vem cada servidor que o Claude Code declara, pelo nome: "usuário"
   * ou o plugin. Só lê os arquivos, sem shell nem segredo, para a tela agrupar
   * o que já foi importado.
   */
  async origens(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const doUsuario = comoObjeto(comoObjeto(lerJson(join(this.deps.home, ".claude.json"))).mcpServers);
    for (const nome of Object.keys(doUsuario)) out[nome] ??= "usuário";
    for (const f of servidoresDosPlugins(this.deps.home)) for (const nome of Object.keys(f.servidores)) out[nome] ??= f.origem;
    return out;
  }

  /** O que dá para importar, sem segredo nem cadastro completo. */
  async listar(): Promise<Candidato[]> {
    return (await this.preparados()).map(({ config: _c, segredo: _s, cliente: _k, ...candidato }) => candidato);
  }

  /**
   * Cadastra os escolhidos, desligados: ligar é da pessoa, como em todo
   * servidor que não nasce pela tela. Reimportar um já cadastrado atualiza o
   * caminho, que no plugin muda a cada versão.
   */
  async importar(nomes: string[]): Promise<{ importados: string[] }> {
    const escolhidos = (await this.preparados()).filter((p) => nomes.includes(p.name));
    for (const p of escolhidos) {
      await this.deps.mcp.register(p.config);
      if (!p.jaCadastrado) await this.deps.mcp.setEnabled(p.name, false);
      if (p.cliente !== undefined) await this.deps.settings.set(chaveDoClienteOAuth(p.name), JSON.stringify(p.cliente));
      if (p.segredo !== undefined) {
        const ref = `mcp/${p.name}`;
        this.deps.secrets.set(ref, p.segredo);
        await this.deps.mcp.setCredentialRef(p.name, ref);
      }
    }
    return { importados: escolhidos.map((p) => p.name) };
  }
}

export const claudeImportService = new ClaudeImportService();
