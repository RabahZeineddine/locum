import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { clienteHttp } from "../net/http.js";

/**
 * A atualização do Locum, sem o Electron no meio.
 *
 * O `electron-updater` troca o aplicativo pelo Squirrel do macOS, que recusa
 * pacote sem assinatura da Apple, e o Locum não tem certificado. Então a troca
 * é feita aqui: o release do GitHub publica um manifesto com o sha512 de cada
 * pacote, o aplicativo baixa o `.zip`, confere o hash, extrai e deixa o bundle
 * novo esperando. Quem troca é um script que só age depois que o processo sai.
 *
 * Tudo o que fala com rede ou com disco entra por parâmetro, para que o teste
 * suba um servidor local e monte um bundle de mentira sem sair da máquina.
 */

const exec = promisify(execFile);

/**
 * O repositório que publica os releases. O ambiente troca, para teste.
 *
 * Ele se chamava `agent-watchers`, e o 0.1.1 saiu com esse nome gravado: segue
 * funcionando porque o GitHub redireciona a API do nome antigo para o novo.
 */
export const UPDATE_REPO = process.env.LOCUM_UPDATE_REPO ?? "RabahZeineddine/locum";
export const UPDATE_API = process.env.LOCUM_UPDATE_API ?? "https://api.github.com";

/** Nome do asset que descreve os pacotes de um release. */
export const MANIFEST_NAME = "locum-update.json";

export interface PacoteDoManifesto {
  arch: string;
  name: string;
  /** Em base64, como o `electron-builder` também escreve. */
  sha512: string;
  size: number;
}

export interface Manifesto {
  version: string;
  publishedAt: string;
  files: PacoteDoManifesto[];
}

export interface VersaoDisponivel {
  version: string;
  notes: string;
  publishedAt: string;
  zipUrl: string;
  sha512: string;
  size: number;
}

export type Buscar = typeof fetch;

/**
 * Compara `x.y.z` número a número. Devolve positivo quando `a` é mais nova.
 *
 * Sem pré-release: o script de release só publica versão cheia, e uma etiqueta
 * `-beta` que aparecesse aqui seria erro de quem publicou, não versão a pular.
 */
