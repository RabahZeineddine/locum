/**
 * O estado da atualização como a janela o enxerga.
 *
 * Mora fora de `electron/updater.ts` porque o contrato da ponte é lido também
 * pelo renderer, e o renderer não pode puxar o módulo que importa o Electron.
 */

/**
 * Por que o verificador não subiu, quando não subiu.
 *
 * `dev` é rodar do repositório: quem tem o código atualiza por `git pull`, e o
 * smoke não pode sair para a rede por acidente. `not-replaceable` é o bundle
 * que não dá para trocar, aberto de dentro do `.dmg` ou translocado.
 */
export type MotivoDaRecusa = "disabled" | "dev" | "not-replaceable" | null;

export type FaseDaAtualizacao = "idle" | "checking" | "downloading" | "ready" | "uptodate" | "failed";

export interface UpdaterState {
  current: string;
  /** `null` quando ninguém decidiu ainda. */
  preference: boolean | null;
  /** O que vale agora. Sem decisão, vale ligado. */
  enabled: boolean;
  /** Se o verificador foi de fato armado nesta subida. */
  armed: boolean;
  reason: MotivoDaRecusa;
  /** O porquê em palavras, quando o motivo é o bundle. */
  detail: string | null;
  phase: FaseDaAtualizacao;
  lastCheckAt: number | null;
  /** A versão baixada e esperando, ou a que está baixando. */
  available: { version: string; notes: string } | null;
  error: string | null;
  /**
   * Falha de rede tem tipo: sem conexão é o caso comum (Wi-Fi que caiu) e não
   * pede nada da pessoa, então a tela diz isso em vez do código do Chromium.
   */
  errorKind: "offline" | "timeout" | "rede" | null;
}

