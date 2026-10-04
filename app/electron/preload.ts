import { contextBridge, ipcRenderer } from "electron";
import {
  BRIDGE_CHANNELS,
  BRIDGE_GLOBAL,
  CHAT_EVENT_CHANNEL,
  TERMINAL_EVENT_CHANNEL,
  type LocumBridge,
} from "./bridge-contract.js";

/**
 * O preload, que e a unica coisa que a janela ganha do lado de ca.
 *
 * Ele roda em sandbox, com `contextIsolation`, e por isso so pode importar do
 * proprio Electron. Nada de `src/` entra aqui: o que existe e um encaminhador
 * de canal, montado a partir da lista do contrato. Sem canal generico de
 * proposito, porque um `invoke(qualquer, ...)` exposto seria a ponte inteira
 * outra vez, sem tipo e sem lista de quem pode o que.
 */
const bridge: Record<string, Record<string, unknown>> = {};

for (const channel of BRIDGE_CHANNELS) {
  const [group, member] = channel.split(".") as [string, string];
  bridge[group] ??= {};
  // O `...args` nao e checado aqui: quem valida e o servico do outro lado, que
  // ja e o dono da regra. Duplicar a validacao no preload criaria uma segunda
  // versao dela para sair de sincronia.
  bridge[group][member] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
}

// Assinatura do fluxo do chat. Um canal fixo, sem nome vindo da janela, para
// que a janela nao consiga escutar qualquer coisa que trafegue no IPC.
bridge["chat"] ??= {};
bridge["chat"]["onEvent"] = (ouvinte: (evento: unknown) => void) => {
  const encaminha = (_e: unknown, evento: unknown) => ouvinte(evento);
  ipcRenderer.on(CHAT_EVENT_CHANNEL, encaminha);
  return () => ipcRenderer.removeListener(CHAT_EVENT_CHANNEL, encaminha);
};

// Saída dos terminais embutidos, pelo mesmo motivo: canal fixo.
bridge["terminal"] ??= {};
bridge["terminal"]["onEvent"] = (ouvinte: (evento: unknown) => void) => {
  const encaminha = (_e: unknown, evento: unknown) => ouvinte(evento);
  ipcRenderer.on(TERMINAL_EVENT_CHANNEL, encaminha);
  return () => ipcRenderer.removeListener(TERMINAL_EVENT_CHANNEL, encaminha);
};

contextBridge.exposeInMainWorld(BRIDGE_GLOBAL, bridge as unknown as LocumBridge);
