import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  discoverSkills,
  parseFrontmatter,
  pastaDasSkillsDoLocum,
  type FonteDaSkill,
  type LoadedSkill,
} from "../skills/loader.js";
import { libraryService } from "./library-service.js";

/** Uma skill como a tela e o MCP a mostram. */
export interface SkillResumo {
  name: string;
  description: string;
  fonte: FonteDaSkill;
  /** O SKILL.md de onde ela vem. */
  arquivo: string;
  hash: string;
  /** Só as skills do Locum se editam: as da máquina seguem a origem. */
  editavel: boolean;
  /** Os agents da biblioteca que a citam. */
  agents: { id: string; name: string }[];
}

export interface SkillDetalhe extends SkillResumo {
  /** O SKILL.md inteiro, com o cabeçalho. */
  conteudo: string;
  /** O texto depois do cabeçalho. */
  corpo: string;
}

export interface SkillsDeps {
  home?: string;
  cwd?: string;
  locumDir?: string;
  agentes?: () => Promise<{ id: string; name: string; skills: string[] }[]>;
  agora?: () => number;
}

const CACHE_MS = 15_000;
const NOME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LIMITE_DE_ARQUIVOS = 200;
const LIMITE_DE_BYTES = 5 * 1024 * 1024;
const PULADAS = new Set(["node_modules", ".git"]);

