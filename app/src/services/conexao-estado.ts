/**
 * O estado de uma conexão que é um servidor MCP cadastrado. Uma regra só, que
 * a lista, o cabeçalho do detalhe e o ponto do servidor leem: duas cópias
 * dela já chegaram a dizer "conectado" e "ainda sem teste" na mesma tela.
 */

/**
 * `attention`: falta uma ação da pessoa (autorizar, religar). `error`: o
 * servidor foi procurado e falhou, e `detail` traz o que ele respondeu. `off`:
 * cadastrado e ainda não ligado (o importado entra assim), que é neutro e não
 * pede atenção de ninguém.
 */
export type ConnectionState = "connected" | "attention" | "error" | "off" | "available" | "soon";

/**
 * Por que a conexão não está ok. A tela traduz o código; o texto cru da falha
 * vai em `detail`. `untested` não é problema: está ligada e autorizada, mas
 * nunca foi procurada. `no-credential`: o cadastro referencia uma credencial
 * que não existe (o token não foi colado), e subir o servidor só daria 401.
 * `no-token`: o GitHub tem servidor de pé, mas falta o token que os gatilhos usam.
 */
export type ConnectionReason = "needs-auth" | "no-credential" | "no-token" | "disabled" | "failing" | "untested";

/** O que o cadastro sabe da última vez que o servidor foi procurado. */
export interface SaudeBruta {
  lastOkAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  needsAuth: boolean;
}

export type SaudeDoServidor = "auth" | "failed" | "ok" | "untested";

/** Credencial recusada, falha depois do último sucesso, respondeu, ou nunca foi testado. */
export function saudeDoServidor(saude: SaudeBruta): SaudeDoServidor {
  if (saude.needsAuth) return "auth";
  const falhando = saude.lastFailureAt !== null && (saude.lastOkAt === null || saude.lastFailureAt > saude.lastOkAt);
  if (falhando) return "failed";
  return saude.lastOkAt !== null ? "ok" : "untested";
}

/**
 * A ordem é a da ação que a pessoa tem a fazer: ligar, depois autorizar, e só
 * então olhar a falha. Credencial recusada é autorização, não erro: o remédio é
 * reconectar, e dizer "erro" mandaria a pessoa procurar o que não quebrou.
 */
export function estadoDoServidor(
  servidor: { enabled: boolean; health: SaudeBruta },
  autorizado: boolean,
  semCredencial = false,
): { state: ConnectionState; reason: ConnectionReason | null; detail: string | null } {
  if (!servidor.enabled) return { state: "off", reason: "disabled", detail: null };
  if (semCredencial) return { state: "attention", reason: "no-credential", detail: null };
  const saude = saudeDoServidor(servidor.health);
  if (!autorizado || saude === "auth") return { state: "attention", reason: "needs-auth", detail: null };
  if (saude === "failed") return { state: "error", reason: "failing", detail: servidor.health.lastError };
  if (saude === "untested") return { state: "connected", reason: "untested", detail: null };
  return { state: "connected", reason: null, detail: null };
}
