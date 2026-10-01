import type { AgentSpec } from "../../src/config/types.js";
import { BRIDGE_GLOBAL } from "../../electron/bridge-contract.js";

/**
 * Acesso estreito à gravação de agent, com autoridade de pessoa.
 *
 * Fica fora de `lib/bridge.ts` pelo mesmo motivo de `lib/aprovar.ts`. Gravar
 * como pessoa pode subir o modo de um passo de ação para automático, e subir o
 * modo e depois executar é publicar sem clique em dois passos. Esta gravação é
 * o clique de quem editou, e só os botões de salvar, duplicar, importar,
 * exportar e o da resposta pronta chamam daqui.
 */
interface PonteDeEdicao {
  agents: {
    saveEdited: (agentId: string, spec: AgentSpec, note: string) => Promise<{ version: number }>;
    duplicate: (fromId: string, newId: string, newName: string) => Promise<{ agentId: string }>;
    importFile: () => Promise<{ agentId: string; version: number; created: boolean } | null>;
    exportFile: (agentId: string) => Promise<string | null>;
    installReply: (service: "slack" | "teams") => Promise<{ agentId: string; created: boolean }>;
  };
}

function ponte(): PonteDeEdicao {
  const achada = (globalThis as Record<string, unknown>)[BRIDGE_GLOBAL] as PonteDeEdicao | undefined;
  if (!achada?.agents?.saveEdited) throw new Error("ponte indisponivel");
  return achada;
}

export async function salvarAgent(agentId: string, spec: AgentSpec, note: string): Promise<number> {
  return (await ponte().agents.saveEdited(agentId, spec, note)).version;
}

export async function duplicarAgent(fromId: string, newId: string, newName: string): Promise<string> {
  return (await ponte().agents.duplicate(fromId, newId, newName)).agentId;
}

/** Abre o seletor de arquivo e grava o agent. `null` quando a pessoa cancela. */
export async function importarAgent(): Promise<{ agentId: string; version: number; created: boolean } | null> {
  return ponte().agents.importFile();
}

/** Salva o spec mais recente em arquivo. Devolve o caminho, ou `null`. */
export async function exportarAgent(agentId: string): Promise<string | null> {
  return ponte().agents.exportFile(agentId);
}

/** Grava o agent de resposta pronto do serviço, se ainda não existe. */
export async function instalarResposta(service: "slack" | "teams"): Promise<string> {
  return (await ponte().agents.installReply(service)).agentId;
}
