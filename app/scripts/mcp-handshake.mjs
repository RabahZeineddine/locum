/**
 * Conversa com o servidor MCP que o próprio aplicativo serve por `--mcp`.
 *
 * É o caminho de quem instalou o `.dmg`: o Claude Code sobe o binário do Locum
 * e fala pelo stdio. Aqui o exame faz o mesmo, numa pasta de rascunho, e exige
 * três coisas: o aperto de mão responde, as ferramentas aparecem, e o stdout
 * só carrega protocolo. Uma linha de log no stdout passaria em teste de
 * unidade e quebraria a sessão de qualquer cliente.
 *
 *   node scripts/mcp-handshake.mjs <binário> [argumentos antes de --mcp]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const TETO_MS = 60_000;

export async function examinarMcp(binario, argumentos = []) {
  const pasta = mkdtempSync(join(tmpdir(), "locum-mcp-"));
  const filho = spawn(binario, [...argumentos, "--mcp"], {
    env: { ...process.env, LOCUM_HOME: pasta, LOCUM_INITIATIVES_DIR: join(pasta, "initiatives") },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  filho.stderr.on("data", (pedaco) => {
    stderr += pedaco;
  });

  const esperando = new Map();
  const estranhas = [];
  createInterface({ input: filho.stdout }).on("line", (linha) => {
    let mensagem;
    try {
      mensagem = JSON.parse(linha);
    } catch {
      estranhas.push(linha);
      return;
    }
    const pendente = esperando.get(mensagem.id);
    if (pendente !== undefined) {
      esperando.delete(mensagem.id);
      pendente(mensagem);
    }
  });

  let proximo = 1;
  const pedir = (method, params) =>
    new Promise((resolve, reject) => {
      const id = proximo++;
      esperando.set(id, (resposta) =>
        resposta.error ? reject(new Error(`${method}: ${resposta.error.message}`)) : resolve(resposta.result),
      );
      filho.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  const saiu = new Promise((resolve) => filho.on("exit", (code, signal) => resolve({ code, signal })));
  let teto;
  const estourou = new Promise((_, reject) => {
    teto = setTimeout(() => reject(new Error(`o servidor MCP não respondeu em ${TETO_MS / 1000}s`)), TETO_MS);
  });

  try {
    const conversa = (async () => {
      const inicio = await pedir("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "locum-exame", version: "0" },
      });
      filho.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const { tools } = await pedir("tools/list", {});
      const saude = await pedir("tools/call", { name: "locum_health", arguments: {} });
      return { inicio, tools, saude };
    })();
    const { inicio, tools, saude } = await Promise.race([conversa, estourou, saiu.then(() => {
      throw new Error(`o servidor MCP saiu antes de responder\n${stderr}`);
    })]);

    if (inicio?.serverInfo?.name !== "locum") throw new Error(`aperto de mão sem o nome locum: ${JSON.stringify(inicio)}`);
    const nomes = tools.map((ferramenta) => ferramenta.name);
    for (const esperado of ["run_agent", "list_agents", "get_run", "describe_steps", "upsert_library_agent"]) {
      if (!nomes.includes(esperado)) throw new Error(`ferramenta ${esperado} ausente; vieram ${nomes.join(", ")}`);
    }
    const corpo = JSON.parse(saude.content[0].text);
    if (!corpo.dbPath.startsWith(pasta)) throw new Error(`o servidor abriu ${corpo.dbPath}, e não a pasta de rascunho`);
    if (estranhas.length > 0) throw new Error(`stdout com linha que não é protocolo: ${estranhas[0]}`);

    // Fechar o stdin é como o cliente encerra a sessão. Processo que fica de
    // pé depois disso vira zumbi a cada sessão do Claude Code.
    filho.stdin.end();
    const fim = await Promise.race([saiu, estourou]);
    if (fim.code !== 0) throw new Error(`o servidor MCP saiu com ${fim.code ?? fim.signal} ao fechar o stdin`);

    return `servidor MCP pelo aplicativo: ${nomes.length} ferramentas, stdout limpo, saiu ao fechar o stdin`;
  } finally {
    clearTimeout(teto);
    if (filho.exitCode === null) filho.kill("SIGKILL");
    rmSync(pasta, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [binario, ...argumentos] = process.argv.slice(2);
  if (binario === undefined) {
    console.error("uso: node scripts/mcp-handshake.mjs <binário> [argumentos]");
    process.exit(1);
  }
  examinarMcp(binario, argumentos).then(
    (resumo) => console.log(resumo),
    (erro) => {
      console.error(erro.message);
      process.exit(1);
    },
  );
}
