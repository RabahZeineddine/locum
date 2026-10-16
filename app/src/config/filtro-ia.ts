/**
 * Provedores que não rodam um passo sem ferramentas: o Codex exige o próprio
 * ambiente de execução e não devolve saída estruturada de um prompt solto.
 * Mora em `config` porque a tela de escolha de modelo também lê.
 */
export const PROVEDORES_FORA_DO_FILTRO: readonly string[] = ["codex"];
