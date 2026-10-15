/**
 * A mensagem de um erro que veio do processo principal, sem o prefixo que o
 * Electron coloca ("Error invoking remote method 'canal': Error: ..."), para a
 * pessoa ler só o que o serviço disse.
 */
export function semPrefixoDoIpc(mensagem: string): string {
  return mensagem.replace(/^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/, "");
}
