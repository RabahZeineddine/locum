import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { criarClienteHttp } from "../net/http.js";

/** `fetch` mínimo, para o teste injetar um falso. */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: "manual" },
) => Promise<Response>;

export type OrigemDoTemplate = "remoto" | "local";

export interface TemplateBruto {
  id: string;
  name: string;
  steps?: unknown[];
  [chave: string]: unknown;
}

export interface TemplateResumo {
  id: string;
  name: string;
  origem: OrigemDoTemplate;
  passos: number;
  /** Os passos que escolhem modelo: índice e nome, nunca o modelo do template, que não decide nada. */
  passosDeModelo: { indice: number; nome: string }[];
}

export const URL_LISTAGEM_TEMPLATES =
  "https://api.github.com/repos/RabahZeineddine/locum/contents/examples/agents?ref=main";
const HOST_DOS_ARQUIVOS = "raw.githubusercontent.com";
const PRAZO_MS = 5000;
const LIMITE_DO_CORPO = 256 * 1024;
const VALIDADE_MS = 10 * 60 * 1000;
const ID_VALIDO = /^[a-z0-9][a-z0-9-]{1,62}$/;

interface Opcoes {
  fetch?: FetchLike;
  /** Cópia empacotada: `examples/agents` em dev, `dist/agents` empacotado. */
  pastaLocal: string;
  prazoMs?: number;
  agora?: () => number;
}

interface Achado {
  origem: OrigemDoTemplate;
  bruto: TemplateBruto;
}

/**
 * De onde vêm os templates do marketplace: o repositório remoto (branch
 * `main`) primeiro, a cópia empacotada de reserva, por template.
 *
 * A fronteira de confiança é a `main` do repositório público: o que está lá é
 * oferecido a quem usa. Nada daqui é executado; todo spec passa pelo
 * `AgentSpec` no `importSpec` antes de virar agent.
 *
 * Listar guarda o resultado (origem e JSON bruto por id) por alguns minutos, e
 * instalar lê dali: o que a pessoa viu na lista é o que é instalado, mesmo que
 * o remoto mude ou caia no meio.
 */
export class TemplateSource {
  private readonly buscar: FetchLike;
  private readonly pastaLocal: string;
  private readonly agora: () => number;
  private guardado: { em: number; porId: Map<string, Achado> } | null = null;

  constructor(opcoes: Opcoes) {
    this.buscar =
      opcoes.fetch ??
      (criarClienteHttp({ prazoMs: opcoes.prazoMs ?? PRAZO_MS, tentativas: 2 }) as unknown as FetchLike);
    this.pastaLocal = opcoes.pastaLocal;
    this.agora = opcoes.agora ?? Date.now;
  }

