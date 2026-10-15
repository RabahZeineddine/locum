/**
 * Se o processo do Locum aparece no Dock.
 *
 * O Claude Code sobe `Locum --mcp` e `--ferramentas` a cada sessão, e o macOS
 * registra o ícone (e o põe em "recentes") de todo processo que nasce com
 * política Regular, antes de qualquer `dock.hide()`. Por isso o pacote nasce
 * `LSUIElement` (sem Dock) e só o modo com janela é promovido a Regular.
 */
export type PoliticaDoDock = "regular" | "accessory";

/** `--set-secret` e `--remove-secret` mexem no cofre e saem, sem janela. */
export function ehComandoDeCofre(argv: readonly string[]): boolean {
  return argv.includes("--set-secret") || argv.includes("--remove-secret");
}

export function politicaDoDock(argv: readonly string[]): PoliticaDoDock {
  const semJanela =
    argv.includes("--mcp") || argv.includes("--ferramentas") || argv.includes("--smoke") || ehComandoDeCofre(argv);
  return semJanela ? "accessory" : "regular";
}