export function compararVersoes(a: string, b: string): number {
  const partes = (v: string) => v.replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [pa, pb] = [partes(a), partes(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

interface ReleaseDoGithub {
  tag_name: string;
  body?: string | null;
  published_at?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  assets: { name: string; browser_download_url: string }[];
}

/**
 * Pergunta ao GitHub pelo release mais recente e devolve a versão, se ela for
 * mais nova que a instalada e tiver pacote para esta arquitetura.
 *
 * Sem token: o repositório é público, e a API anônima aceita sessenta
 * perguntas por hora, muito acima de uma por abertura e uma a cada seis horas.
 */
export async function procurarVersaoNova(opcoes: {
  atual: string;
  arch: string;
  buscar?: Buscar;
  repo?: string;
  api?: string;
}): Promise<VersaoDisponivel | null> {
  const buscar = opcoes.buscar ?? clienteHttp;
  const base = `${opcoes.api ?? UPDATE_API}/repos/${opcoes.repo ?? UPDATE_REPO}`;

  const resposta = await buscar(`${base}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "locum-updater" },
  });
  // Repositório sem release nenhum responde 404, e isso não é falha.
  if (resposta.status === 404) return null;
  if (!resposta.ok) throw new Error(`GitHub respondeu ${resposta.status} ao procurar release`);

  const release = (await resposta.json()) as ReleaseDoGithub;
  if (release.draft || release.prerelease) return null;
  if (compararVersoes(release.tag_name, opcoes.atual) <= 0) return null;

  const manifestoAsset = release.assets.find((a) => a.name === MANIFEST_NAME);
  if (!manifestoAsset) throw new Error(`o release ${release.tag_name} não tem ${MANIFEST_NAME}`);

  const r = await buscar(manifestoAsset.browser_download_url, { headers: { "user-agent": "locum-updater" } });
  if (!r.ok) throw new Error(`manifesto do release respondeu ${r.status}`);
  const manifesto = (await r.json()) as Manifesto;

  // A etiqueta e o manifesto têm de concordar: um manifesto de outra versão
  // anexado por engano instalaria uma versão que a etiqueta não promete.
  if (compararVersoes(manifesto.version, release.tag_name) !== 0) {
    throw new Error(`o release ${release.tag_name} traz manifesto da versão ${manifesto.version}`);
  }

  const pacote = manifesto.files.find((f) => f.arch === opcoes.arch && f.name.endsWith(".zip"));
  if (!pacote) return null;
  const zip = release.assets.find((a) => a.name === pacote.name);
  if (!zip) throw new Error(`o manifesto cita ${pacote.name}, que não está no release`);

  return {
    version: manifesto.version,
    notes: release.body ?? "",
    publishedAt: release.published_at ?? manifesto.publishedAt,
    zipUrl: zip.browser_download_url,
    sha512: pacote.sha512,
    size: pacote.size,
  };
}

/**
 * Baixa para `destino` calculando o sha512 no caminho, e apaga o arquivo se o
 * hash não bater. Arquivo com hash errado não pode sobrar em disco, nem que
 * seja para a próxima tentativa achar que já baixou.
 */
export async function baixarConferindo(
  url: string,
  destino: string,
  sha512: string,
  buscar: Buscar = clienteHttp,
): Promise<void> {
  const resposta = await buscar(url, { headers: { "user-agent": "locum-updater" } });
  if (!resposta.ok || resposta.body === null) throw new Error(`download respondeu ${resposta.status}`);

  const hash = createHash("sha512");
  const corpo = Readable.fromWeb(resposta.body as import("node:stream/web").ReadableStream);
  corpo.on("data", (pedaco: Buffer) => hash.update(pedaco));
  await pipeline(corpo, createWriteStream(destino));

  const obtido = hash.digest("base64");
  if (obtido !== sha512) {
    await rm(destino, { force: true });
    throw new Error("o pacote baixado não confere com o sha512 do manifesto");
  }
}

/**
 * Apaga uma pasta que pode ter bundle do Electron dentro.
 *
 * Pelo `rm` do sistema, e não pelo `fs.rm`: no processo do Electron o `fs` é
 * remendado para enxergar dentro de `.asar` como se fosse pasta, e o `fs.rm`
 * recursivo tenta descer no `app.asar` do bundle baixado e para com
 * `ENOTEMPTY`. Fora do Electron dá no mesmo, e é por isso que o teste em Node
 * puro nunca pegaria a diferença.
 */
export async function apagar(caminho: string): Promise<void> {
  await exec("rm", ["-rf", caminho]);
}

/** Lê a versão escrita no `Info.plist` de um bundle. */
export async function versaoDoBundle(bundle: string): Promise<string> {
  const { stdout } = await exec("plutil", [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    join(bundle, "Contents", "Info.plist"),
  ]);
  return stdout.trim();
}

/**
 * Extrai o `.zip` e devolve o caminho do `.app` que veio dentro.
 *
 * Pelo `ditto`, e não por biblioteca de zip: é ele que preserva link simbólico
 * e atributo estendido do bundle, e o framework do Electron é feito de links.
 * A versão do `Info.plist` precisa ser a que o manifesto prometeu.
 */
export async function extrairBundle(zip: string, pasta: string, versao: string): Promise<string> {
  await apagar(pasta);
  await mkdir(pasta, { recursive: true });
  await exec("ditto", ["-x", "-k", zip, pasta]);

  const apps = (await readdir(pasta)).filter((n) => n.endsWith(".app"));
  if (apps.length !== 1) throw new Error(`o pacote devia trazer um .app e trouxe ${apps.length}`);
  const bundle = join(pasta, apps[0]!);

  const escrita = await versaoDoBundle(bundle);
  if (compararVersoes(escrita, versao) !== 0) {
    throw new Error(`o pacote diz ser ${versao} e o bundle dentro dele é ${escrita}`);
  }
  return bundle;
}

/** Caminho do `.app` que contém o executável, ou `null` fora de um bundle. */
export function bundleDoExecutavel(execPath: string): string | null {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  return m ? m[1]! : null;
}

/**
 * Por que este bundle não pode ser trocado, ou `null` quando pode.
 *
 * Aberto de dentro do `.dmg` o volume é só de leitura. Aberto pelo Finder sem
 * ter sido movido, o macOS roda uma cópia translocada num caminho aleatório, e
 * trocar essa cópia não muda nada no que a pessoa abre da próxima vez.
 */
export function motivoParaNaoTrocar(bundle: string): string | null {
  if (bundle.startsWith("/Volumes/")) return "aberto de dentro do .dmg; arraste para Aplicativos";
  if (bundle.includes("/AppTranslocation/")) return "o macOS está rodando uma cópia isolada; mova para Aplicativos";
  return null;
}

/**
 * O script que troca o bundle depois que o processo sai.
 *
 * Trocar com o aplicativo aberto é o que corrompe a janela: o processo guarda
 * na memória o índice do `app.asar` e passa a ler bytes de outro arquivo. Por
 * isso o script espera o PID sumir antes de mexer em qualquer coisa. O bundle
 * antigo vira cópia de segurança até o novo estar no lugar, e volta se o
 * segundo `mv` falhar.
 */
export function scriptDeTroca(opcoes: {
  pid: number;
  atual: string;
  novo: string;
  reabrir: boolean;
}): string {
  const aspas = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const atual = aspas(opcoes.atual);
  const novo = aspas(opcoes.novo);
  const reserva = aspas(`${opcoes.atual}.anterior`);
  return [
    `while kill -0 ${opcoes.pid} 2>/dev/null; do sleep 0.2; done`,
    `rm -rf ${reserva}`,
    `mv ${atual} ${reserva} || exit 1`,
    `if mv ${novo} ${atual}; then rm -rf ${reserva}; else mv ${reserva} ${atual}; exit 1; fi`,
    // O download pelo processo não ganha quarentena, mas um zip aberto à mão
    // ganharia, e o Gatekeeper barraria o aplicativo sem assinatura.
    `xattr -dr com.apple.quarantine ${atual} 2>/dev/null`,
    opcoes.reabrir ? `open ${atual}` : ":",
  ].join("\n");
}
