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
 * O registro atual, o que está gravado (ou nada), precisa mudar? Regras:
 *
 * - O app instalado corrige o registro que aponta para binário que não existe
 *   mais ou que não é o app instalado.
 * - Uma cópia fora de /Applications não reescreve um registro que funciona.
 *   Com o app instalado na máquina, ela o corrige para apontar para ele, e
 *   não para ela.
 * - Sem registro, qualquer cópia registra, para quem só tem o app de
 *   desenvolvimento ter as ferramentas.
 */
export function decidirRegistro(env: AmbienteDoApp, atual: string[] | null, modo: "--ferramentas" | "--mcp"): DecisaoDoRegistro {
  const alvo = comandoDoApp(env, modo);
  if (atual === null || atual.length === 0) return { acao: "gravar", comando: alvo, motivo: "sem registro" };

  const mesmo = JSON.stringify(atual) === JSON.stringify(alvo);
  if (mesmo) return { acao: "manter" };

  const existe = env.existe(atual[0]!);
  const doInstalado = ehOInstalado(env, atual[0]!);
  if (!existe) return { acao: "gravar", comando: alvo, motivo: "o binario registrado nao existe mais" };

  if (esteEOInstalado(env)) {
    // Aponta para uma cópia que existe mas não é o app instalado: o instalado corrige.
    return doInstalado ? { acao: "manter" } : { acao: "gravar", comando: alvo, motivo: "o registro aponta para uma copia que nao e o app instalado" };
  }
  // Cópia solta: só mexe se há app instalado para onde apontar e o registro não é ele.
  const instalado = binarioInstalado(env);
  if (instalado !== null && !doInstalado) {
    return { acao: "gravar", comando: alvo, motivo: "o registro aponta para uma copia que nao e o app instalado" };
  }
  return { acao: "manter" };
}