  async listar(): Promise<TemplateResumo[]> {
    const porId = await this.carregar();
    return [...porId.entries()]
      .map(([id, achado]) => resumir(id, achado))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** O spec cru do template, como a última listagem o mostrou; a validação de verdade é a do importar. */
  async ler(id: string): Promise<TemplateBruto> {
    if (!ID_VALIDO.test(id)) throw new Error(`id de template inválido: "${id}"`);
    const vivo = this.guardado !== null && this.agora() - this.guardado.em < VALIDADE_MS;
    const porId = vivo ? this.guardado!.porId : await this.carregar();
    const achado = porId.get(id);
    if (achado === undefined) throw new Error(`template não encontrado: "${id}"`);
    // Cópia: quem instala troca o modelo dos passos, e isso não pode vazar para a próxima leitura.
    return structuredClone(achado.bruto);
  }

  private async carregar(): Promise<Map<string, Achado>> {
    const locais = await this.doLocal();
    const remotos = await this.listaRemota();
    const porId = new Map<string, Achado>();
    const guardar = (origem: OrigemDoTemplate, bruto: TemplateBruto | null): void => {
      if (bruto === null || !ID_VALIDO.test(bruto.id) || porId.has(bruto.id)) return;
      porId.set(bruto.id, { origem, bruto });
    };

    if (remotos === null) {
      for (const bruto of locais.values()) guardar("local", bruto);
    } else {
      await Promise.all(
        remotos.map(async (arquivo) => {
          try {
            return { arquivo, texto: await this.baixar(arquivo.url) };
          } catch {
            return { arquivo, texto: null };
          }
        }),
      ).then((baixados) => {
        for (const { arquivo, texto } of baixados) {
          if (texto === null) guardar("local", locais.get(arquivo.nome) ?? null);
          else guardar("remoto", aceitar(texto));
        }
      });
    }
    this.guardado = { em: this.agora(), porId };
    return porId;
  }

  /** `null` quando o remoto não respondeu; lista vazia é resposta válida. */
  private async listaRemota(): Promise<{ nome: string; url: string }[] | null> {
    try {
      const itens = JSON.parse(await this.baixar(URL_LISTAGEM_TEMPLATES, true)) as {
        name?: unknown;
        type?: unknown;
        download_url?: unknown;
      }[];
      if (!Array.isArray(itens)) return null;
      return itens.flatMap((i) =>
        typeof i.name === "string" && i.name.endsWith(".json") && i.type === "file" && typeof i.download_url === "string"
          ? [{ nome: i.name, url: i.download_url }]
          : [],
      );
    } catch {
      return null;
    }
  }

  private async doLocal(): Promise<Map<string, TemplateBruto>> {
    const lidos = new Map<string, TemplateBruto>();
    let nomes: string[];
    try {
      nomes = (await readdir(this.pastaLocal)).filter((n) => n.endsWith(".json")).sort();
    } catch {
      return lidos;
    }
    for (const nome of nomes) {
      try {
        const bruto = aceitar(await readFile(join(this.pastaLocal, nome), "utf8"));
        if (bruto !== null) lidos.set(nome, bruto);
      } catch {
        // arquivo ilegível: o template some só da cópia local
      }
    }
    return lidos;
  }

  /** Texto da resposta, sem seguir redirect e com corpo limitado. A listagem é da API; os arquivos só do host raw. */
  private async baixar(url: string, ehListagem = false): Promise<string> {
    if (!ehListagem && new URL(url).host !== HOST_DOS_ARQUIVOS) throw new Error(`host não permitido: ${url}`);
    const resposta = await this.buscar(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "locum" },
      redirect: "manual",
    });
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status} em ${url}`);
    return lerLimitado(resposta);
  }
}

async function lerLimitado(resposta: Response): Promise<string> {
  const anunciado = Number(resposta.headers.get("content-length"));
  if (Number.isFinite(anunciado) && anunciado > LIMITE_DO_CORPO) throw new Error("corpo maior que o limite");
  const leitor = resposta.body?.getReader();
  if (leitor === undefined) return "";
  const pedacos: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > LIMITE_DO_CORPO) {
      await leitor.cancel();
      throw new Error("corpo maior que o limite");
    }
    pedacos.push(value);
  }
  return Buffer.concat(pedacos).toString("utf8");
}

/** JSON com `id` e `name` em texto; o resto fica para a validação do importar. */
function aceitar(texto: string): TemplateBruto | null {
  try {
    const bruto = JSON.parse(texto) as Partial<TemplateBruto> | null;
    if (bruto === null || typeof bruto !== "object") return null;
    if (typeof bruto.id !== "string" || typeof bruto.name !== "string") return null;
    return bruto as TemplateBruto;
  } catch {
    return null;
  }
}

function resumir(id: string, { origem, bruto }: Achado): TemplateResumo {
  const passos = Array.isArray(bruto.steps) ? bruto.steps : [];
  const passosDeModelo = passos.flatMap((p, indice) => {
    const passo = p as { model?: unknown; name?: unknown; key?: unknown };
    if (typeof passo.model !== "string") return [];
    const nome = typeof passo.name === "string" ? passo.name : typeof passo.key === "string" ? passo.key : `#${indice + 1}`;
    return [{ indice, nome }];
  });
  return { id, name: bruto.name, origem, passos: passos.length, passosDeModelo };
}
