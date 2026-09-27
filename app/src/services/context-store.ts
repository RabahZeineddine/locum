import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface ContextWriteOptions {
  /** Recusa a escrita quando o hash atual do arquivo nao bate com este. */
  expectHash?: string;
}

export interface ContextAppendResult {
  hash: string;
  /** false quando o marcador ja estava la e nada mudou. */
  applied: boolean;
}

/**
 * Pasta de contexto de uma iniciativa. So texto, versionado pela pessoa fora
 * do banco: o servico grava e le, mas quem decide o que existe ali e quem
 * edita a mao.
 */
export interface ContextStore {
  read(file: string): Promise<string | null>;
  list(): Promise<string[]>;
  hash(file: string): Promise<string | null>;
  write(file: string, content: string, options?: ContextWriteOptions): Promise<{ hash: string }>;
  append(file: string, block: string, marker: string): Promise<ContextAppendResult>;
}

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function dentroDaRaiz(raiz: string, caminho: string): boolean {
  return caminho === raiz || caminho.startsWith(`${raiz}${sep}`);
}

/**
 * Contexto de uma iniciativa numa pasta local.
 *
 * Caminho fora da pasta nunca e aceito: nem `..`, nem absoluto, nem um link
 * simbolico que resolve para fora. A escrita e atomica, arquivo temporario e
 * `rename`, para uma queda no meio do caminho nunca deixar o `context.md`
 * pela metade.
 */
export class LocalFolderContextStore implements ContextStore {
  private readonly root: string;

  constructor(root: string) {
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
  }

  async read(file: string): Promise<string | null> {
    const caminho = this.resolveSafe(file);
    if (!existsSync(caminho)) return null;
    return readFileSync(caminho, "utf8");
  }

  async list(): Promise<string[]> {
    const arquivos: string[] = [];
    const percorrer = (pasta: string, prefixo: string) => {
      if (!existsSync(pasta)) return;
      for (const entrada of readdirSync(pasta, { withFileTypes: true })) {
        const caminho = join(pasta, entrada.name);
        const relativo = prefixo ? `${prefixo}/${entrada.name}` : entrada.name;
        if (entrada.isDirectory()) percorrer(caminho, relativo);
        else if (entrada.isFile()) arquivos.push(relativo);
      }
    };
    percorrer(this.root, "");
    return arquivos.sort();
  }

  async hash(file: string): Promise<string | null> {
    const conteudo = await this.read(file);
    return conteudo === null ? null : hashOf(conteudo);
  }

  async write(
    file: string,
    content: string,
    options: ContextWriteOptions = {},
  ): Promise<{ hash: string }> {
    const caminho = this.resolveSafe(file);
    if (options.expectHash !== undefined) {
      const atual = existsSync(caminho) ? readFileSync(caminho, "utf8") : null;
      const hashAtual = atual === null ? null : hashOf(atual);
      if (hashAtual !== options.expectHash) {
        throw new Error(`"${file}" mudou desde a leitura: hash esperado nao confere`);
      }
    }
    mkdirSync(dirname(caminho), { recursive: true });
    const temporario = `${caminho}.tmp-${randomUUID()}`;
    writeFileSync(temporario, content, "utf8");
    renameSync(temporario, caminho);
    return { hash: hashOf(content) };
  }

  async append(file: string, block: string, marker: string): Promise<ContextAppendResult> {
    const atual = (await this.read(file)) ?? "";
    if (atual.includes(marker)) return { hash: hashOf(atual), applied: false };

    const proximo = atual.length > 0 ? `${atual}\n${marker}\n${block}\n` : `${marker}\n${block}\n`;
    const resultado = await this.write(file, proximo);
    return { hash: resultado.hash, applied: true };
  }

  /**
   * Recusa `..`, caminho absoluto e link que resolve para fora da pasta.
   *
   * O link e conferido subindo pasta a pasta a partir da raiz: so a parte que
   * ja existe em disco pode ser link, o resto do caminho e so texto ainda.
   */
  private resolveSafe(file: string): string {
    if (isAbsolute(file)) {
      throw new Error(`caminho de contexto nao pode ser absoluto: "${file}"`);
    }
    const segmentos = file.split(/[/\\]+/).filter((parte) => parte.length > 0);
    if (segmentos.length === 0 || segmentos.includes("..") || segmentos.includes(".")) {
      throw new Error(`caminho de contexto invalido: "${file}"`);
    }

    let atual = this.root;
    for (const segmento of segmentos.slice(0, -1)) {
      atual = join(atual, segmento);
      if (existsSync(atual)) {
        const real = realpathSync(atual);
        if (!dentroDaRaiz(this.root, real)) {
          throw new Error(`caminho de contexto sai da pasta por link: "${file}"`);
        }
        atual = real;
      }
    }

    const caminhoFinal = join(atual, segmentos[segmentos.length - 1]!);
    if (existsSync(caminhoFinal)) {
      const real = realpathSync(caminhoFinal);
      if (!dentroDaRaiz(this.root, real)) {
        throw new Error(`caminho de contexto sai da pasta por link: "${file}"`);
      }
    }

    const resolvido = resolve(caminhoFinal);
    if (!dentroDaRaiz(this.root, resolvido)) {
      throw new Error(`caminho de contexto sai da pasta: "${file}"`);
    }
    return resolvido;
  }
}
