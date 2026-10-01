import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeBinary } from "../runtimes/claude-binary.js";
import { sessionService, shellQuote, type SessionService } from "./session-service.js";
import { settingsService, type SettingsService } from "./settings-service.js";

/**
 * As sessões do Claude Code desta máquina, abertas ou não, e se cada uma
 * terminou.
 *
 * Tudo sai de dois lugares que o próprio Claude Code mantém em `~/.claude`:
 * `sessions/<pid>.json` diz quem está com o processo vivo e se está trabalhando
 * ou parado, e `projects/<pasta>/<id>.jsonl` guarda a conversa. Nada aqui
 * escreve lá. Os arquivos `.key` ao lado do registro são segredos do canal
 * entre processos e nunca são abertos.
 *
 * "Terminei" não dá para adivinhar: a última resposta do Claude pode ser o fim
 * do trabalho ou uma pergunta esquecida. Por isso a sessão fechada fica na
 * lista até alguém marcar, e a marca cai sozinha se a conversa andar depois.
 */

export type EstadoDaSessao =
  /** Processo vivo e o Claude no meio de um turno. */
  | "working"
  /** Processo vivo, o Claude respondeu e a vez é de quem usa. */
  | "waiting"
  /** Processo fechado no meio de um turno: ferramenta sem resposta, pedido sem resposta. */
  | "interrupted"
  /** Processo fechado depois de uma resposta do Claude, sem marca de terminada. */
  | "unfinished"
  /** Marcada como terminada por quem usa. */
  | "done";

export interface SessaoDoClaude {
  id: string;
  title: string;
  cwd: string;
  branch: string | null;
  state: EstadoDaSessao;
  /** Segundos desde a época. */
  lastActivityAt: number;
  startedAt: number | null;
  lastPrompt: string | null;
  lastReply: string | null;
  /** O Claude terminou a última resposta com uma pergunta. */
  askedQuestion: boolean;
  /** Arquivos com mudança sem commit no diretório da sessão; nulo fora de repositório git. */
  uncommitted: number | null;
  pid: number | null;
  turns: number;
}

export interface ClaudeSessionsDeps {
  /** Sem valor, `LOCUM_CLAUDE_DIR` ou `~/.claude`, lido a cada chamada para a fumaça poder trocar. */
  claudeDir: string | undefined;
  settings: SettingsService;
  sessions: Pick<SessionService, "terminal">;
  isAlive: (pid: number) => boolean;
  gitChanges: (cwd: string) => Promise<number | null>;
  exec: (command: string, args: string[]) => Promise<void>;
  resolveClaude: () => Promise<string | undefined>;
  scriptDir: string;
  now: () => number;
}

const DONE_KEY = "claudeSessions.done";
/** Sessão parada há mais que isto sai da lista, a não ser que esteja aberta. */
const JANELA_DIAS = 14;
/** O fim do arquivo basta para o estado; o começo só é lido atrás do título. */
const CAUDA_BYTES = 256 * 1024;
const CABECA_BYTES = 64 * 1024;
const TRECHO = 280;
/**
 * O `git status` é o mais lento da leitura, e a tela relê a cada poucos
 * segundos. A contagem de arquivos não precisa ser do instante.
 */
const GIT_TTL_MS = 60_000;
/** Só as sessões de gente. `sdk-cli` é o Claude chamado por programa, o próprio Locum incluso. */
const ENTRADAS_HUMANAS = new Set(["cli", "claude-vscode", "claude-desktop"]);

const TERMINAL_APP = { terminal: "Terminal", iterm: "iTerm" } as const;

interface Registro {
  pid: number;
  sessionId: string;
  cwd: string;
  status?: string;
  startedAt?: number;
}

interface Linha {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  entrypoint?: string;
  aiTitle?: string;
  message?: { role?: string; content?: unknown; stop_reason?: string | null };
}

function lerLinhas(texto: string, cortarPrimeira: boolean): Linha[] {
  const partes = texto.split("\n");
  if (cortarPrimeira) partes.shift();
  const linhas: Linha[] = [];
  for (const parte of partes) {
    if (parte.trim() === "") continue;
    try {
      linhas.push(JSON.parse(parte) as Linha);
    } catch {
      // Linha cortada no meio pela leitura parcial, ou sendo escrita agora.
    }
  }
  return linhas;
}

