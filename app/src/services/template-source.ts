import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** `fetch` mínimo, para o teste injetar um falso. */
export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

export interface TemplateBruto {
  id: string;
  name: string;
  steps?: unknown[];
  [chave: string]: unknown;
}

export interface TemplateResumo {
  id: string;
  name: string;
  modelo: string | null;
  passos: number;
  passosDeModelo: { indice: number; modelo: string }[];
}

export const URL_LISTAGEM_TEMPLATES =
  "https://api.github.com/repos/RabahZeineddine/locum/contents/examples/agents?ref=main";
const PRAZO_MS = 5000;
const ID_VALIDO = /^[a-z0-9][a-z0-9-]{1,62}$/;

interface Opcoes {
  fetch?: FetchLike;
  /** Cópia empacotada: `examples/agents` em dev, `dist/agents` empacotado. */
  pastaLocal: string;
  prazoMs?: number;
}

/**
 * De onde vêm os templates do marketplace: o repositório remoto (branch
 * `main`) primeiro, a cópia empacotada se o remoto falhar. Listar e instalar
 * passam pelo mesmo caminho, então um id listado sempre tem o que instalar.
 */
export class TemplateSource {
  private readonly buscar: FetchLike;
  private readonly pastaLocal: string;
  private readonly prazoMs: number;

  constructor(opcoes: Opcoes) {
    this.buscar = opcoes.fetch ?? ((url, init) => fetch(url, init));
    this.pastaLocal = opcoes.pastaLocal;
    this.prazoMs = opcoes.prazoMs ?? PRAZO_MS;
  }

  async listar(): Promise<TemplateResumo[]> {
    const brutos = (await this.doRemoto()) ?? (await this.doLocal());
    return brutos.map(resumir).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** O spec cru do template; a validação de verdade é a do importar. */
  async ler(id: string): Promise<TemplateBruto> {
    if (!ID_VALIDO.test(id)) throw new Error(`id de template inválido: "${id}"`);
    const achado = (await this.doRemoto())?.find((t) => t.id === id) ?? (await this.doLocal()).find((t) => t.id === id);
    if (achado === undefined) throw new Error(`template não encontrado: "${id}"`);
    return achado;
  }

  /** `null` quando o remoto não respondeu; lista vazia é resposta válida. */
  private async doRemoto(): Promise<TemplateBruto[] | null> {
    try {
      const resposta = await this.pegar(URL_LISTAGEM_TEMPLATES);
      const itens = (await resposta.json()) as { name?: unknown; type?: unknown; download_url?: unknown }[];
      if (!Array.isArray(itens)) return null;
      const arquivos = itens.filter(
        (i): i is { name: string; type: string; download_url: string } =>
          typeof i.name === "string" && i.name.endsWith(".json") && i.type === "file" && typeof i.download_url === "string",
      );
      const lidos = await Promise.all(
        arquivos.map(async (a) => {
          try {
            return aceitar(await (await this.pegar(a.download_url)).text());
          } catch {
            return null;
          }
        }),
      );
      return lidos.filter((t): t is TemplateBruto => t !== null);
    } catch {
      return null;
    }
  }

  private async doLocal(): Promise<TemplateBruto[]> {
    let nomes: string[];
    try {
      nomes = (await readdir(this.pastaLocal)).filter((n) => n.endsWith(".json")).sort();
    } catch {
      return [];
    }
    const lidos = await Promise.all(
      nomes.map(async (nome) => {
        try {
          return aceitar(await readFile(join(this.pastaLocal, nome), "utf8"));
        } catch {
          return null;
        }
      }),
    );
    return lidos.filter((t): t is TemplateBruto => t !== null);
  }

  private async pegar(url: string): Promise<Response> {
    const resposta = await this.buscar(url, {
      signal: AbortSignal.timeout(this.prazoMs),
      headers: { Accept: "application/vnd.github+json", "User-Agent": "locum" },
    });
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status} em ${url}`);
    return resposta;
  }
}

/** JSON com `id` e `name` em texto; o resto fica para a validação do importar. */
function aceitar(texto: string): TemplateBruto | null {
  const bruto = JSON.parse(texto) as Partial<TemplateBruto> | null;
  if (bruto === null || typeof bruto !== "object") return null;
  if (typeof bruto.id !== "string" || typeof bruto.name !== "string") return null;
  return bruto as TemplateBruto;
}

function resumir(bruto: TemplateBruto): TemplateResumo {
  const passos = Array.isArray(bruto.steps) ? bruto.steps : [];
  const passosDeModelo = passos
    .map((p, indice) => ({ indice, modelo: (p as { model?: unknown }).model }))
    .filter((p): p is { indice: number; modelo: string } => typeof p.modelo === "string");
  return { id: bruto.id, name: bruto.name, modelo: passosDeModelo[0]?.modelo ?? null, passos: passos.length, passosDeModelo };
}
