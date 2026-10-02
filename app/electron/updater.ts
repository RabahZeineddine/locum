import { app, net, Notification } from "electron";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { t } from "./i18n.js";
import { VERSAO } from "./versao.js";
import { criarClienteHttp, tipoDaFalha } from "../src/net/http.js";
import { updateService } from "../src/services/update-service.js";
import { ligarRelogio, umaDeCadaVez, type Relogio } from "../src/triggers/clock.js";
import {
  apagar,
  baixarConferindo,
  bundleDoExecutavel,
  extrairBundle,
  motivoParaNaoTrocar,
  procurarVersaoNova,
  scriptDeTroca,
} from "../src/update/release.js";
import type { FaseDaAtualizacao, UpdaterState } from "../src/update/state.js";

export type { UpdaterState } from "../src/update/state.js";

/** De quanto em quanto tempo o aplicativo aberto pergunta de novo. */
const CADENCIA_MS = 6 * 60 * 60_000;
/** A primeira pergunta espera a subida assentar. */
const PRIMEIRA_MS = 10_000;
/** Depois de uma queda de rede, a próxima pergunta não espera as seis horas. */
const DE_NOVO_SEM_REDE_MS = 5 * 60_000;

let armado = false;
let relogio: Relogio | null = null;
let fase: FaseDaAtualizacao = "idle";
let conferidaEm: number | null = null;
let erro: string | null = null;
let tipoDoErro: UpdaterState["errorKind"] = null;
let deNovo: ReturnType<typeof setTimeout> | null = null;
let disponivel: { version: string; notes: string } | null = null;
/** O bundle novo extraído, esperando o processo sair. */
let preparado: string | null = null;
let reabrir = false;
let trocaRegistrada = false;

/**
 * Pelo `net` do Electron, que respeita o proxy do sistema, e procurado na hora
 * da chamada para que a espia do smoke enxergue a saída. O cliente por cima
 * repete quando a rede troca no meio da conferência.
 */
const buscar = criarClienteHttp({ base: () => net.fetch as unknown as typeof fetch });

const pastaDeTrabalho = (): string => join(homedir(), "Library", "Caches", "Locum", "update");

/**
 * Decide se o verificador deve subir, sem subir nada.
 *
 * Fica separado do `setupUpdater` para que dar essa resposta nunca custe uma
 * chamada de rede. O smoke precisa exatamente disso: conferir que o interruptor
 * é lido sem que a leitura dispare a pergunta ao GitHub.
 */
export async function planUpdater(): Promise<UpdaterState> {
  const { preference, enabled } = await updateService.state();
  const base = {
    current: VERSAO,
    preference,
    enabled,
    armed: armado,
    detail: null,
    phase: fase,
    lastCheckAt: conferidaEm,
    available: disponivel,
    error: erro,
    errorKind: tipoDoErro,
  };

  if (!enabled) return { ...base, reason: "disabled" };
  if (!app.isPackaged) return { ...base, reason: "dev" };
  const bundle = bundleDoExecutavel(process.execPath);
  const motivo = bundle === null ? "fora de um .app" : motivoParaNaoTrocar(bundle);
  if (motivo !== null) return { ...base, reason: "not-replaceable", detail: motivo };
  return { ...base, reason: null };
}

/**
 * Arma o verificador, se o interruptor estiver ligado e o bundle puder ser
 * trocado: uma pergunta logo depois de abrir e outra a cada seis horas.
 *
 * Desligado, nada aqui fala com a rede nem deixa temporizador de pé. O smoke
 * conta a saída pelo `http`, pelo `https` e pelo `net` para provar isso.
 */
export async function setupUpdater(): Promise<UpdaterState> {
  const plano = await planUpdater();
  if (plano.reason !== null || armado) return plano;

  armado = true;
  registrarTroca();
  relogio = ligarRelogio(() => conferir().then(() => undefined), {
    cadenciaMs: CADENCIA_MS,
    primeiraMs: PRIMEIRA_MS,
    aoFalhar: (err) => console.error("atualização: conferência falhou", err),
  });
  return { ...plano, armed: true };
}

/** Desarma o relógio. O que já foi baixado continua esperando a saída. */
export function teardownUpdater(): void {
  if (deNovo !== null) clearTimeout(deNovo);
  deNovo = null;
  relogio?.parar();
  relogio = null;
  armado = false;
}

/** Se o verificador chegou a ser armado nesta subida. Serve ao smoke. */
export function updaterArmed(): boolean {
  return armado;
}

/** O estado para a tela de configuração. */
export function updaterState(): Promise<UpdaterState> {
  return planUpdater();
}

/**
 * Pergunta ao GitHub, baixa e prepara. Uma de cada vez: o clique em "conferir
 * agora" e o relógio podem cair juntos, e dois downloads do mesmo zip no mesmo
 * arquivo corromperiam os dois.
 */
