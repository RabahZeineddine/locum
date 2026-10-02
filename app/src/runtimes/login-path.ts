import { execFile } from "node:child_process";
import { delimiter, isAbsolute } from "node:path";

const ZSH_TIMEOUT_MS = 3_000;

/** Marca em volta do PATH, para separar do eco de um `.zshrc` falante. */
const MARCA = "__LOCUM_PATH__";

export interface LoginPathDeps {
  /** Roda o shell de login e devolve a saida padrao, ou rejeita. */
  shell: (command: string, args: string[]) => Promise<string>;
}

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

/**
 * O PATH que o terminal da pessoa enxerga, ou `undefined`.
 *
 * Lido do `zsh` interativo e de login, onde o PATH de muita gente nasce. A
 * saida vem entre marcas porque `.zshrc` pode imprimir qualquer coisa antes e
 * depois; o que estiver fora delas e descartado.
 */
export async function readLoginPath(deps: Partial<LoginPathDeps> = {}): Promise<string | undefined> {
  const shell = deps.shell ?? defaultShell;
  try {
    const saida = await shell("/bin/zsh", ["-ilc", `printf '${MARCA}%s${MARCA}' "$PATH"`]);
    const inicio = saida.indexOf(MARCA);
    const fim = saida.indexOf(MARCA, inicio + MARCA.length);
    if (inicio === -1 || fim === -1) return undefined;
    const path = saida.slice(inicio + MARCA.length, fim).trim();
    return path.length > 0 ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Junta ao PATH atual as pastas do PATH de login que faltam, na ordem dele.
 *
 * O atual vem primeiro: quem abriu pelo terminal ja tem tudo, e quem abriu pelo
 * Finder tem so as pastas do sistema, que continuam valendo. So entra pasta
 * absoluta, para que um `.` no PATH de alguem nao faca o app rodar binario da
 * pasta em que estiver.
 */
export function mergePath(atual: string | undefined, login: string | undefined): string {
  const pastas = (atual ?? "").split(delimiter).filter((p) => p.length > 0);
  for (const pasta of (login ?? "").split(delimiter)) {
    if (pasta.length > 0 && isAbsolute(pasta) && !pastas.includes(pasta)) pastas.push(pasta);
  }
  return pastas.join(delimiter);
}
