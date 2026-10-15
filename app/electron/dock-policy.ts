/**
 * Se o processo do Locum aparece no Dock.
 *
 * O Claude Code sobe `Locum --mcp` e `--ferramentas` a cada sessão, e o macOS
 * registra o ícone (e o põe em "recentes") de todo processo que nasce com
 * política Regular, antes de qualquer `dock.hide()`. Por isso o pacote nasce
 * `LSUIElement` (sem Dock) e só o modo com janela é promovido a Regular.
 */
export type PoliticaDoDock = "regular" | "accessory";

export function politicaDoDock(modo: {
  modoMcp: boolean;
  smoke: boolean;
  comandoDeCofre: boolean;
}): PoliticaDoDock {
  return modo.modoMcp || modo.smoke || modo.comandoDeCofre ? "accessory" : "regular";
}
