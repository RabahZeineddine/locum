import { app, dialog, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import { t } from "./i18n.js";
import { VERSAO } from "./versao.js";

/**
 * O menu da aplicação, o que todo app de Mac tem na barra do topo.
 *
 * Sem ele valia o menu padrão do Electron: em inglês, com "Toggle Developer
 * Tools" para quem instalou, e sem o Editar traduzido que faz ⌘C e ⌘V
 * funcionarem nos campos. Os papéis (`role`) dão o comportamento do sistema; o
 * rótulo vem do dicionário, porque o Electron escreve os papéis em inglês.
 */

export const REPO_URL = "https://github.com/RabahZeineddine/locum";

/** Os destinos da janela, na ordem da barra lateral, com o atalho de cada um. */
const DESTINOS = [
  { id: "inbox", rotulo: "nav.home" },
  { id: "execucoes", rotulo: "nav.runs" },
  { id: "agents", rotulo: "nav.agents" },
  { id: "configuracao", rotulo: "nav.settings" },
] as const;

export interface OpcoesDoMenu {
  /** Traz a janela, criando se preciso. É o `ensureWindow` do processo principal. */
  janela: () => Promise<BrowserWindow>;
}

let opcoes: OpcoesDoMenu | null = null;

export function setupAppMenu(o: OpcoesDoMenu): void {
  opcoes = o;
  refreshAppMenu();
}

/** Remonta menu e painel "Sobre" no idioma de agora. A troca de idioma chama. */
export function refreshAppMenu(): void {
  if (opcoes === null) return;
  app.setAboutPanelOptions({
    applicationName: "Locum",
    applicationVersion: VERSAO,
    // Sem isto o macOS repete a versão entre parênteses, como se fosse build.
    version: "",
    copyright: t("about.copyright", { year: new Date().getFullYear() }),
    credits: t("about.credits"),
    website: REPO_URL,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(modelo()));
}

/** Os títulos do topo, na ordem. Serve à fumaça, que não abre menu. */
export function appMenuLabels(): string[] {
  return Menu.getApplicationMenu()?.items.map((i) => i.label) ?? [];
}

async function irPara(id: string): Promise<void> {
  if (opcoes === null) return;
  const janela = await opcoes.janela();
  janela.show();
  janela.focus();
  await janela.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`#/${id}`)}`);
}

/**
 * Pergunta ao GitHub na hora e diz o resultado num diálogo, que é o que se
 * espera de "Procurar atualizações…" num app de Mac.
 */
async function procurarAtualizacoes(): Promise<void> {
  const updater = await import("./updater.js");
  await updater.conferir().catch(() => undefined);
  const estado = await updater.updaterState();

  const mensagem =
    estado.reason !== null
      ? t(`settings.updates.reason.${estado.reason}`, { detail: estado.detail ?? "" })
      : estado.phase === "ready"
        ? t("menu.updates.ready", { version: estado.available?.version ?? "" })
        : estado.phase === "failed"
          ? t("menu.updates.failed", { error: estado.error ?? "" })
          : t("menu.updates.upToDate", { version: estado.current });

  const botoes = estado.phase === "ready" ? [t("menu.updates.restart"), t("menu.updates.later")] : ["OK"];
  const { response } = await dialog.showMessageBox({
    type: estado.phase === "failed" ? "warning" : "info",
    message: t("menu.updates.title"),
    detail: mensagem,
    buttons: botoes,
    defaultId: 0,
  });
  if (estado.phase === "ready" && response === 0) updater.aplicarAgora();
}

function modelo(): MenuItemConstructorOptions[] {
  const versao = VERSAO;
  const desenvolvendo = !app.isPackaged;

  return [
    {
      label: "Locum",
      submenu: [
        { label: t("menu.app.about"), role: "about" },
        { label: t("menu.app.checkUpdates"), click: () => void procurarAtualizacoes() },
        { type: "separator" },
        { label: t("menu.app.settings"), accelerator: "CmdOrCtrl+,", click: () => void irPara("configuracao") },
        { type: "separator" },
        { label: t("menu.app.services"), role: "services" },
        { type: "separator" },
        { label: t("menu.app.hide"), role: "hide" },
        { label: t("menu.app.hideOthers"), role: "hideOthers" },
        { label: t("menu.app.unhide"), role: "unhide" },
        { type: "separator" },
        { label: t("menu.app.quit"), role: "quit" },
      ],
    },
    {
      label: t("menu.edit.title"),
      submenu: [
        { label: t("menu.edit.undo"), role: "undo" },
        { label: t("menu.edit.redo"), role: "redo" },
        { type: "separator" },
        { label: t("menu.edit.cut"), role: "cut" },
        { label: t("menu.edit.copy"), role: "copy" },
        { label: t("menu.edit.paste"), role: "paste" },
        { label: t("menu.edit.selectAll"), role: "selectAll" },
      ],
    },
    {
      label: t("menu.view.title"),
      submenu: [
        ...DESTINOS.map(
          (d, i): MenuItemConstructorOptions => ({
            label: t(d.rotulo),
            accelerator: `CmdOrCtrl+${i + 1}`,
            click: () => void irPara(d.id),
          }),
        ),
        { type: "separator" },
        { label: t("menu.view.resetZoom"), role: "resetZoom" },
        { label: t("menu.view.zoomIn"), role: "zoomIn" },
        { label: t("menu.view.zoomOut"), role: "zoomOut" },
        { type: "separator" },
        { label: t("menu.view.fullScreen"), role: "togglefullscreen" },
        // Recarregar e inspecionar só para quem roda do código: no app
        // instalado, um ⌘R por engano recarregaria a janela no meio de uma
        // revisão, e as ferramentas de desenvolvedor não servem a quem usa.
        ...(desenvolvendo
          ? ([
              { type: "separator" },
              { label: t("menu.view.reload"), role: "reload" },
              { label: t("menu.view.devTools"), role: "toggleDevTools" },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: t("menu.window.title"),
      role: "windowMenu",
      submenu: [
        { label: t("menu.window.minimize"), role: "minimize" },
        { label: t("menu.window.zoom"), role: "zoom" },
        { label: t("menu.window.close"), role: "close" },
        { type: "separator" },
        { label: t("menu.window.front"), role: "front" },
      ],
    },
    {
      label: t("menu.help.title"),
      role: "help",
      submenu: [
        { label: t("menu.help.repo"), click: () => void shell.openExternal(REPO_URL) },
        {
          label: t("menu.help.releaseNotes", { version: versao }),
          click: () => void shell.openExternal(`${REPO_URL}/releases/tag/v${versao}`),
        },
        { label: t("menu.help.issue"), click: () => void shell.openExternal(`${REPO_URL}/issues/new`) },
      ],
    },
  ];
}
