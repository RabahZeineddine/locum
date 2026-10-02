/**
 * Publica uma versão do Locum no GitHub, de onde o aplicativo instalado a baixa.
 *
 *   npm run release              sobe o patch: 0.1.0 vira 0.1.1
 *   npm run release -- minor     0.1.3 vira 0.2.0
 *   npm run release -- 0.4.0     versão escolhida
 *   npm run release -- --dry-run tudo menos commit, push e release
 *
 * Roda a mesma bateria que o pacote sempre passou (typecheck, i18n, build,
 * smoke, testes, empacotar, smoke do pacote) e só publica se tudo sair zero.
 * O manifesto `locum-update.json` leva o sha512 de cada pacote, e é por ele
 * que o aplicativo confere o que baixou.
 *
 * O `gh` fala com a conta pessoal pelo token dela, sem depender de qual conta
 * está ativa no terminal: nesta máquina a ativa costuma ser a do trabalho.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_NAME, UPDATE_REPO, compararVersoes, extrairBundle, type Manifesto } from "../src/update/release.js";

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const CONTA = UPDATE_REPO.split("/")[0]!;
const ARCH = "arm64";

const args = process.argv.slice(2);
const ensaio = args.includes("--dry-run");
const pedido = args.find((a) => !a.startsWith("--")) ?? "patch";

function falhar(mensagem: string): never {
  console.error(`release: ${mensagem}`);
  process.exit(1);
}

/** Roda e devolve a saída, ou encerra com a mensagem do comando. */
function saida(cmd: string, argv: string[], env?: NodeJS.ProcessEnv): string {
  const r = spawnSync(cmd, argv, { cwd: APP, encoding: "utf8", env: { ...process.env, ...env } });
  if (r.status !== 0) falhar(`${cmd} ${argv.join(" ")} saiu com ${r.status}\n${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** Roda mostrando a saída no terminal. */
function passo(titulo: string, cmd: string, argv: string[], env?: NodeJS.ProcessEnv): void {
  console.log(`\n== ${titulo}`);
  const r = spawnSync(cmd, argv, { cwd: APP, stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) falhar(`${titulo} saiu com ${r.status}`);
}

function proximaVersao(atual: string, como: string): string {
  if (/^\d+\.\d+\.\d+$/.test(como)) {
    if (compararVersoes(como, atual) <= 0) falhar(`${como} não é maior que a atual, ${atual}`);
    return como;
  }
  const [maior, menor, correcao] = atual.split(".").map(Number) as [number, number, number];
  if (como === "patch") return `${maior}.${menor}.${correcao + 1}`;
  if (como === "minor") return `${maior}.${menor + 1}.0`;
  if (como === "major") return `${maior + 1}.0.0`;
  return falhar(`não entendi "${como}": use patch, minor, major ou x.y.z`);
}

// --- antes de mexer em qualquer coisa -------------------------------------

const ramo = saida("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (ramo !== "main") falhar(`release sai do main, e o ramo atual é ${ramo}`);
if (saida("git", ["status", "--porcelain"]) !== "") falhar("a árvore tem mudança não commitada");
saida("git", ["fetch", "--quiet", "origin", "main", "--tags"]);
if (saida("git", ["rev-parse", "HEAD"]) !== saida("git", ["rev-parse", "origin/main"])) {
  falhar("o main local e o origin/main divergem; sincronize antes");
}

const token = saida("gh", ["auth", "token", "--user", CONTA]);
const gh = { GH_TOKEN: token };
const visibilidade = saida("gh", ["repo", "view", UPDATE_REPO, "--json", "visibility", "-q", ".visibility"], gh);
// O aplicativo lê o release sem token. Publicar num repositório privado daria
// um release que nenhum Locum instalado consegue enxergar.
if (visibilidade !== "PUBLIC") {
  const aviso = `${UPDATE_REPO} está ${visibilidade}; o aplicativo só lê release de repositório público`;
  if (ensaio) console.warn(`release: ${aviso} (seguindo porque é ensaio)`);
  else falhar(aviso);
}

// Apagar `release/` com um Locum aberto de dentro dela corrompe a janela dele:
// o processo guarda o índice do `app.asar` antigo e passa a ler pedaço de outro
// arquivo. Quem abriu o app pela pasta do build tem de fechá-lo antes.
const abertos = spawnSync("pgrep", ["-f", join(APP, "release")], { encoding: "utf8" }).stdout.trim();
if (abertos !== "") {
  falhar(
    `há Locum aberto de dentro de ${join(APP, "release")} (pid ${abertos.split("\n").join(", ")}); ` +
      "feche e instale pelo .dmg em /Applications antes de publicar",
  );
}
const pacote = JSON.parse(readFileSync(join(APP, "package.json"), "utf8")) as { version: string };
const versao = proximaVersao(pacote.version, pedido);
const etiqueta = `v${versao}`;
if (saida("git", ["tag", "--list", etiqueta]) !== "") falhar(`a etiqueta ${etiqueta} já existe`);

console.log(`release: ${pacote.version} -> ${versao}${ensaio ? " (ensaio, nada será publicado)" : ""}`);

// --- versão, bateria e pacote ---------------------------------------------

const desfazerVersao = () => saida("git", ["checkout", "--", "package.json", "package-lock.json"]);
process.on("exit", (codigo) => {
  if (codigo !== 0 || ensaio) desfazerVersao();
});

saida("npm", ["version", versao, "--no-git-tag-version"]);

passo("verificação", "npm", ["run", "verify"]);
passo("testes", "npm", ["test"]);
rmSync(join(APP, "release"), { recursive: true, force: true });
passo("empacotar", "npx", ["electron-builder", "--mac", "dmg", "zip", `--${ARCH}`, "--publish", "never"]);
passo("fumaça do pacote", "npm", ["run", "smoke:dist"]);

const zip = join(APP, "release", `Locum-${versao}-${ARCH}-mac.zip`);
const dmg = join(APP, "release", `Locum-${versao}-${ARCH}.dmg`);
for (const arquivo of [zip, dmg]) if (!existsSync(arquivo)) falhar(`o empacotamento não gerou ${arquivo}`);

const bytes = readFileSync(zip);
const manifesto: Manifesto = {
  version: versao,
  publishedAt: new Date().toISOString(),
  files: [
    {
      arch: ARCH,
      name: `Locum-${versao}-${ARCH}-mac.zip`,
      sha512: createHash("sha512").update(bytes).digest("base64"),
      size: statSync(zip).size,
    },
  ],
};
const manifestoCaminho = join(APP, "release", MANIFEST_NAME);
writeFileSync(manifestoCaminho, `${JSON.stringify(manifesto, null, 2)}\n`);

// O mesmo caminho que o aplicativo faz ao baixar: extrair e ler a versão do
// Info.plist. Pacote que o Locum instalado recusaria não sai daqui.
const conferencia = mkdtempSync(join(tmpdir(), "locum-release-"));
try {
  await extrairBundle(zip, conferencia, versao);
} catch (err) {
  falhar(`o zip não passa na conferência do aplicativo: ${err instanceof Error ? err.message : err}`);
} finally {
  rmSync(conferencia, { recursive: true, force: true });
}

if (ensaio) {
  console.log(`\nrelease: ensaio pronto. Pacotes em release/, versão devolvida a ${pacote.version}.`);
  process.exit(0);
}

// --- publicar -------------------------------------------------------------

const anterior = spawnSync("git", ["describe", "--tags", "--abbrev=0"], { cwd: APP, encoding: "utf8" });
const desde = anterior.status === 0 ? `${anterior.stdout.trim()}..HEAD` : "HEAD";
const mudancas = execFileSync("git", ["log", "--format=- %s", "--no-merges", desde], { cwd: APP, encoding: "utf8" });
const notas = anterior.status === 0 ? mudancas : "Primeira versão publicada com atualização automática.\n";

// O empacotamento leva minutos, e mudança feita na árvore nesse meio tempo
// não entrou no pacote que foi testado. `-am` a levaria junto no commit da
// versão, e a etiqueta apontaria para código que ninguém empacotou.
const sujos = saida("git", ["status", "--porcelain"])
  .split("\n")
  .filter((linha) => linha !== "" && !/ (app\/)?package(-lock)?\.json$/.test(linha));
if (sujos.length > 0) {
  desfazerVersao();
  falhar(`a árvore mudou durante o release, e nada foi publicado:\n${sujos.join("\n")}`);
}
saida("git", ["commit", "--quiet", "-m", `chore: versão ${versao}`, "--", "package.json", "package-lock.json"]);
saida("git", ["tag", etiqueta]);
saida("git", ["push", "--quiet", "origin", "main", etiqueta]);

const notasCaminho = join(APP, "release", "notas.md");
writeFileSync(notasCaminho, notas);
saida(
  "gh",
  ["release", "create", etiqueta, zip, dmg, manifestoCaminho, "--repo", UPDATE_REPO, "--title", `Locum ${versao}`, "--notes-file", notasCaminho],
  gh,
);

console.log(`\nrelease: ${etiqueta} publicado. Os Locum instalados baixam na próxima conferência.`);
