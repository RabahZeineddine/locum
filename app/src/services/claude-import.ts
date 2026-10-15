import { basename } from "node:path";
import { SERVIDOR_NATIVO, type McpSource } from "../config/types.js";
import {
  clienteDeclarado,
  fontes,
  homeDasFerramentas,
  impressao,
  origemEstruturada,
  preparar,
  shellDeLogin,
  variaveisCitadas,
  type Candidato,
  type Entrada,
  type Preparado,
} from "./mcp-origem.js";
import { mcpService, type McpService } from "./mcp-service.js";
import { chaveDoClienteOAuth, type PreRegisteredClient } from "./mcp-oauth-service.js";
import { secretService, type SecretService } from "./secret-service.js";
import { settingsService, type SettingsService } from "./settings-service.js";

/**
 * Traz para o Locum os servidores MCP que a pessoa já configurou nas
 * ferramentas desta máquina: o Claude Code (os de usuário, em `~/.claude.json`,
 * e os dos plugins ligados), o opencode, o Cursor, o VS Code e o Claude
 * Desktop. A leitura de cada formato mora em `mcp-origem`.
 *
 * O servidor importado fica vinculado à origem: o Locum guarda de onde ele
 * veio, e não uma cópia do comando. Comando, args, env e url se leem da origem
 * na hora do uso; o que é do Locum (ligado, credencial, escopo) fica no Locum.
 * Os conectores do claude.ai não entram: rodam nos servidores da Anthropic e só
 * se alcançam pela conta (ver `claude-account`).
 */

export {
  clienteDeclarado,
  fontes,
  ORIGENS,
  preparar,
  servidoresDoOpencode,
  servidoresDosPlugins,
  servidoresDoVscode,
  variaveisCitadas,
  variavelDoClaude,
  type Candidato,
} from "./mcp-origem.js";

export interface ImportDeps {
  home: string;
  /** Variáveis do shell de login, que o app aberto pelo Finder não herda. */
  ambiente: (nomes: string[]) => Promise<Record<string, string>>;
  mcp: Pick<McpService, "list" | "register" | "setEnabled" | "setCredentialRef" | "vincular">;
  secrets: Pick<SecretService, "set">;
  settings: Pick<SettingsService, "set" | "get">;
}

/** Ponto de partida da migração, para ela rodar uma vez só. */
const CHAVE_DA_MIGRACAO = "mcp.vinculo.migrado";

