import { app, Menu, nativeImage, Tray } from "electron";
import { t } from "./i18n.js";
import { VERSAO } from "./versao.js";
import { approvalService } from "../src/services/approval-service.js";

// O icone vive em base64 aqui dentro em vez de num arquivo porque o build
// empacota o processo principal num unico dist/main.cjs, e um PNG solto
// exigiria um passo de copia so para ele. E template image: o macOS olha so o
// alfa e inverte a cor sozinho conforme o tema da barra. O desenho e o mesmo do
// icone do app reduzido ao que cabe em 16 pixels: o Locum solido na frente e,
// atras, em contorno, a pessoa que ele substitui. A versao de 32 e a da tela
// Retina.
const ICON_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABQ0lEQVR42o3SvUtcURAF8N+uq8KmCRaipSAECYqFjYJfKGi7qQL+AWIf+5DK0jZiY2UhWNqKoI0gaK2FFkIgSNJEWNF9NvPketmNXpj33n33nJkz5w7/X5W3/nW9QS5Qx1eM4woPHRK/ItYi6jiJRAVO8SEwlfdIbgRxDtPx3Yiz2ssjk9yFRTRxjmuM4T5w/+Jd5JUr+IjjRPJO9F7ud6NoNZdeKvkWwGaYVeALRjHZrtValmgQrQjoxjD2E/xTLl8iaQKPieS/0VYn/CvXq1F5BmtB/okRLEXCI+yFkdVEadtr/IyzIN5FFLgJpXIzK4knNRziEvMB7MYsbvEb/WnBtPIAFrAcoHz1hU8bObkXm/iTmPgLP+J8Fd+xHm1clNxS3kFCfAqDyv02hmKoxvAJW+gpVawkA9TKEpUDNZW10gvPMpBTQvpCNIAAAAAASUVORK5CYII=";
const ICON_2X_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAC8UlEQVR42t3WTYgcVRAH8F/PzGbiKhpBsgFBD0GICH4cJFGCQYgHD4qCoB5E0KPgKXgRDCiIHoSczCHgxY8oJgZUclD8QhCFQERRMRo9iRHBb9E4O9te6kHR9PZMejcefFB09+t6r/5V719Vj//JGGCYvocx958Z7/NvXY1fiQM4jo/xDK452yDKxrfjL9QNOY07zxaIASpcgj9bjBf5G1u7QAzWAKDGvVjEFJ9iO66No5hijPvXIwoVRknGMfcalgPMLUn/pphbwespM3pFYBibLSc5HXNfpP+XpTXlvRzDqmM0R6inWMIdwfYJPsARPBQEfASPYnN4/WDoLeCNFMVeLL8NP7QQ7JMABM82/k2TzmIi7dyjnNeOtNk/4dUk3mt8F15fFKHOIN6PLOlFwLLg7WS8Lc9rPBG6N2JvyM0NAvcyvhQ5vhLSBLAc88c7PJxpvIuEF+Kc2KReZfMKF8RzkDKiTqDPuJGURafwa8cmxcip4Ingx3Lijb4AhvgFR8O7SYveNNYfTNEcplZcrVet/z6lVsmClcT0xRnZNFhrt9uG91oI+CLODZ2NoXcDduHymNNVhs/0iHbgPtyDK2LufOzD1xGZDPAb7MdVa0nJriLyAE52tOIiEzyZotCbG6Oo7RtwuMXQV3gz5EQjGnV0zvFaCDoIEIeSZzVexc4AVsYCrscroVNuTC/04UQVG47isnEMn+F3PNwCsnlke1JbrnH3vCCqGUrnNfK/SutKtEpUnkqpfCLmK1RVR7hX4n0cnl+NLbHRt/gQnzeIVXfsdxKXhu5uvLWag8NkeA++7GD4R7grrd0QRpaSXBwt++lUvh9PXFm1+BxrNJZJQzKQQ9gUAJ6PHvIzfkvyR6qiLxdnq5awb8O7gX4yo5yWVj2KI9kd31vjWTU4NYms+QnX5SMoxFmMi2bd4mWXlMvJS3Nk1VE818yE8vJYxw1onopX49ZwZiGlZZZx8x5SwrQJP0aqTHsAKDekd1JEZ45/AX9vHwqUvhb1AAAAAElFTkSuQmCC";

