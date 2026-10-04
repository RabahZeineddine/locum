/**
 * Com `--mcp`, o stdout do processo é o canal do protocolo, e qualquer
 * `console.log` perdido no caminho (migração, idioma, cofre) corrompe a sessão
 * do cliente. Este módulo é o primeiro import do `main.ts` justamente para
 * desviar o log antes de qualquer outro módulo ter a chance de escrever.
 */
/** O servidor das ferramentas nativas, que os agents usam. Mesmo cuidado com o stdout. */
export const modoFerramentas = process.argv.includes("--ferramentas");
export const modoMcp = process.argv.includes("--mcp") || modoFerramentas;

if (modoMcp) {
  const paraStderr = (...args: unknown[]): void => console.error(...args);
  console.log = paraStderr;
  console.info = paraStderr;
  console.debug = paraStderr;
}
