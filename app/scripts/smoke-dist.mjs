/**
 * Fumaça contra o aplicativo empacotado.
 *
 * O `npm run smoke` roda `dist/main.cjs` pelo Electron do `node_modules`, com
 * o `node_modules` inteiro ao alcance e o repositório em volta. O que ele prova
 * não se estende ao `.app`: caminho de recurso, asar e módulo nativo só
 * quebram depois de empacotar, e quebram calados até alguém abrir o aplicativo
 * instalado. Aqui o alvo é o binário de dentro do pacote, com a mesma bateria
 * de verificações do `--smoke`.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { examinarMcp } from "./mcp-handshake.mjs";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseDir = join(appDir, "release");

/**
 * Onde o electron-builder deixa o `.app` de cada arquitetura.
 *
 * Empacotando só a arquitetura da máquina, a pasta sai sem sufixo; pedindo as
 * duas, cada uma ganha a sua. Procurar nas três evita depender de qual das
 * formas foi usada da última vez.
 */
const candidatos = [
  join(releaseDir, `mac-${process.arch}`, "Locum.app"),
  join(releaseDir, "mac", "Locum.app"),
  join(releaseDir, "mac-universal", "Locum.app"),
];

const bundle = candidatos.find((caminho) => existsSync(caminho));
if (bundle === undefined) {
  console.error(
    `não achei o Locum.app empacotado. Rode npm run dist:dir. Procurei em:\n  ${candidatos.join("\n  ")}`,
  );
  process.exit(1);
}

const binario = join(bundle, "Contents", "MacOS", "Locum");
if (!existsSync(binario)) {
  console.error(`${bundle} existe mas não tem Contents/MacOS/Locum dentro`);
  process.exit(1);
}

console.log(`fumaça contra ${binario}`);

/**
 * Teto de tempo, porque isto roda sem ninguém olhando.
 *
 * O `--smoke` sobe janela sem mostrar e conecta no servidor de brinquedo, o
 * que leva dezenas de segundos numa máquina carregada. Mas aplicativo
 * empacotado que trava esperando algo travaria a iteração inteira, e um teto
 * generoso separa lentidão de pendura.
 */
const TETO_MS = 5 * 60_000;

/**
 * O Dock do pacote. Três coisas, todas só verificáveis no `.app`: o Info.plist
 * nasce `LSUIElement`, o `--mcp` nunca aparece no Dock, e o modo normal se
 * promove e aparece. O `--diagnostico-dock` sobe o processo até a política do
 * Dock aplicada, imprime `dock-visivel=<bool>` e sai.
 */
function perguntarDock(binario, argumentos) {
  // userData temporário: o modo normal não pode tocar o do Locum real.
  const dados = mkdtempSync(join(tmpdir(), "locum-dock-"));
  const resultado = spawnSync(binario, [...argumentos, "--diagnostico-dock", `--user-data-dir=${dados}`], {
    encoding: "utf8",
    timeout: 60_000,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LOCUM_HOME: dados },
  });
  rmSync(dados, { recursive: true, force: true });
  const achou = /dock-visivel=(true|false)/.exec(resultado.stdout ?? "");
  if (achou === null) {
    throw new Error(
      `o diagnóstico do Dock (${argumentos.join(" ") || "modo normal"}) não respondeu: ` +
        `status ${resultado.status ?? resultado.signal}, stdout ${JSON.stringify(resultado.stdout)}, ` +
        `stderr ${JSON.stringify((resultado.stderr ?? "").slice(-500))}`,
    );
  }
  return achou[1] === "true";
}

async function examinarDock(bundle, binario) {
  const plist = join(bundle, "Contents", "Info.plist");
  const lsui = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :LSUIElement", plist], { encoding: "utf8" }).trim();
  if (lsui !== "true") throw new Error(`Info.plist sem LSUIElement verdadeiro (veio "${lsui}")`);
  if (perguntarDock(binario, ["--mcp"])) throw new Error("o --mcp empacotado apareceu no Dock");
  if (perguntarDock(binario, ["--ferramentas"])) throw new Error("o --ferramentas empacotado apareceu no Dock");
  if (!perguntarDock(binario, [])) throw new Error("o modo normal empacotado ficou sem Dock");
  console.log("dock do pacote: LSUIElement, --mcp e --ferramentas sem Dock, modo normal com Dock");
}

const filho = spawn(binario, ["--smoke"], { stdio: "inherit" });

const teto = setTimeout(() => {
  console.error(`o aplicativo empacotado não saiu em ${TETO_MS / 1000}s, matando`);
  filho.kill("SIGKILL");
}, TETO_MS);

filho.on("error", (erro) => {
  clearTimeout(teto);
  console.error(`não consegui subir o binário empacotado: ${erro.message}`);
  process.exit(1);
});

filho.on("exit", (code, signal) => {
  clearTimeout(teto);
  if (signal !== null) {
    console.error(`o aplicativo empacotado morreu por ${signal}`);
    process.exit(1);
  }
  if (code !== 0) {
    console.error(`o aplicativo empacotado saiu com ${code}`);
    process.exit(code ?? 1);
  }
  // Depois da bateria, o caminho de quem usa o Locum pelo Claude Code: o mesmo
  // binário servindo MCP, que só dentro do `.app` alcança o cofre.
  examinarDock(bundle, binario)
    .then(() => examinarMcp(binario))
    .then(async (resumo) => [resumo, await examinarMcp(binario, [], "--ferramentas")])
    .then(
      (resumos) => {
        for (const resumo of resumos) console.log(resumo);
        console.log("fumaça do pacote: ok");
      },
      (erro) => {
        console.error(erro.message);
        process.exit(1);
      },
    );
});
