import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * As conversas do opencode desta máquina, no mesmo formato que a tela de
 * sessões já mostra para o Claude Code.
 *
 * O opencode guarda tudo num SQLite em `~/.local/share/opencode/opencode.db`
 * (o `XDG_DATA_HOME` muda a pasta): a tabela `session` tem título, pasta e
 * horário, e `message` e `part` guardam a conversa em JSON. O banco é aberto
 * só para leitura, e nada aqui escreve lá.
 *
 * Diferente do Claude Code, o opencode não deixa registro de qual processo está
 * com a sessão aberta. O estado sai do relógio: atividade nos últimos minutos
 * conta como aberta, e o resto como fechada.
 */

export interface ConversaDoOpencode {
  id: string;
  title: string;
  cwd: string;
  /** Segundos desde a época. */
  startedAt: number;
  lastActivityAt: number;
  lastPrompt: string | null;
  lastReply: string | null;
  /** A última resposta do assistente terminou. */
  respondeu: boolean;
  turns: number;
}

/** Atividade mais recente que isto conta como sessão ainda aberta. */
export const OPENCODE_ABERTA_MS = 5 * 60_000;

/**
 * O binário do opencode por caminho absoluto. O instalador oficial põe em
 * `~/.opencode/bin` e só o `.zshrc` acrescenta isso ao PATH, que o script de
 * retomar, em `sh`, não lê.
 */
export function binarioDoOpencode(home = homedir()): string {
  const lugares = [join(home, ".opencode", "bin", "opencode"), "/opt/homebrew/bin/opencode", "/usr/local/bin/opencode"];
  return lugares.find((l) => existsSync(l)) ?? "opencode";
}

/** O banco que o opencode da versão estável usa. */
export function bancoDoOpencode(home = homedir()): string {
  const dados = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
  return join(dados, "opencode", "opencode.db");
}

interface LinhaDaSessao {
  id: string;
  title: string;
  directory: string;
  time_created: number;
  time_updated: number;
}

interface DadosDaMensagem {
  role?: string;
  time?: { created?: number; completed?: number };
}

interface DadosDaParte {
  type?: string;
  text?: string;
  synthetic?: boolean;
}

/**
 * As sessões de primeiro nível (sem as de subagent), não arquivadas, com
 * atividade desde `desdeMs`. Sem banco, ou com banco de esquema que não se
 * reconhece, a lista vem vazia: a tela de sessões não pode cair por causa de
 * uma ferramenta que nem todo mundo usa.
 */
export function lerConversasDoOpencode(caminho: string, desdeMs: number): ConversaDoOpencode[] {
  if (!existsSync(caminho)) return [];
  let banco: Database.Database;
  try {
    banco = new Database(caminho, { readonly: true, fileMustExist: true });
  } catch {
    return [];
  }
  try {
    const sessoes = banco
      .prepare(
        `SELECT id, title, directory, time_created, time_updated FROM session
         WHERE parent_id IS NULL AND time_archived IS NULL AND time_updated >= ?
         ORDER BY time_updated DESC LIMIT 200`,
      )
      .all(desdeMs) as LinhaDaSessao[];

    const pedidos = banco.prepare(
      "SELECT count(*) AS n FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user'",
    );

    const ultimoUserMsg = banco.prepare(
      `SELECT id FROM message 
       WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
       ORDER BY time_created DESC, id DESC LIMIT 1`,
    );

    const partes = banco.prepare(
      `SELECT data FROM part WHERE message_id = ? ORDER BY id`,
    );

    const ultimaAssistantPart = banco.prepare(
      `SELECT p.data 
       FROM message m 
       JOIN part p ON p.message_id = m.id 
       WHERE m.session_id = ? 
         AND json_extract(m.data, '$.role') = 'assistant' 
         AND json_extract(p.data, '$.type') = 'text' 
         AND json_extract(p.data, '$.synthetic') IS NOT 1
       ORDER BY m.time_created DESC, p.id DESC LIMIT 1`,
    );

    const ultimaMensagem = banco.prepare(
      "SELECT data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT 1",
    );

    const texto = (mensagemId: string): string | null => {
      const pedacos = (partes.all(mensagemId) as { data: string }[])
        .map((p) => ler<DadosDaParte>(p.data))
        .filter((p) => p.type === "text" && p.synthetic !== true && typeof p.text === "string")
        .map((p) => p.text!.trim())
        .filter((t) => t !== "");
      return pedacos.length === 0 ? null : pedacos.join("\n");
    };

    return sessoes.map((s) => {
      const uUser = ultimoUserMsg.get(s.id) as { id: string } | undefined;
      const uAssistPart = ultimaAssistantPart.get(s.id) as { data: string } | undefined;
      const uMsg = ultimaMensagem.get(s.id) as { data: string } | undefined;
      const dadosUltima = uMsg ? ler<DadosDaMensagem>(uMsg.data) : undefined;
      const respostaTexto = uAssistPart ? (ler<DadosDaParte>(uAssistPart.data).text?.trim() ?? null) : null;

      return {
        id: s.id,
        title: s.title,
        cwd: s.directory,
        startedAt: Math.floor(s.time_created / 1000),
        lastActivityAt: Math.floor(s.time_updated / 1000),
        lastPrompt: uUser ? texto(uUser.id) : null,
        lastReply: respostaTexto && respostaTexto !== "" ? respostaTexto : null,
        respondeu: dadosUltima?.role === "assistant" && typeof dadosUltima.time?.completed === "number",
        turns: (pedidos.get(s.id) as { n: number } | undefined)?.n ?? 0,
      };
    });
  } catch {
    return [];
  } finally {
    banco.close();
  }
}

function ler<T>(texto: string): T {
  try {
    const valor = JSON.parse(texto) as unknown;
    return (typeof valor === "object" && valor !== null ? valor : {}) as T;
  } catch {
    return {} as T;
  }
}
