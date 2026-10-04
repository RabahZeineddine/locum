import { app } from "electron";

/**
 * Como o Locum recebe `locum://`.
 *
 * Duas portas de entrada, porque sao dois casos diferentes. Com o app no ar, o
 * macOS entrega a URL pelo evento `open-url`. Com o app fechado, ele sobe um
 * processo para entregar, e a URL chega antes de qualquer coisa estar montada:
 * por isso o ouvinte e registrado na carga do modulo, e o que chegar cedo
 * demais espera numa fila ate ter quem trate.
 */
export type DeepLinkHandler = (url: string) => Promise<void> | void;

const waiting: string[] = [];
let handler: DeepLinkHandler | null = null;
let capturing = false;

export interface CaptureOptions {
  /**
   * Segura a instancia unica e encaminha o que chegar para a que ja roda. Fica
   * de fora no smoke, que nao pode derrubar um Locum aberto na maquina nem
   * morrer por causa dele.
   */
  singleInstance?: boolean;
  /**
   * Processo de linha de comando (`--mcp`) não trata URL: passa adiante para
   * o app de verdade. O macOS entrega a ele porque o vê como o Locum aberto.
   */
  encaminhar?: (url: string) => void;
}

/**
 * Registra os ouvintes de URL. Chamar cedo, antes de `app.whenReady`: no macOS
 * o `open-url` sai logo depois do lancamento, e ouvinte que chega atrasado
 * perde a URL que acabou de subir o processo.
 */
export function captureDeepLinks(options: CaptureOptions = {}): void {
  if (capturing) return;
  capturing = true;

  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (options.encaminhar !== undefined) options.encaminhar(url);
    else receive(url);
  });

  // Fora do macOS, e tambem quando o macOS lanca por argumento, a URL vem na
  // linha de comando em vez de evento.
  for (const arg of process.argv.slice(1)) {
    if (isLocumUrl(arg)) receive(arg);
  }

  if (options.singleInstance === true) {
    if (!app.requestSingleInstanceLock()) {
      // Ja existe um Locum no ar: quem trata o deep link e ele, e este processo
      // so existiu para entregar a URL.
      app.quit();
      return;
    }
    app.on("second-instance", (_event, argv) => {
      for (const arg of argv.slice(1)) {
        if (isLocumUrl(arg)) receive(arg);
      }
    });
  }
}

/**
 * Liga o tratador e entrega o que ficou esperando. Devolve quantas URLs
 * estavam na fila.
 */
export function setupDeepLink(next: DeepLinkHandler): number {
  handler = next;

  const pendentes = waiting.splice(0, waiting.length);
  for (const url of pendentes) void run(url);
  return pendentes.length;
}

export function teardownDeepLink(): void {
  handler = null;
  waiting.length = 0;
}

/** Quantas URLs chegaram antes de existir tratador. */
export function deepLinkQueueLength(): number {
  return waiting.length;
}

export function deepLinkListenerCount(): number {
  return app.listenerCount("open-url");
}

/**
 * Registra o Locum como dono do esquema no sistema.
 *
 * Devolve o que o sistema respondeu em vez de garantir sucesso: fora de app
 * empacotado o macOS costuma recusar, e isso nao e motivo para o app nao subir.
 */
export async function registerProtocol(): Promise<{ scheme: string; registered: boolean }> {
  const { LOCUM_SCHEME } = await import("../src/services/deep-link-service.js");

  app.setAsDefaultProtocolClient(LOCUM_SCHEME);
  return { scheme: LOCUM_SCHEME, registered: app.isDefaultProtocolClient(LOCUM_SCHEME) };
}

/**
 * Entrega uma URL como se tivesse vindo do sistema. Existe para o smoke, que
 * precisa provar o roteamento sem pedir ao macOS que abra um navegador.
 */
export function emitDeepLink(url: string): void {
  app.emit("open-url", { preventDefault: () => undefined }, url);
}

function receive(url: string): void {
  if (handler === null) {
    waiting.push(url);
    return;
  }
  void run(url);
}

async function run(url: string): Promise<void> {
  try {
    await handler?.(url);
  } catch (error: unknown) {
    // Ouvinte do Electron ninguem espera, entao o erro morre aqui: promessa
    // rejeitada sem tratador derruba o processo principal e com ele a bandeja.
    console.error("deep link: tratamento falhou", error);
  }
}

function isLocumUrl(arg: string): boolean {
  return arg.startsWith("locum://");
}
