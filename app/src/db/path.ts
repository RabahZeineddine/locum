import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";

/**
 * Processo de teste: o runner do Node (`--test` ou o filho que ele sobe) ou um
 * arquivo `*.test.ts` rodado direto. Sem `LOCUM_HOME` ele não pode cair na
 * pasta de verdade: um teste rodado sozinho, sem `test/setup.ts`, já encheu o
 * banco do dono da máquina de automações de mentira, algumas ligadas.
 */
export function ehProcessoDeTeste(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
  execArgv: readonly string[] = process.execArgv,
): boolean {
  if (env.NODE_TEST_CONTEXT !== undefined) return true;
  if (execArgv.some((a) => a === "--test" || a.startsWith("--test-"))) return true;
  return argv.slice(1).some((a) => /\.test\.[cm]?[jt]sx?$/.test(a));
}

/** Pasta de dados do app. Fora do repo, porque banco nao e codigo. */
export function appHome(): string {
  const custom = process.env.LOCUM_HOME;
  if ((custom === undefined || custom.length === 0) && ehProcessoDeTeste()) {
    throw new Error("teste sem LOCUM_HOME: rode pelo `npm test`, que carrega test/setup.ts, ou defina LOCUM_HOME numa pasta temporária");
  }
  const dir =
    custom && custom.length > 0
      ? custom
      : join(homedir(), "Library", "Application Support", "locum");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbPath(): string {
  return join(appHome(), "watchers.db");
}

export interface SmokeHome {
  dir: string;
  /** Criada aqui, e por isso apagada no fim. */
  temporary: boolean;
  cleanup(): void;
}

/**
 * Pasta de dados da fumaça.
 *
 * A fumaça planta pendência, execução e cadastro sintéticos, e rodada à mão na
 * árvore principal caía no banco de verdade: foi assim que "PR Review, passo
 * Comentar no PR" apareceu na inbox misturado com dado real. Sem `LOCUM_HOME`
 * ela ganha um rascunho vazio, apagado na saída. Com ele, quem chamou já
 * escolheu onde, como o loop faz, e a pasta fica.
 *
 * Precisa rodar antes de qualquer import do núcleo, que abre o banco no import.
 */
function definirPastaDeIniciativas(env: NodeJS.ProcessEnv, dir: string): void {
  if (env.LOCUM_INITIATIVES_DIR && env.LOCUM_INITIATIVES_DIR.length > 0) return;
  env.LOCUM_INITIATIVES_DIR = join(dir, "initiatives");
}

export function smokeHome(env: NodeJS.ProcessEnv = process.env): SmokeHome {
  const escolhida = env.LOCUM_HOME;
  if (escolhida && escolhida.length > 0) {
    definirPastaDeIniciativas(env, escolhida);
    return { dir: escolhida, temporary: false, cleanup: () => {} };
  }
  const dir = mkdtempSync(join(tmpdir(), "locum-smoke-"));
  env.LOCUM_HOME = dir;
  definirPastaDeIniciativas(env, dir);
  return { dir, temporary: true, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