async function lerTrecho(caminho: string, inicio: number, tamanho: number): Promise<string> {
  const arquivo = await open(caminho, "r");
  try {
    const buffer = Buffer.alloc(tamanho);
    const { bytesRead } = await arquivo.read(buffer, 0, tamanho, inicio);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await arquivo.close();
  }
}

/** O texto que a pessoa digitou, ou nulo para resultado de ferramenta e mensagem do sistema. */
export function textoDoPedido(linha: Linha): string | null {
  if (linha.type !== "user" || linha.isMeta === true || linha.isSidechain === true) return null;
  const conteudo = linha.message?.content;
  let texto: string | null = null;
  if (typeof conteudo === "string") texto = conteudo;
  else if (Array.isArray(conteudo)) {
    const partes = conteudo as { type?: string; text?: string }[];
    if (partes.some((p) => p.type === "tool_result")) return null;
    texto = partes
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  if (texto === null) return null;
  texto = texto.trim();
  // Comando de barra, saída de comando local, lembrete do sistema: nada disso foi digitado como pedido.
  if (texto === "" || texto.startsWith("<")) return null;
  return texto;
}

function textoDaResposta(linha: Linha): string | null {
  if (linha.type !== "assistant" || linha.isSidechain === true) return null;
  const conteudo = linha.message?.content;
  if (!Array.isArray(conteudo)) return null;
  const texto = (conteudo as { type?: string; text?: string }[])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
  return texto === "" ? null : texto;
}

function trecho(texto: string | null): string | null {
  if (texto === null) return null;
  const limpo = texto.replace(/\s+/g, " ").trim();
  return limpo.length > TRECHO ? `${limpo.slice(0, TRECHO - 1)}…` : limpo;
}

function segundos(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/**
 * O que a conversa diz de si, lida das linhas. Exportado para teste: é aqui
 * que mora a regra de "parou no meio".
 */
export function resumirConversa(cabeca: Linha[], cauda: Linha[]) {
  const todas = [...cabeca, ...cauda];
  let titulo: string | null = null;
  let primeiroPedido: string | null = null;
  let ultimoPedido: string | null = null;
  let ultimaResposta: string | null = null;
  let entrada: string | null = null;
  let cwd: string | null = null;
  let branch: string | null = null;
  let inicio: number | null = null;
  let turnos = 0;

  for (const linha of cabeca) {
    if (entrada === null && typeof linha.entrypoint === "string") entrada = linha.entrypoint;
    if (inicio === null) inicio = segundos(linha.timestamp);
    if (primeiroPedido === null) primeiroPedido = textoDoPedido(linha);
  }
  for (const linha of todas) {
    if (linha.type === "ai-title" && typeof linha.aiTitle === "string") titulo = linha.aiTitle;
    if (typeof linha.cwd === "string") cwd = linha.cwd;
    if (typeof linha.gitBranch === "string" && linha.gitBranch !== "") branch = linha.gitBranch;
    if (entrada === null && typeof linha.entrypoint === "string") entrada = linha.entrypoint;
  }
  for (const linha of cauda) {
    const pedido = textoDoPedido(linha);
    if (pedido !== null) {
      ultimoPedido = pedido;
      turnos += 1;
    }
    const resposta = textoDaResposta(linha);
    if (resposta !== null) ultimaResposta = resposta;
  }

  // O fim da conversa é a última fala de alguém; anexo, hook e registro de
  // modo vêm depois de toda resposta e não dizem nada sobre ela.
  const falas = cauda.filter((l) => (l.type === "user" || l.type === "assistant") && l.isSidechain !== true);
  const ultima = falas.at(-1);
  const respondeu =
    ultima !== undefined &&
    ultima.type === "assistant" &&
    (ultima.message?.stop_reason === "end_turn" || ultima.message?.stop_reason === "stop_sequence") &&
    textoDaResposta(ultima) !== null;

  return {
    titulo: titulo ?? trecho(primeiroPedido),
    entrada,
    cwd,
    branch,
    inicio,
    turnos,
    ultimoPedido: trecho(ultimoPedido),
    ultimaResposta: trecho(ultimaResposta),
    perguntou: ultimaResposta !== null && /\?\s*$/.test(ultimaResposta.trim()),
    respondeu,
  };
}

function processoVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (erro) {
    // EPERM quer dizer que existe e é de outro usuário: vivo do mesmo jeito.
    return (erro as NodeJS.ErrnoException).code === "EPERM";
  }
}

function mudancasNoGit(cwd: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, "status", "--porcelain"],
      { timeout: 3000, maxBuffer: 4 * 1024 * 1024 },
      (erro, saida) => {
        if (erro) return resolve(null);
        resolve(saida.split("\n").filter((l) => l.trim() !== "").length);
      },
    );
  });
}