const REFRESH_MS = 15_000;

let tray: Tray | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let openWindow: (() => void) | null = null;
let pendingCount = 0;
let paused = false;

export interface TrayHandlers {
  /** Chamado pelo item Abrir do menu. */
  openWindow: () => void;
}

/**
 * Pausa global, so na memoria deste processo.
 *
 * Nao vai para o banco de proposito: pausar e uma decisao sobre esta sessao da
 * maquina, e gravar isso apagaria a diferenca entre "o dono pausou agora" e
 * "este gatilho esta desabilitado", que e outra coisa e mora na tabela de
 * gatilhos. Quem dispara trabalho no processo principal consulta esta funcao
 * antes de comecar: hoje e a batida de acordar, em electron/power.ts.
 */
export function isPaused(): boolean {
  return paused;
}

/** Ultima contagem lida da fila, sem tocar no banco. */
export function trayPendingCount(): number {
  return pendingCount;
}

export async function setupTray(handlers: TrayHandlers): Promise<Tray> {
  openWindow = handlers.openWindow;

  const image = nativeImage.createFromDataURL(`data:image/png;base64,${ICON_BASE64}`);
  // Base64 corrompido nao levanta erro: vira imagem vazia, e a bandeja fica
  // invisivel na barra sem ninguem perceber.
  if (image.isEmpty()) throw new Error("icone da bandeja nao decodificou");
  image.addRepresentation({ scaleFactor: 2, dataURL: `data:image/png;base64,${ICON_2X_BASE64}` });
  image.setTemplateImage(true);

  tray = new Tray(image);
  tray.setToolTip("Locum");
  await refreshTray();

  // A fila tambem muda fora deste processo: a linha de comando e o servidor MCP
  // gravam no mesmo banco. Sem evento para escutar, sobra reler de tempos em
  // tempos. Quem mexer na fila aqui dentro chama refreshTray() na hora, e nao
  // espera a proxima leitura.
  refreshTimer = setInterval(() => void refreshTray(), REFRESH_MS);

  return tray;
}

/** Rele a fila e reescreve contagem e menu. Devolve quantas pendencias ha. */
export async function refreshTray(): Promise<number> {
  pendingCount = (await approvalService.listPending()).length;

  if (tray !== null && !tray.isDestroyed()) {
    tray.setTitle(pendingCount > 0 ? String(pendingCount) : "");
    tray.setContextMenu(buildMenu());
  }

  return pendingCount;
}

export function teardownTray(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  tray?.destroy();
  tray = null;
}

/** Os rotulos do menu como ele esta agora. Serve ao smoke, que nao clica. */
export function trayMenuLabels(): string[] {
  return buildMenu().items.map((item) => item.label);
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      // Fila vazia e outra frase, e nao outra forma de plural: quem decide e o
      // `_zero` do dicionario, junto das demais formas, e nao um ternario aqui.
      label: t("tray.pending", { count: pendingCount }),
      enabled: false,
    },
    { type: "separator" },
    { label: t("tray.open"), click: () => openWindow?.() },
    {
      label: t(paused ? "tray.resume" : "tray.pause"),
      click: () => {
        paused = !paused;
        void refreshTray();
      },
    },
    { type: "separator" },
    { label: t("tray.version", { version: VERSAO }), enabled: false },
    { label: t("menu.app.about"), click: () => app.showAboutPanel() },
    { type: "separator" },
    { label: t("tray.quit"), click: () => app.quit() },
  ]);
}