export const conferir = umaDeCadaVez(async (): Promise<void> => {
  const plano = await planUpdater();
  if (plano.reason !== null) return;
  // Já baixado: perguntar de novo só gastaria rede até a pessoa reiniciar.
  if (preparado !== null) return;

  fase = "checking";
  erro = null;
  tipoDoErro = null;
  try {
    const nova = await procurarVersaoNova({ atual: VERSAO, arch: process.arch, buscar });
    conferidaEm = Date.now();
    if (nova === null) {
      fase = "uptodate";
      return;
    }

    fase = "downloading";
    disponivel = { version: nova.version, notes: nova.notes };
    const pasta = join(pastaDeTrabalho(), nova.version);
    await apagar(pasta);
    await mkdir(pasta, { recursive: true });
    const zip = join(pasta, "pacote.zip");
    await baixarConferindo(nova.zipUrl, zip, nova.sha512, buscar);
    preparado = await extrairBundle(zip, join(pasta, "bundle"), nova.version);
    await rm(zip, { force: true });

    fase = "ready";
    console.log(`atualização: ${nova.version} baixada, entra quando o Locum fechar`);
    avisar(nova.version);
  } catch (err) {
    fase = "failed";
    disponivel = preparado === null ? null : disponivel;
    erro = err instanceof Error ? err.message : String(err);
    tipoDoErro = tipoDaFalha(err);
    conferidaEm = Date.now();
    // Sem rede, esperar seis horas deixaria a versão nova parada à toa. Uma
    // pergunta só, alguns minutos depois; se a rede seguir fora, o relógio
    // normal continua de pé.
    if (tipoDoErro !== null && armado && deNovo === null) {
      deNovo = setTimeout(() => {
        deNovo = null;
        conferir().catch((e: unknown) => console.error("atualização: conferência falhou", e));
      }, DE_NOVO_SEM_REDE_MS);
      deNovo.unref?.();
    }
    throw err;
  }
});

/** Fecha o Locum, troca e abre a versão nova. */
export function aplicarAgora(): boolean {
  if (preparado === null) return false;
  reabrir = true;
  app.quit();
  return true;
}

function avisar(versao: string): void {
  if (!Notification.isSupported()) return;
  new Notification({
    title: t("updates.readyTitle", { version: versao }),
    body: t("updates.readyBody"),
  }).show();
}

/**
 * A troca de verdade, agendada no `will-quit`.
 *
 * Não no `quit`: o processo principal fecha o pool de servidores MCP e sai por
 * `app.exit`, que não emite `quit`. O script sobe desligado do processo e
 * espera o PID sumir, então agendar antes de o pool fechar não adianta a troca:
 * trocar o bundle com o aplicativo de pé é o que faz a janela mostrar pedaço
 * de outro arquivo.
 */
function registrarTroca(): void {
  if (trocaRegistrada) return;
  trocaRegistrada = true;
  app.once("will-quit", () => {
    const atual = bundleDoExecutavel(process.execPath);
    if (preparado === null || atual === null) return;
    const script = scriptDeTroca({ pid: process.pid, atual, novo: preparado, reabrir });
    const filho = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" });
    filho.unref();
    console.log(`atualização: troca agendada para depois da saída${reabrir ? ", reabrindo" : ""}`);
  });
}

/** Uma requisição que saiu enquanto a espia estava de pé. */
export interface RequisicaoVista {
  /** `http`, `https` ou `net`, conforme por onde saiu. */
  via: string;
  destino: string;
}

export interface EspiaDeRede {
  vistas(): RequisicaoVista[];
  parar(): void;
}

/**
 * Conta o que sai para a rede enquanto estiver de pé.
 *
 * Existe para o smoke: "desligado não faz chamada de rede" só se prova olhando
 * a saída, e não lendo o código que decide não chamar. Cobre os dois caminhos
 * por onde uma chamada do processo principal sai: `net.request` e `net.fetch`
 * do Electron, `http`/`https` do Node e o `fetch` global, que é do undici e não
 * passa por nenhum dos outros.
 *
 * O remendo é global e volta atrás no `parar()`. Fora do smoke ninguém chama
 * isto: contar toda requisição do processo em produção seria pagar por uma
 * informação que não muda nada.
 */
export function espiarRede(): EspiaDeRede {
  const vistas: RequisicaoVista[] = [];

  const originais = {
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    netRequest: net.request,
    netFetch: net.fetch,
    fetch: globalThis.fetch,
  };

  const anotar =
    (via: string, original: (...args: never[]) => unknown) =>
    (...args: unknown[]): unknown => {
      vistas.push({ via, destino: descreverDestino(args[0]) });
      return (original as (...a: unknown[]) => unknown)(...args);
    };

  http.request = anotar("http", originais.httpRequest) as typeof http.request;
  http.get = anotar("http", originais.httpGet) as typeof http.get;
  https.request = anotar("https", originais.httpsRequest) as typeof https.request;
  https.get = anotar("https", originais.httpsGet) as typeof https.get;
  net.request = anotar("net", originais.netRequest) as typeof net.request;
  net.fetch = anotar("net.fetch", originais.netFetch) as typeof net.fetch;
  globalThis.fetch = anotar("fetch", originais.fetch) as typeof fetch;

  return {
    vistas: () => [...vistas],
    parar: () => {
      http.request = originais.httpRequest;
      http.get = originais.httpGet;
      https.request = originais.httpsRequest;
      https.get = originais.httpsGet;
      net.request = originais.netRequest;
      net.fetch = originais.netFetch;
      globalThis.fetch = originais.fetch;
    },
  };
}

function descreverDestino(alvo: unknown): string {
  if (typeof alvo === "string") return alvo;
  if (alvo instanceof URL) return alvo.toString();
  if (alvo !== null && typeof alvo === "object") {
    const opcoes = alvo as { url?: string; hostname?: string; host?: string; path?: string };
    if (typeof opcoes.url === "string") return opcoes.url;
    const host = opcoes.hostname ?? opcoes.host;
    if (host !== undefined) return `${host}${opcoes.path ?? ""}`;
  }
  return "?";
}