function execPadrao(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (erro) => (erro ? reject(erro) : resolve()));
  });
}

export class ClaudeSessionsService {
  private readonly deps: ClaudeSessionsDeps;
  private readonly gitCache = new Map<string, { em: number; valor: Promise<number | null> }>();

  constructor(deps: Partial<ClaudeSessionsDeps> = {}) {
    this.deps = {
      claudeDir: undefined,
      settings: settingsService,
      sessions: sessionService,
      isAlive: processoVivo,
      gitChanges: mudancasNoGit,
      exec: execPadrao,
      resolveClaude: () => claudeBinary(),
      scriptDir: join(tmpdir(), "locum-resume"),
      now: Date.now,
      ...deps,
    };
  }

  private dir(): string {
    return this.deps.claudeDir ?? process.env.LOCUM_CLAUDE_DIR ?? join(homedir(), ".claude");
  }

  private async abertas(): Promise<Map<string, Registro>> {
    const pasta = join(this.dir(), "sessions");
    const vivas = new Map<string, Registro>();
    let nomes: string[];
    try {
      nomes = await readdir(pasta);
    } catch {
      return vivas;
    }
    for (const nome of nomes) {
      if (!nome.endsWith(".json")) continue;
      try {
        const registro = JSON.parse(await readFile(join(pasta, nome), "utf8")) as Registro;
        if (typeof registro.pid !== "number" || typeof registro.sessionId !== "string") continue;
        if (!this.deps.isAlive(registro.pid)) continue;
        vivas.set(registro.sessionId, registro);
      } catch {
        // Registro sendo reescrito pelo próprio Claude Code; volta na próxima leitura.
      }
    }
    return vivas;
  }