/** O nome que o arquivo ou a pasta daria: minúsculas, sem acento, hífen no lugar do resto. */
function slug(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

function montar(name: string, description: string, body: string): string {
  const linha = description.replace(/\s+/g, " ").trim();
  return `---\nname: ${name}\ndescription: ${linha}\n---\n${body.replace(/^\n+/, "")}`;
}

function descricaoDoCorpo(corpo: string): string {
  const primeira = corpo.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find((l) => l !== "") ?? "";
  return primeira.slice(0, 160);
}

/**
 * A área de Skills. A skill da máquina é lida ao vivo da origem, com cache
 * curto para a tela não varrer o disco a cada clique, e nunca é copiada. A do
 * Locum vive em `<home do Locum>/skills/<nome>/SKILL.md`, e é a única que se
 * edita. Importar é a cópia explícita: vira skill do Locum e a origem fica como estava.
 */
export class SkillsService {
  private cache: { em: number; lista: SkillResumo[] } | null = null;

  constructor(private readonly deps: SkillsDeps = {}) {}

  private get locumDir(): string {
    return this.deps.locumDir ?? pastaDasSkillsDoLocum();
  }

  private agora(): number {
    return (this.deps.agora ?? Date.now)();
  }

  private descobrir(): Map<string, LoadedSkill> {
    return discoverSkills(this.deps.home, this.deps.cwd, this.locumDir);
  }

  async listar(opcoes: { atualizar?: boolean } = {}): Promise<SkillResumo[]> {
    if (!opcoes.atualizar && this.cache !== null && this.agora() - this.cache.em < CACHE_MS) return this.cache.lista;
    const agentes = await (this.deps.agentes ?? (() => libraryService.skillsPorAgent()))();
    const lista = [...this.descobrir().values()]
      .map((s) => this.resumo(s, agentes))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.cache = { em: this.agora(), lista };
    return lista;
  }

  /** Lê de novo do disco: o detalhe nunca mostra um SKILL.md velho. */
  async obter(name: string): Promise<SkillDetalhe> {
    const achada = this.descobrir().get(name);
    if (achada === undefined) throw new Error(`a skill "${name}" não existe nesta máquina`);
    const agentes = await (this.deps.agentes ?? (() => libraryService.skillsPorAgent()))();
    const conteudo = readFileSync(achada.origin, "utf8");
    return { ...this.resumo(achada, agentes), conteudo, corpo: parseFrontmatter(conteudo).body };
  }

  async criar(input: { name: string; description: string; body: string }): Promise<SkillResumo> {
    const name = this.nomeLivre(input.name);
    if (input.description.trim() === "") throw new Error("diga em uma linha quando usar a skill");
    this.gravar(name, montar(name, input.description, input.body));
    return this.deLocum(name);
  }

  async atualizar(name: string, input: { description: string; body: string }): Promise<SkillResumo> {
    this.exigirDoLocum(name);
    if (input.description.trim() === "") throw new Error("diga em uma linha quando usar a skill");
    this.gravar(name, montar(name, input.description, input.body));
    return this.deLocum(name);
  }

  async remover(name: string): Promise<{ name: string; agents: { id: string; name: string }[] }> {
    this.exigirDoLocum(name);
    const agents = (await this.deLocum(name)).agents;
    rmSync(join(this.locumDir, name), { recursive: true, force: true });
    this.cache = null;
    return { name, agents };
  }

  /**
   * Importa um `.md` ou uma pasta com SKILL.md. É cópia: depois disso a skill
   * é do Locum e não acompanha mais o arquivo de onde veio.
   */
  async importar(caminho: string): Promise<SkillResumo> {
    if (!existsSync(caminho)) throw new Error(`não encontrei "${caminho}"`);
    const pasta = statSync(caminho).isDirectory();
    const arquivo = pasta ? join(caminho, "SKILL.md") : caminho;
    if (pasta && !existsSync(arquivo)) throw new Error(`a pasta não tem SKILL.md: ${caminho}`);
    if (!pasta && extname(caminho).toLowerCase() !== ".md") throw new Error("escolha um arquivo .md ou uma pasta com SKILL.md");

    const bruto = readFileSync(arquivo, "utf8");
    const { name: declarado, description, body } = parseFrontmatter(bruto);
    const base = pasta ? basename(caminho) : basename(caminho, extname(caminho));
    const name = this.nomeLivre(NOME.test(declarado ?? "") ? declarado! : slug(declarado ?? base) || slug(base));
    const texto = declarado === name && description !== undefined ? bruto : montar(name, description ?? descricaoDoCorpo(body), body);

    try {
      if (pasta) this.copiarPasta(caminho, join(this.locumDir, name));
      this.gravar(name, texto);
    } catch (erro) {
      rmSync(join(this.locumDir, name), { recursive: true, force: true });
      throw erro;
    }
    return this.deLocum(name);
  }

  private resumo(s: LoadedSkill, agentes: { id: string; name: string; skills: string[] }[]): SkillResumo {
    return {
      name: s.name,
      description: s.description,
      fonte: s.fonte,
      arquivo: s.origin,
      hash: s.hash,
      editavel: s.fonte.tipo === "locum",
      agents: agentes.filter((a) => a.skills.includes(s.name)).map(({ id, name }) => ({ id, name })),
    };
  }

  private async deLocum(name: string): Promise<SkillResumo> {
    this.cache = null;
    const agentes = await (this.deps.agentes ?? (() => libraryService.skillsPorAgent()))();
    const achada = this.descobrir().get(name);
    if (achada === undefined) throw new Error(`a skill "${name}" não ficou legível depois de gravar`);
    return this.resumo(achada, agentes);
  }

  private exigirDoLocum(name: string): void {
    if (!existsSync(join(this.locumDir, name, "SKILL.md"))) {
      throw new Error(`só as skills do Locum se alteram aqui; "${name}" ${this.descobrir().has(name) ? "vem da máquina, edite na origem" : "não existe"}`);
    }
  }

  private nomeLivre(name: string): string {
    if (!NOME.test(name)) throw new Error("o nome usa minúsculas, dígitos e hífens, até 64 caracteres");
    if (existsSync(join(this.locumDir, name, "SKILL.md"))) throw new Error(`já existe uma skill do Locum chamada "${name}"`);
    if (this.descobrir().has(name)) throw new Error(`já existe uma skill da máquina chamada "${name}"; ela vence a do Locum`);
    return name;
  }

  private gravar(name: string, texto: string): void {
    mkdirSync(join(this.locumDir, name), { recursive: true });
    writeFileSync(join(this.locumDir, name, "SKILL.md"), texto);
    this.cache = null;
  }

  /** Copia a pasta sem seguir link e sem node_modules, com teto de arquivos e de tamanho. */
  private copiarPasta(origem: string, destino: string): void {
    const arquivos: string[] = [];
    let bytes = 0;
    const andar = (dir: string): void => {
      for (const entrada of readdirSync(dir)) {
        const cheio = join(dir, entrada);
        const info = lstatSync(cheio);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) {
          if (!PULADAS.has(entrada)) andar(cheio);
          continue;
        }
        arquivos.push(cheio);
        bytes += info.size;
        if (arquivos.length > LIMITE_DE_ARQUIVOS || bytes > LIMITE_DE_BYTES) {
          throw new Error("a pasta é grande demais para uma skill (200 arquivos ou 5 MB)");
        }
      }
    };
    andar(origem);
    for (const arquivo of arquivos) {
      const alvo = join(destino, arquivo.slice(origem.length + 1));
      mkdirSync(join(alvo, ".."), { recursive: true });
      cpSync(arquivo, alvo);
    }
  }
}

export const skillsService = new SkillsService();
