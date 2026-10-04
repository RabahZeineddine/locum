import { randomUUID } from "node:crypto";
import { shellQuote } from "../services/session-service.js";

/**
 * Terminais que rodam dentro do Locum: o mesmo script que a sessão da
 * iniciativa mandaria para o Terminal, o iTerm ou o Warp, aberto num
 * pseudoterminal do processo principal e desenhado pela janela.
 *
 * O processo continua vivo quando a janela troca de tela: quem volta pede o
 * que já saiu (`buffer`) e segue recebendo o fluxo.
 */

export interface Pty {
  onData(ouvinte: (dados: string) => void): void;
  onExit(ouvinte: (fim: { exitCode: number }) => void): void;
  write(dados: string): void;
  resize(colunas: number, linhas: number): void;
  kill(): void;
}

export type AbrirPty = (comando: string, args: string[], opcoes: { cwd: string; cols: number; rows: number; env: Record<string, string> }) => Pty;

export interface Terminal {
  id: string;
  titulo: string;
  /** Slug da iniciativa, quando o terminal é dela. */
  iniciativa: string | null;
  cwd: string;
  vivo: boolean;
  codigo: number | null;
  inicio: number;
}

export type EventoDoTerminal = { id: string; tipo: "dados"; dados: string } | { id: string; tipo: "fim"; codigo: number };

/** O que fica guardado da saída para quem reabre: o bastante para a tela atual do Claude Code. */
const TETO_DO_BUFFER = 256 * 1024;

interface Vivo extends Terminal {
  pty: Pty;
  buffer: string;
}

export class TerminalService {
  private terminais = new Map<string, Vivo>();
  private ouvintes = new Set<(evento: EventoDoTerminal) => void>();

  constructor(
    private abrirPty: AbrirPty | null,
    private shell = "/bin/zsh",
  ) {}

  disponivel(): boolean {
    return this.abrirPty !== null;
  }

  ouvir(ouvinte: (evento: EventoDoTerminal) => void): () => void {
    this.ouvintes.add(ouvinte);
    return () => this.ouvintes.delete(ouvinte);
  }

  private emitir(evento: EventoDoTerminal): void {
    for (const o of this.ouvintes) o(evento);
  }

  /**
   * Roda o script pelo shell de login, para o PATH ser o do terminal da pessoa
   * mesmo com o app aberto pelo Finder.
   */
  abrir(entrada: { script: string; cwd: string; titulo: string; iniciativa?: string | null; colunas?: number; linhas?: number }): Terminal {
    if (this.abrirPty === null) throw new Error("terminal embutido indisponível nesta instalação");
    const id = randomUUID();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";
    // Variáveis do próprio Electron vazariam para o Claude Code e mudariam o
    // modo dele; a do Node rodando como Electron é a que mais confunde.
    delete env.ELECTRON_RUN_AS_NODE;

    const pty = this.abrirPty(this.shell, ["-lc", `exec ${shellQuote(entrada.script)}`], {
      cwd: entrada.cwd,
      cols: entrada.colunas ?? 120,
      rows: entrada.linhas ?? 32,
      env,
    });
    const terminal: Vivo = {
      id,
      titulo: entrada.titulo,
      iniciativa: entrada.iniciativa ?? null,
      cwd: entrada.cwd,
      vivo: true,
      codigo: null,
      inicio: Date.now(),
      pty,
      buffer: "",
    };
    this.terminais.set(id, terminal);
    pty.onData((dados) => {
      terminal.buffer = (terminal.buffer + dados).slice(-TETO_DO_BUFFER);
      this.emitir({ id, tipo: "dados", dados });
    });
    pty.onExit(({ exitCode }) => {
      terminal.vivo = false;
      terminal.codigo = exitCode;
      this.emitir({ id, tipo: "fim", codigo: exitCode });
    });
    return publico(terminal);
  }

  /** `undefined` lista todos; `null`, só os que não são de iniciativa nenhuma. */
  listar(iniciativa?: string | null): Terminal[] {
    return [...this.terminais.values()].filter((t) => iniciativa === undefined || t.iniciativa === iniciativa).map(publico);
  }

  buffer(id: string): string {
    return this.um(id).buffer;
  }

  escrever(id: string, dados: string): void {
    const t = this.um(id);
    if (t.vivo) t.pty.write(dados);
  }

  redimensionar(id: string, colunas: number, linhas: number): void {
    const t = this.um(id);
    if (t.vivo && colunas > 0 && linhas > 0) t.pty.resize(Math.floor(colunas), Math.floor(linhas));
  }

  /** Fecha e esquece. Vivo, o processo recebe o sinal de encerrar antes. */
  fechar(id: string): void {
    const t = this.um(id);
    if (t.vivo) t.pty.kill();
    this.terminais.delete(id);
  }

  fecharTodos(): void {
    for (const id of [...this.terminais.keys()]) this.fechar(id);
  }

  private um(id: string): Vivo {
    const t = this.terminais.get(id);
    if (t === undefined) throw new Error(`terminal ${id} não existe`);
    return t;
  }
}

function publico({ pty: _p, buffer: _b, ...resto }: Vivo): Terminal {
  return { ...resto };
}
