import { join } from "node:path";

/**
 * Como o resto do mundo sobe o Locum como servidor MCP: o registro das
 * ferramentas nativas no próprio banco e o `locum` que o Claude Code guarda.
 *
 * O comando não é "o binário que está rodando". Uma cópia do app aberta fora
 * de /Applications (a de um worktree, um release local, o DMG montado, o app
 * em quarentena) reescrevia o registro com o caminho dela, e quando a cópia
 * sumia o registro apontava para o vazio. Quem manda é o app instalado.
 */
export interface AmbienteDoApp {
  /** `process.execPath` deste processo. */
  execPath: string;
  /** Empacotado, o binário basta; em desenvolvimento ele precisa do script. */
  empacotado: boolean;
  /** O script que o Electron abre quando não está empacotado. */
  script?: string;
  home: string;
  plataforma: NodeJS.Platform;
  existe: (caminho: string) => boolean;
}

/** Onde o macOS instala o app: para todos, ou só para quem instalou. */
function pastasDoApp(env: Pick<AmbienteDoApp, "home">): string[] {
  return ["/Applications/Locum.app/", join(env.home, "Applications", "Locum.app") + "/"];
}

const BINARIO_NO_APP = "Contents/MacOS/Locum";

/** O binário do app instalado, quando existe nesta máquina. */
export function binarioInstalado(env: AmbienteDoApp): string | null {
  if (env.plataforma !== "darwin") return null;
  return pastasDoApp(env).map((p) => p + BINARIO_NO_APP).find((c) => env.existe(c)) ?? null;
}

/** Este processo é o app instalado, e não uma cópia solta ou o de desenvolvimento. */
export function esteEOInstalado(env: AmbienteDoApp): boolean {
  if (!env.empacotado) return false;
  // Fora do macOS não há como separar a cópia instalada das outras: o app
  // empacotado conta como o instalado.
  if (env.plataforma !== "darwin") return true;
  return pastasDoApp(env).some((p) => env.execPath.startsWith(p));
}

/** Um caminho de binário é o do app instalado (e não um worktree, um DMG ou um translocado). */
function ehOInstalado(env: AmbienteDoApp, caminho: string): boolean {
  if (env.plataforma !== "darwin") return true;
  return pastasDoApp(env).some((p) => caminho.startsWith(p));
}

/** O comando deste processo mesmo, com o script quando ele roda em desenvolvimento. */
export function comandoDesteProcesso(env: AmbienteDoApp, modo: "--ferramentas" | "--mcp"): string[] {
  return [env.execPath, ...(env.empacotado || env.script === undefined ? [] : [env.script]), modo];
}

/**
 * O comando que deve valer para o modo: o do app instalado, venha a decisão de
 * onde vier. Uma cópia que não é a instalada usa o caminho do app instalado se
 * ele existe, e só cai nela mesma quando não há app instalado nenhum.
 */
export function comandoDoApp(env: AmbienteDoApp, modo: "--ferramentas" | "--mcp"): string[] {
  if (esteEOInstalado(env)) return comandoDesteProcesso(env, modo);
  const instalado = binarioInstalado(env);
  return instalado === null ? comandoDesteProcesso(env, modo) : [instalado, modo];
}

export type DecisaoDoRegistro = { acao: "manter" } | { acao: "gravar"; comando: string[]; motivo: string };

/**
 * O registro atual, o que está gravado (ou nada), precisa mudar?
 *
 * Só o app instalado corrige um registro que já existe: se ele aponta para
 * binário que sumiu ou que não é o app instalado, vai para o instalado. Uma
 * cópia solta, de desenvolvimento ou de fumaça, nunca mexe em registro
 * existente (o banco pode ser o real) e só registra a si mesma quando não há
 * nada gravado: para `--ferramentas` ela usa a própria cópia, e o banco de
 * rascunho da fumaça fica com o próprio binário, não com o instalado.
 */
export function decidirRegistro(env: AmbienteDoApp, atual: string[] | null, modo: "--ferramentas" | "--mcp"): DecisaoDoRegistro {
  const semRegistro = atual === null || atual.length === 0;
  if (!esteEOInstalado(env)) {
    if (!semRegistro) return { acao: "manter" };
    return { acao: "gravar", comando: modo === "--ferramentas" ? comandoDesteProcesso(env, modo) : comandoDoApp(env, modo), motivo: "sem registro" };
  }
  const alvo = comandoDesteProcesso(env, modo);
  if (semRegistro) return { acao: "gravar", comando: alvo, motivo: "sem registro" };
  if (JSON.stringify(atual) === JSON.stringify(alvo)) return { acao: "manter" };
  if (!env.existe(atual[0]!)) return { acao: "gravar", comando: alvo, motivo: "o binario registrado nao existe mais" };
  if (!ehOInstalado(env, atual[0]!)) return { acao: "gravar", comando: alvo, motivo: "o registro aponta para uma copia que nao e o app instalado" };
  return { acao: "manter" };
}
