import { BrowserWindow } from "electron";
import { dbPath } from "../src/db/path.js";
import { DADOS_EVENT_CHANNEL } from "./bridge-contract.js";
import {
  abrirObservadorDoBanco,
  criarDetectorDeMudanca,
  type DetectorDeMudanca,
} from "../src/services/mudanca-de-dados.js";

/** Manda o aviso `dados:mudou` a todas as janelas abertas. */
export function avisarMudancaDeDados(areas: string[] = ["*"]): void {
  for (const janela of BrowserWindow.getAllWindows()) {
    if (!janela.isDestroyed()) janela.webContents.send(DADOS_EVENT_CHANNEL, areas);
  }
}

/**
 * Liga o vigia do banco: a cada segundo confere o `data_version` e, se mudou,
 * avisa as janelas. Pega a escrita do `Locum --mcp` e a do scheduler/executor
 * (conexões próprias), que nenhuma tela dispararia. Devolve quem desliga.
 */
export function ligarAvisoDeDados(): () => void {
  const observador = abrirObservadorDoBanco(dbPath(), process.env.LOCUM_SQLITE_BINDING || undefined);
  const detector: DetectorDeMudanca = criarDetectorDeMudanca({
    lerVersao: observador.lerVersao,
    aoMudar: avisarMudancaDeDados,
  });
  detector.iniciar();
  return () => {
    detector.parar();
    observador.fechar();
  };
}
