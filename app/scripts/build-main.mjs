import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const bindingSource = join(
  appDir,
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node",
);
/**
 * Para qual arquitetura reconstruir o binario nativo.
 *
 * O pacote sai para arm64 e x64, e um `.node` so serve para a arquitetura em
 * que foi compilado. O nome carrega a arquitetura para que as duas copias
 * caibam lado a lado, e para que empacotar x64 sem ter gerado a copia falhe na
 * subida em vez de instalar um aplicativo que nao abre.
 */
const archFlag = process.argv.indexOf("--arch");
const arch = archFlag < 0 ? process.arch : process.argv[archFlag + 1];
const bindingTarget = join(appDir, "native", `better_sqlite3-electron-${arch}.node`);

function run(command, args) {
  execFileSync(command, args, { cwd: appDir, stdio: "inherit" });
}

/**
 * O better-sqlite3 instalado fica compilado para o ABI do Node, porque a linha
 * de comando roda por tsx. O Electron tem ABI proprio e recusa esse binario, e
 * os dois nao cabem no mesmo caminho. Entao aqui a gente recompila para o
 * Electron, guarda a copia em native/, e devolve o node_modules ao estado de
 * Node, para nao quebrar a linha de comando.
 */
function ensureElectronBinding() {
  if (existsSync(bindingTarget)) return;

  mkdirSync(dirname(bindingTarget), { recursive: true });
  run("npx", ["electron-rebuild", "-f", "-w", "better-sqlite3", "--arch", arch]);
  copyFileSync(bindingSource, bindingTarget);
  run("npm", ["rebuild", "better-sqlite3"]);
}

ensureElectronBinding();

/**
 * O node-pty traz o binário pronto por arquitetura, em N-API, então vale no
 * Node e no Electron sem recompilar. O que falta é o bit de execução do
 * `spawn-helper`, que o script de instalação daria e a instalação sem script
 * não dá; sem ele todo terminal embutido falha em `posix_spawnp`.
 */
function ensurePtyHelper() {
  for (const alvo of ["darwin-arm64", "darwin-x64"]) {
    const helper = join(appDir, "node_modules", "node-pty", "prebuilds", alvo, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}

ensurePtyHelper();

/**
 * As migracoes viajam como arquivo, ao lado do bundle.
 *
 * O migrator do drizzle le os `.sql` do disco na hora de rodar, entao embutir
 * a pasta no pacote do esbuild nao adiantaria. Copiar para `dist/` faz o
 * caminho ser o mesmo rodando por `npx electron dist/main.cjs` e dentro do
 * `.app`, onde `dist/` inteiro entra como recurso.
 */
function copyMigrations() {
  const source = join(appDir, "drizzle");
  if (!existsSync(join(source, "meta", "_journal.json"))) {
    throw new Error("nao achei app/drizzle, rode npm run db:generate");
  }
  const target = join(appDir, "dist", "drizzle");
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}

copyMigrations();

await build({
  entryPoints: [join(appDir, "electron", "main.ts")],
  outfile: join(appDir, "dist", "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  /**
   * So fica de fora o que nao se deixa empacotar.
   *
   * `electron` vem do proprio runtime, e `better-sqlite3` carrega binario
   * nativo por `require` de caminho, que o esbuild nao tem como embutir. Todo
   * o resto entra no arquivo, e e isso que permite ao pacote sair sem
   * `node_modules`: antes o `.app` levava a arvore inteira de producao, com o
   * React e o Shiki que o Vite ja tinha embutido na janela viajando de novo em
   * codigo-fonte, e o Octokit sozinho passando de cem megabytes.
   */
  external: ["electron", "better-sqlite3", "node-pty"],
});

/**
 * O preload sai num pacote proprio, e aqui `packages: "external"` nao vale.
 *
 * Ele roda em sandbox, onde nao existe resolucao por node_modules: o que nao
 * estiver dentro do arquivo nao carrega. Como o preload so importa `electron`,
 * que o sandbox fornece, basta marcar esse.
 */
await build({
  entryPoints: [join(appDir, "electron", "preload.ts")],
  outfile: join(appDir, "dist", "preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  external: ["electron"],
});

/**
 * O servidor de brinquedo tambem sai empacotado.
 *
 * Ele e alvo do smoke, e ate aqui era alcancado por `tsx` lendo `src/`. Nenhum
 * dos dois entra no `.app`: `tsx` e dependencia de desenvolvimento e `src/`
 * fica de fora do pacote de proposito. Empacotado junto, o mesmo caminho serve
 * rodando do repositorio e de dentro do `.app`.
 *
 * Aqui `packages: "external"` nao vale, pelo mesmo motivo do preload: o
 * processo sobe fora do `node_modules` do projeto, entao o que ele importa
 * precisa estar dentro do arquivo.
 */
await build({
  entryPoints: [join(appDir, "src", "fixtures", "mcp-fixture-server.ts")],
  outfile: join(appDir, "dist", "mcp-fixture-server.mjs"),
  bundle: true,
  platform: "node",
  // Ao contrario do main e do preload, este sai como modulo ES: o servidor tem
  // `await` no topo para abrir o transporte, e `cjs` nao aceita.
  format: "esm",
  target: "node22",
  sourcemap: true,
});
