import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Uma pasta `~/.claude` de mentira, com uma sessão de cada jeito.
 *
 * Os testes e a fumaça leem daqui, nunca da pasta de quem roda: o que está lá
 * é conversa de trabalho de verdade, e um exame que dependesse dela passaria
 * numa máquina e quebraria na outra.
 */
export const SESSOES_DE_EXEMPLO = {
  /** Fechada no meio de uma ferramenta. */
  interrompida: "11111111-1111-4111-8111-111111111111",
  /** Fechada depois de uma resposta que termina em pergunta. */
  pelaMetade: "22222222-2222-4222-8222-222222222222",
  /** Com processo vivo, o Claude trabalhando. */
  aberta: "33333333-3333-4333-8333-333333333333",
  /** Chamada por programa, que a lista ignora. */
  programatica: "44444444-4444-4444-8444-444444444444",
} as const;

function linha(dados: Record<string, unknown>): string {
  return JSON.stringify(dados);
}

function escrever(pasta: string, id: string, linhas: string[], segundos: number): void {
  const arquivo = join(pasta, `${id}.jsonl`);
  writeFileSync(arquivo, `${linhas.join("\n")}\n`);
  utimesSync(arquivo, segundos, segundos);
}

/**
 * Escreve a pasta e devolve o caminho dela. `pidVivo` é o processo que o
 * registro aponta para a sessão aberta: o próprio processo de quem chama serve,
 * porque ele está vivo enquanto o exame roda.
 */
export function escreverSessoesDeExemplo(claudeDir: string, cwd: string, pidVivo: number, agora = Date.now()): string {
  const projeto = join(claudeDir, "projects", "-exemplo");
  mkdirSync(projeto, { recursive: true });
  mkdirSync(join(claudeDir, "sessions"), { recursive: true });
  const s = Math.floor(agora / 1000);
  const quando = (atras: number) => new Date((s - atras) * 1000).toISOString();
  const base = { cwd, gitBranch: "main", entrypoint: "cli" };

  escrever(
    projeto,
    SESSOES_DE_EXEMPLO.interrompida,
    [
      linha({ ...base, type: "user", timestamp: quando(7200), message: { role: "user", content: "Corrigir o teste de datas" } }),
      linha({ type: "ai-title", aiTitle: "Corrigir teste de datas", sessionId: SESSOES_DE_EXEMPLO.interrompida }),
      linha({
        ...base,
        type: "assistant",
        timestamp: quando(7100),
        message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "Vou rodar a suíte." }, { type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      }),
    ],
    s - 7100,
  );

  escrever(
    projeto,
    SESSOES_DE_EXEMPLO.pelaMetade,
    [
      linha({ ...base, type: "user", timestamp: quando(90_000), message: { role: "user", content: "<command-name>/clear</command-name>" } }),
      linha({ ...base, type: "user", timestamp: quando(89_000), message: { role: "user", content: [{ type: "text", text: "Revisar a tela de login" }] } }),
      linha({
        ...base,
        type: "assistant",
        timestamp: quando(88_000),
        message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Revisei. Quer que eu aplique as três correções?" }] },
      }),
    ],
    s - 88_000,
  );

  escrever(
    projeto,
    SESSOES_DE_EXEMPLO.aberta,
    [
      linha({ ...base, type: "user", timestamp: quando(300), message: { role: "user", content: "Escrever a migração" } }),
      linha({ ...base, type: "assistant", timestamp: quando(60), message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "Escrevendo." }] } }),
    ],
    s - 60,
  );
  writeFileSync(
    join(claudeDir, "sessions", `${pidVivo}.json`),
    linha({ pid: pidVivo, sessionId: SESSOES_DE_EXEMPLO.aberta, cwd, kind: "interactive", entrypoint: "cli", status: "busy", startedAt: (s - 300) * 1000 }),
  );

  escrever(
    projeto,
    SESSOES_DE_EXEMPLO.programatica,
    [
      linha({ ...base, entrypoint: "sdk-cli", type: "user", timestamp: quando(500), message: { role: "user", content: "Revise este diff" } }),
      linha({ ...base, entrypoint: "sdk-cli", type: "assistant", timestamp: quando(400), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Feito." }] } }),
    ],
    s - 400,
  );

  return claudeDir;
}