/** O host de uma URL, para dizer se um cadastro antigo e a origem falam do mesmo servidor. */
function hostDe(url: string | undefined): string | null {
  try {
    return url === undefined ? null : new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Um cadastro sem origem guardada e uma declaração da origem são o mesmo
 * servidor? O nome igual não basta: o cadastro pode ser de outra pessoa, ou de
 * mão. Vale o mesmo transporte e o mesmo programa (stdio) ou o mesmo host
 * (rede). Comando e args podem ter mudado desde a importação, e é isso que o
 * aceite existe para mostrar.
 */
export function pareceOMesmoServidor(
  cadastro: { transport: string; command?: string[]; url?: string },
  entrada: Entrada,
): boolean {
  const transport = entrada.type === "http" || entrada.type === "sse" ? entrada.type : entrada.url !== undefined ? "http" : "stdio";
  if ((cadastro.transport === "stdio") !== (transport === "stdio")) return false;
  if (transport === "stdio") {
    return basename(cadastro.command?.[0] ?? "\u0000") === basename(entrada.command ?? "\u0001");
  }
  const a = hostDe(cadastro.url);
  return a !== null && a === hostDe(entrada.url?.replace(/\$\{[^}]*\}/g, "x"));
}

export class ClaudeImportService {
  constructor(
    private deps: ImportDeps = {
      get home() {
        return homeDasFerramentas();
      },
      ambiente: shellDeLogin,
      mcp: mcpService,
      secrets: secretService,
      settings: settingsService,
    },
  ) {}

  private async preparados(): Promise<(Preparado & { source: McpSource; hash: string })[]> {
    const cadastrados = new Set((await this.deps.mcp.list()).map((s) => s.config.name));
    const lidas = fontes(this.deps.home);

    const nomes = new Set<string>();
    for (const f of lidas) for (const e of Object.values(f.servidores)) for (const n of variaveisCitadas(e)) nomes.add(n);
    const doShell = await this.deps.ambiente([...nomes].filter((n) => process.env[n] === undefined));
    const ambiente = { ...doShell, ...Object.fromEntries(Object.entries(process.env).filter((p): p is [string, string] => p[1] !== undefined)) };

    const saida: (Preparado & { source: McpSource; hash: string })[] = [];
    for (const f of lidas) {
      for (const [nome, entrada] of Object.entries(f.servidores)) {
        // O próprio Locum, que a pessoa registrou na ferramenta, não se importa.
        if (nome === "locum" || (entrada.command ?? "").includes("Locum")) continue;
        if (saida.some((p) => p.name === nome)) continue;
        const source = origemEstruturada(f, nome);
        const p = preparar(nome, f.origem, entrada, f.raiz, ambiente, cadastrados);
        saida.push({ ...p, source, hash: impressao(p.config, source, f.raiz) });
      }
    }
    return saida;
  }

  /**
   * De onde vem cada servidor declarado nas ferramentas, pelo nome: "usuário",
   * o plugin ou a ferramenta. Só lê os arquivos, sem shell nem segredo, para a
   * tela agrupar o que já foi importado.
   */
  async origens(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const f of fontes(this.deps.home)) for (const nome of Object.keys(f.servidores)) out[nome] ??= f.origem;
    return out;
  }

  /**
   * O app OAuth que o Claude Code declara para um servidor com este nome. Serve
   * a quem importou antes de a importação guardar o app: autorizar consulta
   * aqui em vez de exigir importar de novo.
   */
  async clienteOAuth(nome: string): Promise<PreRegisteredClient | undefined> {
    const entrada = fontes(this.deps.home).find((f) => nome in f.servidores)?.servidores[nome];
    return entrada === undefined ? undefined : clienteDeclarado(entrada);
  }

  /** O que dá para importar, sem segredo nem cadastro completo. */
  async listar(): Promise<Candidato[]> {
    return (await this.preparados()).map(({ config: _c, segredo: _s, cliente: _k, source: _o, hash: _h, ...candidato }) => candidato);
  }

  /**
   * Cadastra os escolhidos, vinculados à origem e desligados: ligar é da
   * pessoa, como em todo servidor que não nasce pela tela. Reimportar um já
   * cadastrado vincula de novo e aceita a configuração que a origem tem agora.
   */
  async importar(nomes: string[]): Promise<{ importados: string[] }> {
    const escolhidos = (await this.preparados()).filter((p) => nomes.includes(p.name));
    for (const p of escolhidos) {
      await this.deps.mcp.register(p.config, { source: p.source, hash: p.hash });
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

  /**
   * Migração, na subida: os servidores importados antes do vínculo eram cópia.
   * Os que a origem ainda declara pelo nome (e que parecem o mesmo servidor)
   * passam a vinculados, com a cópia como configuração aceita: se a origem hoje
   * diz outra coisa, a conexão mostra "a origem mudou" e espera o aceite. Sem
   * origem encontrada, ficam como cadastro manual. Roda uma vez, para não
   * religar o que a pessoa desvinculou de propósito.
   */
  async revincular(): Promise<{ vinculados: string[]; manuais: string[] }> {
    const feita = await this.deps.settings.get(CHAVE_DA_MIGRACAO);
    if (feita !== undefined) return { vinculados: [], manuais: [] };

    const lidas = fontes(this.deps.home);
    const vinculados: string[] = [];
    const manuais: string[] = [];
    for (const servidor of await this.deps.mcp.list()) {
      const nome = servidor.config.name;
      if (servidor.source !== null || nome === SERVIDOR_NATIVO || nome === "locum") continue;
      let achado: { fonte: (typeof lidas)[number]; entrada: Entrada } | undefined;
      for (const fonte of lidas) {
        const entrada = fonte.servidores[nome];
        if (entrada !== undefined && pareceOMesmoServidor(servidor.config, entrada)) {
          achado = { fonte, entrada };
          break;
        }
      }
      if (achado === undefined) {
        manuais.push(nome);
        continue;
      }
      await this.deps.mcp.vincular(nome, origemEstruturada(achado.fonte, nome));
      vinculados.push(nome);
    }
    await this.deps.settings.set(CHAVE_DA_MIGRACAO, new Date().toISOString());
    return { vinculados, manuais };
  }
}

export const claudeImportService = new ClaudeImportService();
