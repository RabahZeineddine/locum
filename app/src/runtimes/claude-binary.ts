import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface ClaudeBinaryDeps {
  env: NodeJS.ProcessEnv;
  home: string;
  /** Roda o shell de login e devolve a saida padrao, ou rejeita. */
  shell: (command: string, args: string[]) => Promise<string>;
  /** Diz se o caminho existe e pode ser executado. */
  executable: (path: string) => boolean;
}

const ZSH_TIMEOUT_MS = 3_000;

function defaultShell(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const filho = execFile(command, args, { timeout: ZSH_TIMEOUT_MS, encoding: "utf8" }, (erro, stdout) => {
      if (erro) reject(erro);
      else resolve(stdout);
    });
    // `.zshrc` que pergunta alguma coisa ficaria esperando para sempre.
    filho.stdin?.end();
  });
}

function defaultExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_DEPS: ClaudeBinaryDeps = {
  env: process.env,
  home: homedir(),
  shell: defaultShell,
  executable: defaultExecutable,
};

/**
 * Caminho absoluto do `claude` desta maquina, ou `undefined`.
 *
 * O app aberto pelo Finder nao herda o PATH do terminal, entao `claude` puro
 * falha justo para quem instalou pelo `.zshrc`. A ordem: a variavel
 * `LOCUM_CLAUDE_BIN`, o `zsh` interativo e de login (onde o PATH de muita gente
 * nasce), e os lugares onde os instaladores conhecidos poem o binario.
 *
 * Todo candidato precisa ser caminho absoluto e executavel. A saida do `zsh`
 * pode ser `claude: aliased to ...`, nome de funcao ou eco de `.zshrc` falante:
 * so vale a ultima linha nao vazia, e so se passar no mesmo filtro.
 */
export async function resolveClaudeBinary(deps: Partial<ClaudeBinaryDeps> = {}): Promise<string | undefined> {
  const { env, home, shell, executable } = { ...DEFAULT_DEPS, ...deps };
  const aceita = (candidato: string | undefined): candidato is string =>
    candidato !== undefined && candidato.length > 0 && isAbsolute(candidato) && executable(candidato);

  const daVariavel = env.LOCUM_CLAUDE_BIN?.trim();
  if (aceita(daVariavel)) return daVariavel;

  try {
    const saida = await shell("/bin/zsh", ["-ilc", "command -v claude"]);
    const linhas = saida.split("\n").map((linha) => linha.trim()).filter((linha) => linha.length > 0);
    const ultima = linhas[linhas.length - 1];
    if (aceita(ultima)) return ultima;
  } catch {
    // Sem zsh, tempo esgotado ou `claude` fora do PATH: segue para a lista fixa.
  }

  const fixos = [
    join(home, ".local", "bin", "claude"),
    join(home, ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  return fixos.find(aceita);
}
