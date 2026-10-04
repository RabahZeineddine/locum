import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { flagsDaConta } from "../runtimes/claude-account.js";

/** O que o chat mostra enquanto a resposta chega. O mesmo formato do assistente. */
export type EventoDoChat =
  | { tipo: "texto"; delta: string }
  | { tipo: "ferramenta"; nome: string; entrada: unknown }
  | { tipo: "resultado"; nome: string }
  | { tipo: "fim"; motivo: string }
  | { tipo: "resumido" }
  | { tipo: "erro"; mensagem: string };

/** Só leitura de arquivo: mexer em código é do terminal da iniciativa, onde a pessoa vê cada passo. */
export const INTERNAS_DO_CHAT = ["Read", "Grep", "Glob"];

export interface PedidoDoChat {
  texto: string;
  modelo: string;
  cwd: string;
  /** Pastas que o modelo pode ler além da `cwd`, como a da iniciativa. */
  pastas: string[];
  system: string;
  /** Conversa do Claude Code a continuar. Ausente começa uma nova. */
  sessao?: string;
  mcpConfigPath?: string;
  /** Ferramentas MCP liberadas, no nome do Claude Code ou como `mcp__servidor` inteiro. */
  permitidas: string[];
  /** Com a conta, entram os conectores do claude.ai e os MCPs de plugin. */
  conta: boolean;
  /** Regras `deny` que a sessão da iniciativa já usa, como a de não editar o contexto. */
  negar?: string[];
}

/**
 * Argumentos do `claude -p` do chat. A conversa persiste no Claude Code para
 * o `--resume` da próxima mensagem; o resto segue o isolamento dos passos:
 * sem hook nem CLAUDE.md, e só roda o que está liberado.
 */
export function argsDoChat(p: PedidoDoChat): string[] {
  const args = [
    "-p",
    p.texto,
    "--model",
    p.modelo,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--append-system-prompt",
    p.system,
    "--permission-prompts",
    "none",
  ];
  for (const pasta of p.pastas) args.push("--add-dir", pasta);
  if (p.sessao !== undefined) args.push("--resume", p.sessao);
  if (p.mcpConfigPath !== undefined) args.push("--mcp-config", p.mcpConfigPath);
  args.push("--allowedTools", [...INTERNAS_DO_CHAT, ...p.permitidas].join(","));

  const ajustes = p.negar !== undefined && p.negar.length > 0 ? { permissions: { deny: p.negar } } : undefined;
  if (p.conta) {
    args.push(...flagsDaConta({ internas: INTERNAS_DO_CHAT, ...(ajustes ? { ajustes } : {}) }));
  } else {
    args.push("--strict-mcp-config", "--setting-sources", "", "--permission-mode", "dontAsk", "--tools", INTERNAS_DO_CHAT.join(","));
    if (ajustes) args.push("--settings", JSON.stringify(ajustes));
  }
  return args;
}

/** O que uma linha do `stream-json` vira: evento para a tela, id da conversa, ou nada. */
export function lerLinha(linha: string): { evento?: EventoDoChat; sessao?: string } {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(linha) as Record<string, unknown>;
  } catch {
    return {};
  }
  const sessao = typeof d.session_id === "string" ? d.session_id : undefined;

  if (d.type === "stream_event") {
    const e = d.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
    if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && typeof e.delta.text === "string") {
      return { evento: { tipo: "texto", delta: e.delta.text } };
    }
    return {};
  }
  if (d.type === "assistant") {
    const conteudo = (d.message as { content?: { type?: string; name?: string; input?: unknown }[] } | undefined)?.content ?? [];
    const uso = conteudo.find((c) => c.type === "tool_use" && typeof c.name === "string");
    if (uso !== undefined) return { evento: { tipo: "ferramenta", nome: uso.name!, entrada: uso.input } };
    return {};
  }
  if (d.type === "result") {
    if (d.is_error === true) {
      return { ...(sessao ? { sessao } : {}), evento: { tipo: "erro", mensagem: String(d.result ?? d.subtype ?? "falhou") } };
    }
    return { ...(sessao ? { sessao } : {}), evento: { tipo: "fim", motivo: String(d.subtype ?? "success") } };
  }
  if (d.type === "system" && d.subtype === "init") return sessao ? { sessao } : {};
  return {};
}

export type AbrirChat = (comando: string, args: string[], cwd: string) => {
  linhas: AsyncIterable<string>;
  encerrar: () => void;
  saida: Promise<number | null>;
};

const abrirProcesso: AbrirChat = (comando, args, cwd) => {
  const filho = spawn(comando, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const erro: string[] = [];
  filho.stderr.on("data", (b: Buffer) => erro.push(b.toString()));
  return {
    linhas: createInterface({ input: filho.stdout }),
    encerrar: () => filho.kill("SIGTERM"),
    saida: new Promise((resolve) => filho.on("close", (codigo) => resolve(codigo))),
  };
};

/**
 * Uma mensagem do chat pelo Claude Code, com o texto chegando aos pedaços.
 * Devolve o id da conversa para a próxima mensagem continuar dela.
 */
export async function conversarPeloClaude(
  binario: string,
  pedido: PedidoDoChat,
  emitir: (evento: EventoDoChat) => void,
  sinal?: AbortSignal,
  abrir: AbrirChat = abrirProcesso,
): Promise<{ sessao: string | undefined }> {
  const processo = abrir(binario, argsDoChat(pedido), pedido.cwd);
  const parar = (): void => processo.encerrar();
  sinal?.addEventListener("abort", parar, { once: true });

  let sessao = pedido.sessao;
  let terminou = false;
  // Texto de antes e de depois de uma ferramenta vem em blocos separados; sem
  // a quebra, a frase que anuncia a busca cola no resultado.
  let teveTexto = false;
  let quebrar = false;
  try {
    for await (const linha of processo.linhas) {
      const lido = lerLinha(linha);
      if (lido.sessao !== undefined) sessao = lido.sessao;
      const evento = lido.evento;
      if (evento === undefined) continue;
      if (evento.tipo === "fim" || evento.tipo === "erro") terminou = true;
      if (evento.tipo === "ferramenta") quebrar = teveTexto;
      if (evento.tipo === "texto") {
        if (quebrar) emitir({ tipo: "texto", delta: "\n\n" });
        quebrar = false;
        teveTexto = true;
      }
      emitir(evento);
    }
    const codigo = await processo.saida;
    if (!terminou) {
      emitir(
        sinal?.aborted
          ? { tipo: "fim", motivo: "cancelado" }
          : { tipo: "erro", mensagem: `o Claude Code saiu sem responder (código ${codigo ?? "?"})` },
      );
    }
    return { sessao };
  } finally {
    sinal?.removeEventListener("abort", parar);
  }
}
