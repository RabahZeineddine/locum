import { BrowserWindow } from "electron";
import { TERMINAL_EVENT_CHANNEL } from "./bridge-contract.js";
import { createRequire } from "node:module";
import { usarTerminalEmbutido } from "../src/services/session-service.js";
import { TerminalService, type AbrirPty, type EventoDoTerminal } from "../src/terminal/terminal-service.js";

/** Aviso de terminal novo, para a janela levar a pessoa até ele. */
export type EventoDeTerminalNaJanela = EventoDoTerminal | { id: string; tipo: "aberto"; iniciativa: string | null; titulo: string };

/**
 * O `node-pty` carrega binário nativo, e um pacote sem ele não pode impedir o
 * Locum de abrir: sem o módulo, o terminal embutido some das opções e os de
 * fora continuam valendo.
 */
function carregarPty(): AbrirPty | null {
  try {
    const require = createRequire(__filename);
    const pty = require("node-pty") as {
      spawn: (comando: string, args: string[], opcoes: Parameters<AbrirPty>[2] & { name: string }) => ReturnType<AbrirPty>;
    };
    return (comando, args, opcoes) => pty.spawn(comando, args, { name: "xterm-256color", ...opcoes });
  } catch (err) {
    console.error(`terminal embutido indisponível: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export const terminalService = new TerminalService(carregarPty());

function paraAsJanelas(evento: EventoDeTerminalNaJanela): void {
  for (const janela of BrowserWindow.getAllWindows()) {
    if (!janela.isDestroyed()) janela.webContents.send(TERMINAL_EVENT_CHANNEL, evento);
  }
}

/** Liga o serviço às janelas e às sessões da iniciativa. Chamado uma vez na subida. */
export function ligarTerminalEmbutido(): void {
  terminalService.ouvir(paraAsJanelas);
  if (!terminalService.disponivel()) return;
  usarTerminalEmbutido((entrada) => {
    const t = terminalService.abrir(entrada);
    paraAsJanelas({ id: t.id, tipo: "aberto", iniciativa: t.iniciativa, titulo: t.titulo });
  });
}