  private async marcadas(): Promise<Record<string, number>> {
    const texto = await this.deps.settings.get(DONE_KEY);
    if (texto === undefined) return {};
    try {
      const valor = JSON.parse(texto) as unknown;
      return typeof valor === "object" && valor !== null ? (valor as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  async list(): Promise<SessaoDoClaude[]> {
    const projetos = join(this.dir(), "projects");
    const vivas = await this.abertas();
    const marcadas = await this.marcadas();
    const limite = this.deps.now() / 1000 - JANELA_DIAS * 86_400;

    let pastas: string[];
    try {
      pastas = await readdir(projetos);
    } catch {
      return [];
    }

    const candidatos: { id: string; caminho: string; mtime: number; tamanho: number }[] = [];
    for (const pasta of pastas) {
      let arquivos: string[];
      try {
        arquivos = await readdir(join(projetos, pasta));
      } catch {
        continue;
      }
      for (const arquivo of arquivos) {
        if (!arquivo.endsWith(".jsonl")) continue;
        const caminho = join(projetos, pasta, arquivo);
        const info = await stat(caminho).catch(() => null);
        if (info === null || !info.isFile()) continue;
        const id = arquivo.slice(0, -".jsonl".length);
        const mtime = Math.floor(info.mtimeMs / 1000);
        if (mtime < limite && !vivas.has(id)) continue;
        candidatos.push({ id, caminho, mtime, tamanho: info.size });
      }
    }

    const agora = this.deps.now();
    const sessoes = await Promise.all(
      candidatos.map(async (c): Promise<SessaoDoClaude | null> => {
        const inicioDaCauda = Math.max(0, c.tamanho - CAUDA_BYTES);
        const [textoCabeca, textoCauda] = await Promise.all([
          lerTrecho(c.caminho, 0, Math.min(CABECA_BYTES, c.tamanho)),
          lerTrecho(c.caminho, inicioDaCauda, c.tamanho - inicioDaCauda),
        ]);
        const resumo = resumirConversa(
          lerLinhas(textoCabeca, false).slice(0, -1),
          lerLinhas(textoCauda, inicioDaCauda > 0),
        );
        if (resumo.entrada !== null && !ENTRADAS_HUMANAS.has(resumo.entrada)) return null;
        // Sessão aberta e fechada sem pedido nenhum não tem o que retomar.
        if (resumo.titulo === null && resumo.turnos === 0) return null;

        const viva = vivas.get(c.id);
        const cwd = resumo.cwd ?? viva?.cwd ?? "";
        const marca = marcadas[c.id];
        const estado: EstadoDaSessao =
          viva !== undefined
            ? viva.status === "busy"
              ? "working"
              : "waiting"
            : marca !== undefined && marca >= c.mtime
              ? "done"
              : resumo.respondeu
                ? "unfinished"
                : "interrupted";

        let git: Promise<number | null> | undefined;
        if (cwd !== "" && estado !== "done") {
          const guardado = this.gitCache.get(cwd);
          if (guardado !== undefined && agora - guardado.em < GIT_TTL_MS) git = guardado.valor;
          else {
            git = this.deps.gitChanges(cwd);
            this.gitCache.set(cwd, { em: agora, valor: git });
          }
        }

        return {
          id: c.id,
          title: resumo.titulo ?? c.id.slice(0, 8),
          cwd,
          branch: resumo.branch,
          state: estado,
          lastActivityAt: c.mtime,
          startedAt: resumo.inicio,
          lastPrompt: resumo.ultimoPedido,
          lastReply: resumo.ultimaResposta,
          askedQuestion: resumo.perguntou,
          uncommitted: git === undefined ? null : await git,
          pid: viva?.pid ?? null,
          turns: resumo.turnos,
        };
      }),
    );

    return sessoes
      .filter((s): s is SessaoDoClaude => s !== null)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  /** Marca como terminada. Guarda o instante da última atividade, que é o que faz a marca cair se a conversa andar. */
  async markDone(id: string, lastActivityAt: number): Promise<void> {
    const marcadas = await this.marcadas();
    marcadas[id] = lastActivityAt;
    await this.deps.settings.set(DONE_KEY, JSON.stringify(marcadas));
  }

  async reopen(id: string): Promise<void> {
    const marcadas = await this.marcadas();
    delete marcadas[id];
    await this.deps.settings.set(DONE_KEY, JSON.stringify(marcadas));
  }

  /**
   * Retoma no terminal preferido com `claude --resume`, na pasta onde a sessão
   * rodava. Sessão com processo vivo não é retomada: dois processos na mesma
   * conversa escreveriam o mesmo arquivo.
   */
  async resume(id: string): Promise<{ terminal: string; cwd: string }> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`sessão inválida: "${id}"`);
    const sessao = (await this.list()).find((s) => s.id === id);
    if (sessao === undefined) throw new Error(`sessão ${id} não encontrada`);
    if (sessao.pid !== null) throw new Error(`a sessão ${id} ainda está aberta no processo ${sessao.pid}`);

    const claude = (await this.deps.resolveClaude()) ?? "claude";
    const terminal = await this.deps.sessions.terminal();
    mkdirSync(this.deps.scriptDir, { recursive: true });
    const script = join(this.deps.scriptDir, `${id}.command`);
    writeFileSync(
      script,
      ["#!/bin/sh", `cd ${shellQuote(sessao.cwd)} || exit 1`, `exec ${shellQuote(claude)} --resume ${shellQuote(id)}`, ""].join("\n"),
    );
    chmodSync(script, 0o755);
    await this.deps.exec("open", ["-a", TERMINAL_APP[terminal], script]);
    return { terminal, cwd: sessao.cwd };
  }
}

export const claudeSessionsService = new ClaudeSessionsService();
