// Primeiro import de propósito: com `--mcp`, desvia o log do stdout antes que
// qualquer outro módulo escreva nele.
import { modoMcp } from "./mcp-stdout.js";
import { app, BrowserWindow, shell } from "electron";
import { captureDeepLinks } from "./deep-link.js";
import { VERSAO } from "./versao.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { aplicarIdioma, idiomaAtual, iniciarI18n, t } from "./i18n.js";
import en from "../locales/en.json";
import ptBR from "../locales/pt-BR.json";
import { dirname, join, sep } from "node:path";
// So tipo: o `import type` e apagado no build, e um import de valor vindo de
// `src/` aqui em cima carregaria o nucleo antes de `LOCUM_SQLITE_BINDING`
// apontar o binario do Electron.
import type { RunService } from "../src/services/run-service.js";
import type { AftermathFetcher } from "../src/services/reconcile-service.js";
import type { SlackService } from "../src/services/slack-service.js";
// Valor, e não só tipo, mas sem efeito no import: `path.ts` não abre banco.
import { smokeHome } from "../src/db/path.js";
import { escreverSessoesDeExemplo, SESSOES_DE_EXEMPLO } from "../src/services/claude-sessions-sample.js";

const smoke = process.argv.includes("--smoke");
const capturas = process.argv.includes("--capturas");

/** `--set-secret <ref>` e `--remove-secret <ref>`, com o valor vindo do stdin. */
function flagValue(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

/**
 * Tira um caminho de dentro do asar.
 *
 * Empacotado, `__dirname` cai dentro de `app.asar`, que e um arquivo so. Isso
 * basta para ler JSON e HTML, porque o Electron remenda o `fs`, mas nao para
 * modulo nativo: `dlopen` e do sistema e nao enxerga caminho la dentro. O que
 * o `asarUnpack` do empacotamento deixa em `app.asar.unpacked` sai por aqui.
 */
function foraDoAsar(caminho: string): string {
  return caminho.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
}

// O nucleo abre o banco no import do modulo, entao o caminho do binding nativo
// precisa estar no ambiente antes de qualquer import dele. Por isso o acesso ao
// banco mora num import dinamico la embaixo, e nao no topo do arquivo.
//
// O nome carrega a arquitetura porque o pacote sai para arm64 e x64, e um
// `.node` compilado para uma nao carrega na outra.
process.env.LOCUM_SQLITE_BINDING = foraDoAsar(
  join(__dirname, "..", "native", `better_sqlite3-electron-${process.arch}.node`),
);

// Pelo mesmo motivo do binding: o banco abre no import do núcleo, e a fumaça
// precisa trocar de pasta antes disso para não plantar dado no banco real.
const pastaDaFumaca = smoke ? smokeHome() : undefined;
if (pastaDaFumaca?.temporary) {
  console.log(`fumaça em pasta de rascunho: ${pastaDaFumaca.dir}`);
  // `app.exit` não passa pelo `will-quit`, mas o `exit` do processo sai sempre.
  process.on("exit", () => pastaDaFumaca.cleanup());
}
// A tela de sessões lê `~/.claude`, que é conversa de trabalho de quem roda.
// A fumaça e as capturas leem uma pasta de exemplo no lugar.
if (pastaDaFumaca) {
  const pasta = join(pastaDaFumaca.dir, "claude");
  escreverSessoesDeExemplo(pasta, join(pastaDaFumaca.dir, "projeto"), process.pid);
  process.env.LOCUM_CLAUDE_DIR = pasta;
}

// Antes de qualquer espera: com o app fechado, o macOS sobe o processo para
// entregar a URL, e o `open-url` sai logo no lancamento. Ouvinte registrado
// depois do `whenReady` chega tarde e perde justamente a URL que subiu o app.
//
// Servidor MCP e comando de cofre ficam fora da trava de instância única: o
// Claude Code abre o `--mcp` com o Locum já aberto na bandeja, e a trava faria
// o processo sair calado, sem responder ao primeiro pedido.
const comandoDeLinha =
  modoMcp || process.argv.includes("--set-secret") || process.argv.includes("--remove-secret");
captureDeepLinks({ singleInstance: !smoke && !comandoDeLinha });

let mainWindow: BrowserWindow | null = null;

/** O preload sai do mesmo build que o main e fica ao lado dele em dist/. */
const PRELOAD = join(__dirname, "preload.cjs");

/**
 * A pagina que o Vite constroi, carregada do disco por `file://`.
 *
 * Nao existe servidor por tras da janela, e nem precisa: o Electron deixa o
 * modulo ES da pagina carregar em `file://`, ao contrario do Chrome de mesa,
 * que recusaria por origem opaca. Por isso o `base` do Vite e relativo, e por
 * isso nenhum recurso da pagina pode vir da rede.
 */
const RENDERER = join(__dirname, "renderer", "index.html");

function createWindow(options: { show?: boolean } = {}): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 16 },
    // Sem material do sistema: a janela pinta as próprias superfícies. A
    // vibrancy deixava a barra lateral transparente, e onde ela não aparece o
    // texto some. Profundidade aqui vem de luminância, que não depende de
    // suporte de composição.
    backgroundColor: "#35383F",
    webPreferences: {
      preload: PRELOAD,
      // A janela nao tem Node nenhum. Tudo que ela alcanca do sistema passa
      // pelos canais do preload, e `sandbox` garante que nem um import solto
      // no renderer devolva `require`.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  if (options.show !== false) window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    mainWindow = null;
  });
  return window;
}

/**
 * Cria a janela do Locum: ponte confiada e pagina construida carregada.
 *
 * O `trustWindow` vem antes do `loadFile` de proposito. O preload roda assim
 * que o documento carrega, e um canal chamado por janela ainda nao confiada
 * volta como recusa para o renderer.
 */
async function openMainWindow(): Promise<BrowserWindow> {
  const { trustWindow } = await import("./bridge.js");

  const window = createWindow();
  trustWindow(window);
  await window.loadFile(RENDERER);
  mainWindow = window;
  return window;
}

/**
 * Abrir a janela leva alguns passos assincronos, e nesse meio tempo
 * `mainWindow` continua nulo. Sem guardar a abertura em curso, um clique na
 * bandeja junto de um clique numa notificacao abriria duas janelas.
 */
let opening: Promise<BrowserWindow> | null = null;

function ensureWindow(): Promise<BrowserWindow> {
  if (mainWindow !== null) return Promise.resolve(mainWindow);
  opening ??= openMainWindow().finally(() => {
    opening = null;
  });
  return opening;
}

/** Traz a janela para frente, criando uma se nao houver. */
function showWindow(): void {
  void ensureWindow().then((window) => {
    window.show();
    window.focus();
  });
}

/**
 * Clique na notificacao: janela na frente, apontada para o run que a gerou.
 *
 * Enquanto a interface nao existe, o destino fica so guardado e no log. A
 * janela ainda nao carrega nada, entao encaminhar a rota agora seria mandar
 * recado para ninguem; quando o renderer entrar, ele le daqui na subida.
 */
let inboxTarget: string | null = null;

function openInbox(runId: string): void {
  inboxTarget = runId;
  console.log(`notificacao: abrir a inbox no run ${runId}`);
  showWindow();
}

/** O ultimo run para onde um clique de notificacao mandou. */
export function pendingInboxTarget(): string | null {
  return inboxTarget;
}

/**
 * O que fazer com uma `locum://` vinda do sistema.
 *
 * A leitura e a regra moram no servico; aqui so sobra dizer ao usuario o que
 * aconteceu e trazer a janela de volta, que e o fim natural de um retorno de
 * navegador. Nem o codigo nem o token aparecem no log.
 */
async function handleDeepLink(url: string): Promise<void> {
  const { deepLinkService, parseDeepLink } = await import("../src/services/deep-link-service.js");

  const route = parseDeepLink(url);
  if (route.kind === "unknown") {
    console.log(`deep link: url descartada, ${route.reason}`);
    return;
  }
  if (route.kind === "oauth-error") {
    deepLinkService.cancelAuthorization(route.server);
    console.log(`deep link: autorizacao de ${route.server} recusada, ${route.error}`);
    return;
  }
  if (route.kind === "session-ended") {
    const { sessionService } = await import("../src/services/session-service.js");
    const fechada = await sessionService.finish(route.session, route.token);
    console.log(`deep link: fim de sessao ${fechada ? "registrado" : "recusado, nonce usado ou errado"}`);
    if (fechada) showWindow();
    return;
  }

  const result = await deepLinkService.completeOAuth(route);
  console.log(
    `deep link: ${result.server} autorizado, credencial em ${result.credentialRef}` +
      (result.hasRefresh ? ", com refresh guardado" : ""),
  );
  showWindow();
}

/** Confere que o nucleo carrega e que o banco responde a uma consulta. */
async function checkCore(): Promise<number> {
  const { db, schema } = await import("../src/db/index.js");
  const rows = await db.select().from(schema.agents);
  return rows.length;
}

/**
 * Prova que a preferencia de subir no login vai e volta do banco e que o
 * sistema responde. A gravacao no sistema repete o estado que ja estava la de
 * proposito: o smoke roda na maquina de quem desenvolve e nao pode sair
 * ligando o Locum no login de ninguem.
 */
async function checkLoginItem(): Promise<string> {
  const { applyPreference, readLoginItem, writeLoginItem } = await import("./login-item.js");
  const { startupService } = await import("../src/services/startup-service.js");

  const before = await startupService.getPreference();
  for (const value of [true, false]) {
    await startupService.setPreference(value);
    if ((await startupService.getPreference()) !== value) {
      throw new Error(`preferencia ${value} nao voltou do banco`);
    }
  }
  if (before === null) await startupService.clearPreference();
  else await startupService.setPreference(before);

  const system = readLoginItem();
  const rewritten = writeLoginItem(system.openAtLogin);
  if (rewritten.openAtLogin !== system.openAtLogin) {
    throw new Error("regravar o mesmo estado mudou o item de login");
  }

  const state = await applyPreference();
  const decision =
    state.preference === null ? t("smoke.loginItemUndecided") : String(state.preference);
  return t("smoke.loginItem", { decision, status: state.status });
}

/**
 * Prova que os ouvintes de energia estao no ar e que um resume chega ao
 * agendador. A batida de verdade nao entra: ela criaria run, e o smoke roda
 * sozinho no loop de verificacao, onde gastar assinatura por engano nao tem
 * quem perceba. Por isso o `onWake` aqui so conta.
 */
async function checkPower(): Promise<string> {
  const { emitPowerEvent, powerListenerCount, setupPower, teardownPower } = await import(
    "./power.js"
  );

  const before = powerListenerCount();
  const beats: (number | null)[] = [];
  let clock = Date.parse("2026-09-19T01:00:00Z");

  setupPower({ onWake: (slept) => void beats.push(slept), now: () => clock });

  const after = powerListenerCount();
  if (after.suspend !== before.suspend + 1 || after.resume !== before.resume + 1) {
    throw new Error("ouvintes de energia nao ficaram registrados");
  }

  const sleep = 90 * 60_000;
  emitPowerEvent("suspend");
  clock += sleep;
  emitPowerEvent("resume");

  if (beats.length !== 1) {
    throw new Error(`um resume bateu no agendador ${beats.length} vez(es)`);
  }
  if (beats[0] !== sleep) {
    throw new Error(`resume mediu ${String(beats[0])}ms de sono e o esperado era ${sleep}ms`);
  }

  teardownPower();
  const cleaned = powerListenerCount();
  if (cleaned.suspend !== before.suspend || cleaned.resume !== before.resume) {
    throw new Error("ouvinte de energia sobrou depois do teardown");
  }

  return t("smoke.power", { minutes: sleep / 60_000 });
}


/** A conferência não varre: gatilho de varredura não chega a este agendador. */
const proibirVarredura = async (): Promise<string[]> => {
  throw new Error("o smoke da conferencia nao pode varrer o GitHub");
};
/**
 * Prova que a conferência de pull request fechado roda na batida do agendador,
 * e que ela não reprocessa quem já ganhou desfecho.
 *
 * Nada aqui fala com o GitHub: o leitor do que aconteceu depois do review entra
 * trocado, contando quantas vezes cada pull request foi visitado. É o que
 * permite exigir a parte difícil da story, que é uma afirmação sobre a segunda
 * batida: a execução fechada não pode ser visitada de novo, e a que ficou com o
 * pull request aberto tem que voltar.
 *
 * O agendador entra inteiro, com o serviço de gatilhos trocado por um que não
 * enxerga nada habilitado. Sem isso a batida dispararia o que estiver ligado no
 * banco de quem desenvolve, e o smoke gastaria assinatura sem ninguém pedir.
 *
 * As duas execuções são plantadas e apagadas aqui mesmo. O smoke roda no banco
 * de verdade, e evento de origem `github` que sobrevivesse entraria na fila de
 * conferência da próxima subida do app.
 */
async function checkReconcile(): Promise<string> {
  const { db, schema } = await import("../src/db/index.js");
  const { and, eq, inArray } = await import("drizzle-orm");
  const { agentService } = await import("../src/services/agent-service.js");
  const { runService } = await import("../src/services/run-service.js");
  const { ReconcileService } = await import("../src/services/reconcile-service.js");
  const { TriggerService } = await import("../src/services/trigger-service.js");
  const { executionService } = await import("../src/services/execution-service.js");
  const { mcpService } = await import("../src/services/mcp-service.js");
  const { Scheduler } = await import("../src/triggers/scheduler.js");
  const [agent] = await agentService.list();
  if (agent === undefined) throw new Error("nenhum agent cadastrado para reconciliar");
  const versao = await agentService.getLatestVersion(agent.id);
  if (versao === undefined) throw new Error(`agent ${agent.id} sem versao gravada`);

  const dono = `locum-smoke-${randomUUID().slice(0, 8)}`;
  const repo = `locum-smoke-${randomUUID().slice(0, 8)}`;
  const arquivo = "src/Auth/TokenValidator.cs";
  const problema = "`DateTime.Now` devolve hora local e o token expira tarde demais.";
  // Corpo do comentário humano inventado. Sai em variável porque o guarda de
  // i18n olha a propriedade `body`, e este texto é dado de teste, não produto.
  const comentario = "o mesmo ponto, visto por uma pessoa";

  const fechado = { runId: `smoke-run-${randomUUID()}`, eventId: `smoke-event-${randomUUID()}`, pull: 1 };
  const aberto = { runId: `smoke-run-${randomUUID()}`, eventId: `smoke-event-${randomUUID()}`, pull: 2 };

  for (const alvo of [fechado, aberto]) {
    await db.insert(schema.events).values({
      id: alvo.eventId,
      source: "github",
      externalId: `pr:${dono}/${repo}#${alvo.pull}:sha:abc123`,
      payload: { owner: dono, repoName: repo, pull: alvo.pull, headSha: "abc123" },
    });
    await db.insert(schema.runs).values({
      id: alvo.runId,
      agentVersionId: versao.id,
      eventId: alvo.eventId,
      triggerId: null,
      status: "done",
    });
    await db.insert(schema.steps).values({
      id: `${alvo.runId}-audit`,
      runId: alvo.runId,
      idx: 0,
      stepKey: "audit",
      name: "Auditoria",
      status: "done",
      output: {
        findings: [
          { file: arquivo, line: 41, severity: "critical", category: "correcao", problem: problema },
        ],
      },
    });
  }

  /** Quantas vezes cada pull request foi visitado, por número. */
  const visitas = new Map<number, number>();
  const olhar: AftermathFetcher = async (owner, nome, pull, sha) => {
    if (owner !== dono || nome !== repo) {
      throw new Error(`a conferencia visitou ${owner}/${nome}, que nao e o alvo plantado`);
    }
    visitas.set(pull, (visitas.get(pull) ?? 0) + 1);
    const encerrado = pull === fechado.pull;
    return {
      prKey: `${owner}/${nome}#${pull}`,
      state: encerrado ? "merged" : "open",
      headSha: sha,
      // O sinal cai na mesma linha do achado, que é o que faz o desfecho sair
      // como confirmado e não como ignorado.
      signals: encerrado
        ? [{ author: "revisora", kind: "comment" as const, file: arquivo, line: 41, body: comentario }]
        : [],
      changedAfter: new Map(),
    };
  };

  const conferencia = new ReconcileService(db, runService, olhar);
  const semGatilho = new (class extends TriggerService {
    async enabled() {
      return [];
    }
  })(db);
  const agendador = new Scheduler(
    db,
    semGatilho,
    executionService,
    mcpService,
    await semSlack(),
    proibirVarredura,
    (o) => conferencia.sweep(o),
  );

  try {
    // As contagens da batida sao pisos, e nao igualdades: o smoke roda no banco
    // de quem desenvolve, e uma execucao antiga de origem `github` entraria na
    // mesma fila. O que e exigido com numero exato e o que o contador de
    // visitas diz sobre as duas execucoes plantadas aqui.
    const primeira = await agendador.tick({ reason: "timer" });
    if (primeira.reconciled.settled < 1 || primeira.reconciled.stillOpen < 1) {
      throw new Error(
        `a primeira batida deu ${primeira.reconciled.settled} desfecho(s) e deixou ` +
          `${primeira.reconciled.stillOpen} aberto(s), e o esperado era ao menos um de cada`,
      );
    }
    if (visitas.get(fechado.pull) !== 1 || visitas.get(aberto.pull) !== 1) {
      throw new Error("a primeira batida nao visitou as duas execucoes plantadas uma vez cada");
    }

    const desfechos = await db
      .select({ state: schema.findingOutcomes.state })
      .from(schema.findingOutcomes)
      .innerJoin(schema.findings, eq(schema.findingOutcomes.findingId, schema.findings.id))
      .where(eq(schema.findings.runId, fechado.runId));
    if (desfechos.length !== 1 || desfechos[0]?.state !== "confirmed_by_human") {
      throw new Error(
        `a execucao fechada ganhou ${desfechos.length} desfecho(s): ` +
          `${desfechos.map((d) => d.state).join(", ")}`,
      );
    }
    const semDesfecho = await db
      .select({ id: schema.findings.id })
      .from(schema.findings)
      .where(eq(schema.findings.runId, aberto.runId));
    if (semDesfecho.length !== 0) {
      throw new Error("a execucao de PR aberto gravou achado antes de o pull request fechar");
    }

    const segunda = await agendador.tick({ reason: "timer" });
    if (segunda.reconciled.settled !== 0) {
      throw new Error(`a segunda batida gravou ${segunda.reconciled.settled} desfecho(s) de novo`);
    }
    if (visitas.get(fechado.pull) !== 1) {
      throw new Error(`o PR fechado foi visitado ${String(visitas.get(fechado.pull))} vez(es), e nao uma`);
    }
    if (visitas.get(aberto.pull) !== 2) {
      throw new Error(`o PR aberto foi visitado ${String(visitas.get(aberto.pull))} vez(es), e nao duas`);
    }

    return t("smoke.reconcile", { settled: primeira.reconciled.settled });
  } finally {
    const runIds = [fechado.runId, aberto.runId];
    const achados = await db
      .select({ id: schema.findings.id })
      .from(schema.findings)
      .where(inArray(schema.findings.runId, runIds));
    if (achados.length > 0) {
      await db.delete(schema.findingOutcomes).where(
        inArray(schema.findingOutcomes.findingId, achados.map((a) => a.id)),
      );
    }
    await db.delete(schema.findings).where(inArray(schema.findings.runId, runIds));
    await db.delete(schema.reviewSignals).where(eq(schema.reviewSignals.prKey, `${dono}/${repo}#${fechado.pull}`));
    await db.delete(schema.cursors).where(
      and(eq(schema.cursors.source, "reconcile"), inArray(schema.cursors.key, runIds)),
    );
    await db.delete(schema.steps).where(inArray(schema.steps.runId, runIds));
    await db.delete(schema.runs).where(inArray(schema.runs.id, runIds));
    await db.delete(schema.events).where(inArray(schema.events.id, [fechado.eventId, aberto.eventId]));
  }
}

/**
 * Prova que o interruptor desligado não custa uma requisição sequer.
 *
 * Ler o código e ver que ele decide não chamar não prova nada: a chamada que
 * importa é a que um temporizador faria dez segundos depois, longe da linha
 * que alguém leu. Por isso aqui a saída de rede é contada de fora, e o critério
 * é a contagem, não a intenção.
 *
 * A segunda metade devolve a preferência ao padrão, que é ligado, e confere
 * pelo `planUpdater`, que decide sem armar. Não é detalhe: dentro do pacote o
 * `setupUpdater` ligado perguntaria ao GitHub de verdade. A preferência de quem
 * desenvolve volta ao que era no fim, porque o smoke roda no banco de verdade.
 */
async function checkUpdates(): Promise<string> {
  const { updateService } = await import("../src/services/update-service.js");
  const { planUpdater, setupUpdater, updaterArmed, espiarRede } = await import("./updater.js");

  const anterior = await updateService.getPreference();
  const espia = espiarRede();

  const semRede = (momento: string): void => {
    const vistas = espia.vistas();
    if (vistas.length === 0) return;
    const quais = vistas.map((v) => `${v.via} ${v.destino}`).join(", ");
    throw new Error(`atualização ${momento} saiu para a rede: ${quais}`);
  };

  try {
    await updateService.setEnabled(false);
    const desligado = await setupUpdater();
    if (desligado.enabled || desligado.armed || updaterArmed()) {
      throw new Error("o verificador de atualização armou com o interruptor desligado");
    }
    if (desligado.reason !== "disabled") {
      throw new Error(`desligado, o motivo deveria ser disabled, veio ${desligado.reason}`);
    }
    semRede("desligada");

    await updateService.clearPreference();
    const padrao = await planUpdater();
    if (!padrao.enabled) throw new Error("sem preferência gravada a atualização devia valer ligada");
    if (padrao.armed || updaterArmed()) throw new Error("o plano do verificador armou sozinho");
    semRede("no padrão");

    return t("smoke.updates", {
      requests: espia.vistas().length,
      reason: padrao.reason ?? "pronta",
    });
  } finally {
    espia.parar();
    if (anterior === null) await updateService.clearPreference();
    else await updateService.setEnabled(anterior);
  }
}

/**
 * Prova que o segredo vai e volta pelo keychain, que o que fica no disco esta
 * cifrado, e que o cadastro guarda so a referencia.
 *
 * O segredo de teste e sorteado na hora e apagado no fim, e o servidor MCP de
 * mentira que serve de alvo tambem: o smoke roda no banco de verdade de quem
 * desenvolve e nao pode deixar cadastro para tras.
 */
async function checkSecrets(): Promise<string> {
  const { installSecretBackend } = await import("./safe-storage.js");
  const { secretService } = await import("../src/services/secret-service.js");
  const { McpService } = await import("../src/services/mcp-service.js");

  if (!installSecretBackend()) throw new Error("keychain indisponivel para o safeStorage");

  const ref = `provider/locum-smoke-${randomUUID().slice(0, 8)}`;
  const segredo = `valor-de-teste-${randomUUID()}`;

  secretService.set(ref, segredo);
  if (secretService.get(ref) !== segredo) throw new Error("segredo nao voltou do keychain");
  if (readFileSync(secretService.pathFor(ref)).includes(segredo)) {
    throw new Error("o cofre gravou o segredo em claro");
  }

  // Caminho inteiro: cadastro com marcador, referencia no banco, segredo so na
  // configuracao que sobe o processo.
  const mcp = new McpService();
  const nome = `locum-smoke-${randomUUID().slice(0, 8)}`;
  try {
    await mcp.register({ name: nome, transport: "stdio", command: ["true"], env: { TOKEN: "${credential}" } });
    await mcp.setCredentialRef(nome, ref);

    const cadastro = await mcp.get(nome);
    if (cadastro?.config.env?.TOKEN !== "${credential}") {
      throw new Error("o cadastro deixou de guardar o marcador");
    }
    if (cadastro.credentialRef !== ref) throw new Error("a referencia nao ficou no banco");

    const paraConectar = (await mcp.enabledConfigs()).find((c) => c.name === nome);
    if (paraConectar?.env?.TOKEN !== segredo) {
      throw new Error("o segredo nao chegou na configuracao de conexao");
    }
  } finally {
    await mcp.remove(nome);
    secretService.remove(ref);
  }

  if (secretService.get(ref) !== undefined) throw new Error("segredo sobreviveu ao remove");
  return t("smoke.secrets");
}

/**
 * Prova que o aviso nativo monta com o run certo e que ele agrupa por run.
 *
 * Nada e mostrado: `show()` nao entra aqui. O smoke roda no loop de
 * verificacao, sem ninguem olhando, e alerta na tela de quem estiver usando a
 * maquina nao e coisa que um teste possa fazer. O clique e simulado no proprio
 * emissor de eventos da notificacao, que e o que prova o destino.
 */
async function checkNotifications(): Promise<string> {
  const { buildNotification, notificationsShown, setupNotifications, teardownNotifications } =
    await import("./notify.js");
  const { criticalNotices } = await import("../src/services/notice-service.js");

  const runId = `run-smoke-${randomUUID().slice(0, 8)}`;
  const critico = { severity: "critical", problem: "leitura fora do limite do vetor" };

  // Duas pendencias do mesmo run, com tres criticos no total: um aviso so.
  const notices = criticalNotices([
    {
      runId,
      agentName: "pr-review",
      createdAt: 1_760_000_000,
      payload: { findings: [critico, { severity: "low", problem: "nome confuso" }] },
    },
    {
      runId,
      agentName: "pr-review",
      createdAt: 1_760_000_060,
      payload: { findings: [critico, critico] },
    },
    { runId: `${runId}-outro`, agentName: "pr-review", createdAt: 1, payload: { findings: [] } },
  ]);

  if (notices.length !== 1) {
    throw new Error(`o mesmo run virou ${notices.length} aviso(s) em vez de um`);
  }
  const [notice] = notices;
  if (notice === undefined) throw new Error("agrupamento nao devolveu aviso");
  if (notice.runId !== runId) throw new Error("o aviso aponta para outro run");
  if (notice.criticalCount !== 3) {
    throw new Error(`o aviso contou ${notice.criticalCount} criticos e o esperado era 3`);
  }
  if (notice.at !== 1_760_000_060) throw new Error("o aviso nao pegou a pendencia mais nova");

  const cliques: string[] = [];
  await setupNotifications({ openInbox: (id) => void cliques.push(id) });

  buildNotification(notice).emit("click");
  if (cliques.length !== 1 || cliques[0] !== runId) {
    throw new Error(`o clique mandou para ${JSON.stringify(cliques)} em vez de ${runId}`);
  }
  if (notificationsShown() !== 0) {
    throw new Error("o smoke mostrou notificacao na tela");
  }
  teardownNotifications();

  return t("smoke.notifications");
}

/**
 * Prova que o esquema `locum://` chega ao tratador e que o token que vem de um
 * retorno de OAuth termina no cofre, com o cadastro guardando so a referencia.
 *
 * A troca do codigo pelo token e de mentira: nao ha servidor de autorizacao
 * para conversar, e o smoke roda sozinho no loop de verificacao, onde chamada
 * de rede so traria intermitencia. O que esta sendo provado e o caminho de
 * dentro, do `open-url` ate o `credential_ref`.
 *
 * O cadastro e o segredo de teste sao sorteados na hora e apagados no fim: o
 * smoke roda no banco de verdade de quem desenvolve.
 */
async function checkDeepLink(): Promise<string> {
  const { emitDeepLink, registerProtocol, setupDeepLink, teardownDeepLink } = await import(
    "./deep-link.js"
  );
  const { installSecretBackend } = await import("./safe-storage.js");
  const { DeepLinkService, parseDeepLink, OAUTH_REDIRECT_URI } = await import(
    "../src/services/deep-link-service.js"
  );
  const { McpService } = await import("../src/services/mcp-service.js");
  const { secretService } = await import("../src/services/secret-service.js");

  if (!installSecretBackend()) throw new Error("keychain indisponivel para o safeStorage");

  const protocolo = await registerProtocol();
  if (protocolo.scheme !== "locum") throw new Error("o esquema registrado nao e locum");

  const mcp = new McpService();
  const deepLink = new DeepLinkService(mcp);
  const nome = `locum-smoke-${randomUUID().slice(0, 8)}`;
  const token = `token-de-teste-${randomUUID()}`;

  const rotas: string[] = [];
  const falhas: string[] = [];
  setupDeepLink(async (url) => {
    const rota = parseDeepLink(url);
    rotas.push(rota.kind);
    if (rota.kind !== "oauth-callback") return;
    try {
      await deepLink.completeOAuth(rota, () => Promise.resolve({ accessToken: token }));
    } catch (error: unknown) {
      falhas.push(error instanceof Error ? error.message : String(error));
    }
  });

  try {
    await mcp.register({
      name: nome,
      transport: "http",
      url: "https://exemplo.invalido/mcp",
      headers: { Authorization: "${credential}" },
    });

    const pedido = await deepLink.beginAuthorization({
      server: nome,
      authorizeUrl: "https://exemplo.invalido/authorize",
      tokenUrl: "https://exemplo.invalido/token",
      clientId: "locum-smoke",
    });
    const autorizacao = new URL(pedido.url);
    if (autorizacao.searchParams.get("code_challenge_method") !== "S256") {
      throw new Error("o pedido de autorizacao saiu sem PKCE");
    }
    if (autorizacao.searchParams.get("redirect_uri") !== `${OAUTH_REDIRECT_URI}?server=${nome}`) {
      throw new Error("o pedido de autorizacao aponta para outro retorno");
    }
    if (!deepLink.isAwaitingCallback(nome)) throw new Error("a autorizacao nao ficou pendente");

    // URL de fora, que nao e do Locum: cai como desconhecida e nao mexe em nada.
    emitDeepLink("https://exemplo.invalido/nao-e-nosso");
    const retorno = `locum://oauth/callback?server=${nome}&code=codigo-de-teste&state=${encodeURIComponent(pedido.state)}`;
    emitDeepLink(retorno);
    // O tratador e assincrono e o emissor do Electron nao espera por ele.
    await new Promise((resolve) => setImmediate(resolve));

    if (falhas.length > 0) throw new Error(`o retorno falhou: ${falhas.join(", ")}`);
    if (rotas.join(",") !== "unknown,oauth-callback") {
      throw new Error(`as rotas vistas foram ${JSON.stringify(rotas)}`);
    }

    const cadastro = await mcp.get(nome);
    if (cadastro?.credentialRef !== `mcp/${nome}`) {
      throw new Error("a referencia da credencial nao ficou no cadastro");
    }
    if (cadastro.config.headers?.Authorization !== "${credential}") {
      throw new Error("o cadastro deixou de guardar o marcador");
    }

    const paraConectar = (await mcp.enabledConfigs()).find((c) => c.name === nome);
    if (paraConectar?.headers?.Authorization !== `Bearer ${token}`) {
      throw new Error("o token nao chegou no cabecalho da conexao");
    }
    if (readFileSync(secretService.pathFor(`mcp/${nome}`)).includes(token)) {
      throw new Error("o cofre gravou o token em claro");
    }

    // Retorno repetido com o mesmo state: o pendente ja foi consumido.
    emitDeepLink(retorno);
    await new Promise((resolve) => setImmediate(resolve));
    if (falhas.length !== 1 || !falhas[0]?.includes("nenhuma autorizacao pendente")) {
      throw new Error(`o state usado duas vezes nao foi recusado: ${JSON.stringify(falhas)}`);
    }
  } finally {
    teardownDeepLink();
    await mcp.remove(nome);
    deepLink.cancelAuthorization(nome);
    secretService.remove(`mcp/${nome}`);
  }

  return t("smoke.deepLink", {
    scheme: t(protocolo.registered ? "smoke.schemeRegistered" : "smoke.schemeRefused"),
  });
}

/**
 * Prova que a janela fala com os servicos pela ponte, e so por ela.
 *
 * A janela sobe com `show: false` e carrega `about:blank`, que e o minimo para
 * o preload rodar: preload so executa quando um documento carrega, entao
 * conferir o arquivo no disco nao provaria nada. Nada aparece na tela, que e o
 * que o smoke exige.
 *
 * O que esta sendo provado e o caminho inteiro: o preload expoe a ponte, o
 * canal atravessa o IPC, o servico responde, e o valor que volta bate com o
 * que o mesmo servico devolve deste lado.
 */
async function checkBridge(): Promise<string> {
  const { bridgeChannelCount, setupBridge, teardownBridge, trustWindow } = await import(
    "./bridge.js"
  );
  const { BRIDGE_GLOBAL } = await import("./bridge-contract.js");
  const { agentService } = await import("../src/services/agent-service.js");

  if (!existsSync(PRELOAD)) throw new Error(`preload nao foi construido em ${PRELOAD}`);

  const canais = setupBridge({ inboxTarget: pendingInboxTarget });
  if (canais !== bridgeChannelCount()) throw new Error("canal registrado a menos");

  const window = createWindow({ show: false });
  trustWindow(window);

  try {
    await window.loadURL("about:blank");

    const visto = (await window.webContents.executeJavaScript(
      `({
        ponte: typeof globalThis.${BRIDGE_GLOBAL},
        agentes: typeof globalThis.${BRIDGE_GLOBAL}?.agents?.list,
        decidir: typeof globalThis.${BRIDGE_GLOBAL}?.approvals?.decide,
        require: typeof globalThis.require,
        process: typeof globalThis.process,
      })`,
    )) as Record<string, string>;

    if (visto["ponte"] !== "object") throw new Error("o preload nao pendurou a ponte na janela");
    if (visto["agentes"] !== "function") throw new Error("a ponte subiu sem os canais");
    if (visto["decidir"] !== "function") throw new Error("a inbox ficou sem o canal de decisao");
    if (visto["require"] !== "undefined" || visto["process"] !== "undefined") {
      throw new Error("a janela enxerga Node, nodeIntegration ou sandbox saiu do lugar");
    }

    const daPonte = (await window.webContents.executeJavaScript(
      `globalThis.${BRIDGE_GLOBAL}.agents.list().then((a) => a.map((x) => x.id))`,
    )) as string[];
    const doServico = (await agentService.list()).map((a) => a.id);
    if (daPonte.join(",") !== doServico.join(",")) {
      throw new Error("a lista que veio pela ponte nao bate com a do servico");
    }

    const pendentes = (await window.webContents.executeJavaScript(
      `globalThis.${BRIDGE_GLOBAL}.approvals.listPending().then((p) => p.length)`,
    )) as number;
    if (pendentes !== (await countPending())) {
      throw new Error("a fila vista pela ponte nao bate com a do servico");
    }

    // Decisao sobre pendencia que nao existe: a gate recusa, e e ela quem
    // recusa. A ponte nao tem o que dizer sobre publicar. O Electron registra
    // sozinho todo erro de handler de IPC, entao a recusa esperada vai aparecer
    // no log logo abaixo: e o teste passando, nao o smoke quebrando.
    console.log(t("smoke.expectedRefusal"));
    const recusa = (await window.webContents.executeJavaScript(
      `globalThis.${BRIDGE_GLOBAL}.approvals.decide("nao-existe", "approved").then(() => "passou", (e) => String(e.message))`,
    )) as string;
    if (!recusa.includes("nao encontrada")) {
      throw new Error(`decisao sobre pendencia inexistente devolveu ${recusa}`);
    }
  } finally {
    window.destroy();
    teardownBridge();
  }

  return t("smoke.bridge", { channels: canais });
}

/**
 * Prova que a pagina construida sobe dentro da janela.
 *
 * A janela nasce com `show: false` e nada aparece na tela: o smoke roda no
 * loop de verificacao, sem ninguem olhando. Quem responde e o proprio
 * renderer, por `executeJavaScript`, que e a unica forma de saber se o React
 * montou de verdade. Conferir o `index.html` no disco nao provaria nada.
 *
 * Alem da raiz, a folha do Tailwind e conferida pelo marcador `hidden` da
 * pagina: raiz montada prova o React, nao prova que o CSS chegou. E o console
 * do renderer entra no exame porque modulo que falha ao carregar deixa a raiz
 * vazia sem estourar deste lado.
 *
 * O bloco de codigo tambem entra, e ele so fica pronto depois da pagina: o
 * shiki destaca de forma assincrona e busca a gramatica da linguagem num
 * pedaco separado do pacote. Por isso a espera abaixo, que e o unico jeito de
 * saber que o import dinamico funciona carregando do disco, sem servidor.
 *
 * E a ponte sobe junto, porque a pagina agora le pelos canais assim que monta.
 * O `checkBridge` prova o caminho com `about:blank` e chamada solta; aqui o que
 * esta sendo provado e a pagina de verdade lendo por conta propria, com o hook
 * no meio, e os valores que ela exibiu conferidos contra os mesmos servicos.
 *
 * A navegacao entre os quatro destinos entra pelo mesmo caminho do clique, que
 * e escrever o hash, porque o loop roda sem ninguem olhando e nao ha clique
 * para dar.
 */
async function checkRenderer(): Promise<string> {
  if (!existsSync(RENDERER)) throw new Error(`renderer nao foi construido em ${RENDERER}`);

  const { setupBridge, teardownBridge, trustWindow } = await import("./bridge.js");
  const { agentService } = await import("../src/services/agent-service.js");
  const { runService } = await import("../src/services/run-service.js");
  const { ensureDemoRun } = await import("../src/fixtures/demo-run.js");
  const { ensureAgentHistory } = await import("../src/fixtures/agent-history.js");
  const { ensureFixtureServer } = await import("../src/fixtures/mcp-fixture.js");
  const { ensureExampleInitiative } = await import("../src/fixtures/initiative.js");

  // Banco vazio faz a tela de execucoes passar sem provar nada: lista vazia e
  // detalhe inexistente batem com servico vazio por acidente. O fixture planta
  // uma execucao pronta, e nao roda o pipeline, que custaria minutos de
  // assinatura a cada verificacao do loop.
  const fixture = await ensureDemoRun();
  // A tela de agents compara duas versoes, e um banco novo so tem uma. O
  // fixture planta a que falta sem rodar nada, e deixa o spec canonico no topo.
  await ensureAgentHistory();
  // A tela de configuracao precisa de um servidor MCP para o botao de testar
  // ter alvo. O de brinquedo nao depende de rede nem de nada instalado, entao
  // conectar nele custa segundos e nao expoe o loop a servidor de terceiro.
  // O binario do Electron em modo Node, e nao o `node` do sistema: o pacote
  // nao pode supor Node instalado na maquina de quem abre o `.app`. O bundle
  // sai do asar porque quem o le e um processo filho, que nao tem o `fs`
  // remendado do Electron e nao enxerga caminho la dentro.
  await ensureFixtureServer({
    command: [process.execPath, foraDoAsar(join(__dirname, "mcp-fixture-server.mjs"))],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
  // A tela de iniciativas precisa de uma para abrir no detalhe. `upsert` e
  // idempotente pelo slug e nunca reescreve o `context.md` depois da primeira
  // vez, entao plantar aqui a cada subida do smoke nao acumula nada.
  await ensureExampleInitiative();

  setupBridge({ inboxTarget: pendingInboxTarget });

  const window = createWindow({ show: false });
  trustWindow(window);
  const erros: string[] = [];
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") erros.push(event.message);
  });

  try {
    await window.loadFile(RENDERER);

    // A espera nao e frescura: a janela pergunta o idioma pela ponte antes de
    // desenhar, e conferir logo depois do `loadFile` pegaria a raiz ainda
    // vazia. Montar em ingles e corrigir depois faria a tela piscar em toda
    // subida de quem escolheu portugues, entao quem espera e o exame.
    const visto = await esperarProbe<{ raiz: number; marca: string; folha: string; faixa: string; conteudo: string }>(
      window,
      "raiz",
      `(() => {
        const raiz = document.getElementById("root");
        if (raiz === null || raiz.childElementCount === 0) return null;
        const probe = document.querySelector("[data-locum-probe=tailwind]");
        return {
          raiz: raiz.childElementCount,
          marca: document.querySelector("[data-locum-probe=marca]")?.textContent ?? "",
          folha: probe === null ? "sem marcador" : getComputedStyle(probe).display,
          faixa: (() => {
            const el = document.querySelector("[data-locum-probe=arrasto]");
            return el === null ? "sem faixa" : getComputedStyle(el).getPropertyValue("-webkit-app-region");
          })(),
          conteudo: (() => {
            const el = document.querySelector("[data-locum-probe=rota]");
            return el === null ? "sem conteudo" : getComputedStyle(el).getPropertyValue("-webkit-app-region");
          })(),
        };
      })()`,
    );

    if (erros.length > 0) throw new Error(`o renderer registrou erro: ${erros.join(", ")}`);
    if (visto.marca !== "Locum") throw new Error(`a barra lateral montou com a marca ${visto.marca}`);
    if (visto.folha !== "none") {
      throw new Error(`o marcador do Tailwind ficou com display ${visto.folha} em vez de none`);
    }
    // Área de arrasto engole roda, clique em textarea e seleção de texto. A
    // faixa tem de arrastar, e o conteúdo que rola não pode: foi assim que a
    // Configuração deixou de rolar.
    if (visto.faixa !== "drag") throw new Error(`a faixa de arrasto ficou com app-region ${visto.faixa}`);
    if (visto.conteudo === "drag") throw new Error("o conteúdo que rola ficou arrastável e não recebe a roda");

    const rotas = await checkRoutes(window);
    const paleta = await checkPalette(window);
    const iniciativas = await checkInitiatives(window);
    // Antes das execucoes de proposito: o `checkRuns` deixa a janela no detalhe
    // de um run, que e onde a verificacao do destaque procura o bloco de codigo.
    const agents = await checkAgents(window);
    const configuracao = await checkConfig(window);
    const revisao = await checkReviewVerdict(window);
    const sessoes = await checkClaudeSessions(window);

    const execucoes = await checkRuns(window, fixture);
    // O bloco de codigo mora no detalhe de uma execucao, que e quem vai usa-lo
    // de verdade: a saida de cada passo sai como JSON destacado. O `checkRuns`
    // deixa a janela nesse detalhe, entao o destaque e conferido de onde ele
    // aparece.
    const destacado = await esperarDestaque(window);
    const ponte = await esperarPonte(window);
    // Por ultimo de proposito: o exame recarrega a janela, e recarregar antes
    // jogaria fora o destino em que os outros exames deixaram a pagina.
    const idioma = await checkI18n(window);

    const agentes = (await agentService.list()).map((a) => a.id).join(",");
    if (ponte.agents !== agentes) {
      throw new Error(`a janela leu os agents ${ponte.agents} e o servico tem ${agentes}`);
    }
    const total = (await runService.list()).length;
    if (ponte.runs !== total) {
      throw new Error(`a janela leu ${ponte.runs} execucao(oes) e o servico tem ${total}`);
    }
    const pendencias = await countPending();
    if (ponte.pendencias !== pendencias) {
      throw new Error(`a janela leu ${ponte.pendencias} pendencia(s) e a fila tem ${pendencias}`);
    }

    if (erros.length > 0) throw new Error(`o renderer registrou erro: ${erros.join(", ")}`);

    return t("smoke.renderer", {
      routes: rotas,
      palette: paleta,
      initiatives: iniciativas,
      agents,
      config: configuracao,
      review: revisao,
      sessions: sessoes,
      runs: execucoes,
      spans: destacado,
      windowRuns: ponte.runs,
      windowPending: ponte.pendencias,
      language: idioma,
    });
  } finally {
    // As capturas usam esta mesma janela, com a ponte ainda de pé: derrubar
    // antes deixaria a página sem quem responder e ela nem monta.
    if (capturas) await capturarTelas(window);
    window.destroy();
    teardownBridge();
  }
}

/**
 * Espera as leituras da pagina terminarem e devolve o que ela exibiu.
 *
 * A pagina monta antes de a ponte responder, entao conferir logo depois do
 * `loadFile` pegaria o estado de carregando. O marcador guarda o estado junto
 * dos valores justamente para que a espera saiba a hora, em vez de dormir um
 * tempo arbitrario e torcer.
 */
async function esperarPonte(
  window: BrowserWindow,
): Promise<{ agents: string; runs: number; pendencias: number }> {
  const limite = Date.now() + 20_000;
  let ultimo = "sem marcador";

  while (Date.now() < limite) {
    const visto = (await window.webContents.executeJavaScript(
      `(() => {
        const probe = document.querySelector("[data-locum-probe=ponte]");
        if (probe === null) return null;
        return {
          estado: probe.dataset.estado,
          erro: probe.dataset.erro,
          agents: probe.dataset.agents,
          runs: Number(probe.dataset.runs),
          pendencias: Number(probe.dataset.pendencias),
        };
      })()`,
    )) as { estado: string; erro: string; agents: string; runs: number; pendencias: number } | null;

    if (visto !== null) {
      if (visto.estado === "erro") throw new Error(`a janela nao leu pela ponte: ${visto.erro}`);
      if (visto.estado === "pronto") return visto;
      ultimo = visto.estado;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`as leituras da janela ficaram em "${ultimo}" por 20s`);
}

/**
 * Poe a janela num destino e espera a tela trocar.
 *
 * A navegacao e por hash porque nao existe servidor atras da pagina, e escrever
 * o hash e exatamente o que o clique na barra lateral faz: o caminho exercitado
 * aqui e o mesmo que uma pessoa usa.
 */
/**
 * Abre o painel de uma conexão na vitrine, que é onde mora o formulário dela.
 * Painel de outra conexão aberto antes é fechado primeiro, para o formulário
 * procurado não ficar escondido atrás dele.
 */
async function abrirConexao(window: BrowserWindow, id: string): Promise<void> {
  await esperarProbe<true>(
    window,
    `cartão ${id}`,
    `(() => {
      const aberto = document.querySelector("[data-locum-painel-conexao]");
      if (aberto !== null && aberto.dataset.locumPainelConexao !== ${JSON.stringify(id)}) {
        aberto.querySelector("header button")?.click();
        return null;
      }
      if (aberto !== null) return true;
      const botao = document.querySelector('[data-locum-conexao=${JSON.stringify(id)}] button');
      if (botao === null) return null;
      botao.click();
      return null;
    })()`,
  );
}

async function irPara(window: BrowserWindow, id: string, detalhe?: string): Promise<void> {
  const cauda = detalhe === undefined ? "" : `/${encodeURIComponent(detalhe)}`;
  const esperado = `${id}|${detalhe ?? ""}`;
  await window.webContents.executeJavaScript(`(location.hash = "#/${id}${cauda}", null)`);

  const limite = Date.now() + 10_000;
  let ultimo = "sem marcador";

  while (Date.now() < limite) {
    const onde = (await window.webContents.executeJavaScript(
      `(() => {
        const probe = document.querySelector("[data-locum-probe=rota]");
        return probe === null ? null : probe.dataset.ativo + "|" + probe.dataset.detalhe;
      })()`,
    )) as string | null;

    if (onde === esperado) return;
    if (onde !== null) ultimo = onde;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`a janela ficou em "${ultimo}" depois de pedir o destino ${esperado}`);
}

/**
 * Confere os quatro destinos e que navegar entre eles troca a tela.
 *
 * Os identificadores e os titulos saem da propria barra lateral, e nao de uma
 * copia deste lado: uma lista repetida aqui passaria a concordar com ela mesma
 * no dia em que o catalogo do renderer mudasse. O que fica escrito deste lado e
 * so a exigencia da story, que sao estes quatro destinos.
 */
async function checkRoutes(window: BrowserWindow): Promise<string> {
  const esperados = ["today", "inbox", "initiatives", "runs", "agents", "sessions", "settings"];

  const barra = (await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll("[data-locum-rota]")).map((b) => ({
      id: b.dataset.locumRota,
      titulo: b.querySelector("span")?.textContent ?? "",
    }))`,
  )) as { id: string; titulo: string }[];

  const ids = barra.map((r) => r.id);
  if (ids.join(",") !== esperados.join(",")) {
    throw new Error(`a barra lateral oferece ${ids.join(",")} e nao ${esperados.join(",")}`);
  }

  const inicial = (await window.webContents.executeJavaScript(
    `document.querySelector("[data-locum-probe=rota]")?.dataset.ativo ?? null`,
  )) as string | null;
  if (inicial !== esperados[0]) {
    throw new Error(`com o hash vazio a janela abriu em ${inicial} e nao em ${esperados[0]}`);
  }

  // O cabeçalho que repetia o nome do destino saiu, porque a barra lateral já
  // marca onde a pessoa está. Quem responde qual destino está ativo passa a ser
  // a própria marcação da barra, que é o que alguém usando o aplicativo lê.
  for (const { id, titulo } of barra) {
    await irPara(window, id);

    const visto = (await window.webContents.executeJavaScript(
      `(() => {
        const ativo = document.querySelector("[data-locum-rota][aria-current=page]");
        return {
          marcado: ativo?.dataset.locumRota ?? null,
          titulo: ativo?.querySelector("span")?.textContent ?? "",
        };
      })()`,
    )) as { titulo: string; marcado: string | null };

    if (visto.marcado !== id) {
      throw new Error(`o destino ${id} esta ativo e a barra marca ${visto.marcado}`);
    }
    if (visto.titulo !== titulo) {
      throw new Error(`a barra marca ${id} com o nome ${visto.titulo} e nao ${titulo}`);
    }
  }

  // Um destino desconhecido nao pode deixar a janela em branco: quem chegar por
  // hash velho, ou por deep link de uma versao anterior, cai no padrao.
  await irPara(window, esperados[0] as string);
  await window.webContents.executeJavaScript(`(location.hash = "#/nao-existe", null)`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const desconhecido = (await window.webContents.executeJavaScript(
    `document.querySelector("[data-locum-probe=rota]")?.dataset.ativo ?? null`,
  )) as string | null;
  if (desconhecido !== esperados[0]) {
    throw new Error(`hash desconhecido levou a janela para ${desconhecido}`);
  }

  // O nome em português de antes da 0.1.20 ainda chega por deep link e janela
  // restaurada, e precisa levar ao mesmo lugar, seção incluída.
  await window.webContents.executeJavaScript(`(location.hash = "#/configuracao/conexoes", null)`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const antigo = (await window.webContents.executeJavaScript(
    `[document.querySelector("[data-locum-probe=rota]")?.dataset.ativo, location.hash].join("|")`,
  )) as string;
  if (antigo !== "settings|#/settings/connections") {
    throw new Error(`hash antigo de Conexões levou a ${antigo}`);
  }

  return t("smoke.routes", { count: barra.length });
}

/**
 * A tela de sessões do Claude, lendo a pasta de exemplo: a chamada por
 * programa fica de fora, cada estado aparece onde deve, e "Terminei" tira a
 * sessão de "pela metade" e "Reabrir" devolve.
 */
async function checkClaudeSessions(window: BrowserWindow): Promise<string> {
  await irPara(window, "sessions");
  const contar = `(() => {
    const p = document.querySelector("[data-locum-probe=sessions]");
    return p && p.dataset.estado === "ready" ? Number(p.dataset.sessoes) : null;
  })()`;
  const total = await esperarProbe<number>(window, "sessions", contar);
  if (total !== 3) throw new Error(`a tela de sessões mostrou ${total} sessão(ões) e não 3`);

  const estadoDe = (id: string) =>
    `document.querySelector('[data-locum-sessao="${id}"]')?.dataset.locumSessaoEstado ?? null`;
  const estados = (await window.webContents.executeJavaScript(
    `[${[SESSOES_DE_EXEMPLO.aberta, SESSOES_DE_EXEMPLO.interrompida, SESSOES_DE_EXEMPLO.pelaMetade].map(estadoDe).join(",")}]`,
  )) as (string | null)[];
  if (estados.join(",") !== "working,interrupted,unfinished") {
    throw new Error(`a tela de sessões classificou como ${estados.join(",")}`);
  }

  const alvo = SESSOES_DE_EXEMPLO.pelaMetade;
  await window.webContents.executeJavaScript(
    `(document.querySelector('[data-locum-sessao="${alvo}"] [data-locum-sessao-terminar]')?.click(), null)`,
  );
  await esperarProbe(window, "sessao terminada", `(${estadoDe(alvo)}) === "done" || document.querySelector('[data-locum-sessao="${alvo}"]') === null ? true : null`);
  // Terminadas ficam recolhidas; abrir o grupo e reabrir devolve a sessão.
  await window.webContents.executeJavaScript(
    `(document.querySelector("[aria-expanded=false]")?.click(), null)`,
  );
  await esperarProbe(window, "grupo de terminadas", `document.querySelector('[data-locum-sessao="${alvo}"] [data-locum-sessao-reabrir]') ? true : null`);
  await window.webContents.executeJavaScript(
    `(document.querySelector('[data-locum-sessao="${alvo}"] [data-locum-sessao-reabrir]')?.click(), null)`,
  );
  await esperarProbe(window, "sessao reaberta", `(${estadoDe(alvo)}) === "unfinished" ? true : null`);

  return t("smoke.claudeSessions", { count: total });
}

/**
 * Confere que o atalho abre a paleta de comandos e que Escape a fecha.
 *
 * Ela ainda nao tem comando nenhum dentro, entao o que esta sendo provado e o
 * atalho: o ouvinte de teclado esta no ar e o estado da paleta responde a ele.
 */
async function checkPalette(window: BrowserWindow): Promise<string> {
  const estado = async (): Promise<string | null> =>
    (await window.webContents.executeJavaScript(
      `document.querySelector("[data-locum-probe=paleta]")?.dataset.aberta ?? null`,
    )) as string | null;

  const tecla = async (script: string): Promise<void> => {
    await window.webContents.executeJavaScript(script);
    // O estado e do React, que pinta no proximo quadro: perguntar na mesma
    // linha pegaria o valor anterior.
    await new Promise((resolve) => setTimeout(resolve, 200));
  };

  if ((await estado()) !== "nao") throw new Error("a paleta nasceu aberta");

  await tecla(
    `(document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })), null)`,
  );
  if ((await estado()) !== "sim") throw new Error("o atalho nao abriu a paleta de comandos");

  await tecla(
    `(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), null)`,
  );
  if ((await estado()) !== "nao") throw new Error("Escape nao fechou a paleta de comandos");

  // O painel do assistente cobre a faixa de arrasto do topo, onde mora o X
  // dele. Sem se declarar fora do arrasto, o clique no X vira arrastar janela.
  await tecla(
    `(globalThis.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true })), null)`,
  );
  const painel = (await window.webContents.executeJavaScript(
    `(() => {
      const el = document.querySelector("[data-locum-probe=assistente-painel]");
      return el === null ? null : getComputedStyle(el).getPropertyValue("-webkit-app-region");
    })()`,
  )) as string | null;
  if (painel === null) throw new Error("o atalho nao abriu o painel do assistente");
  if (painel !== "no-drag") throw new Error(`o painel do assistente ficou com app-region ${painel}, e o X cai no arrasto`);
  await tecla(`(document.querySelector("[data-locum-probe=assistente-painel] header button")?.click(), null)`);
  const fechou = (await window.webContents.executeJavaScript(
    `document.querySelector("[data-locum-probe=assistente-painel]") === null`,
  )) as boolean;
  if (!fechou) throw new Error("o X nao fechou o painel do assistente");

  return t("smoke.palette");
}

/**
 * Confere a tela de iniciativas: a lista e as abas do detalhe.
 *
 * So a aba de contexto e conferida a fundo, contra o que o servico devolve para
 * `context.md`: e a unica que le de verdade nesta fatia. As outras quatro so
 * precisam trocar a marcacao da aba ativa, porque so mostrar leitura que a
 * janela ja pediu no detalhe composto, sem canal proprio nenhum.
 */
async function checkInitiatives(window: BrowserWindow): Promise<string> {
  const { initiativeService } = await import("../src/services/initiative-service.js");

  await irPara(window, "initiatives");
  const lista = await esperarProbe<{ total: number }>(
    window,
    "initiatives",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=initiatives]");
      if (probe === null || probe.dataset.estado !== "ready") return null;
      return { total: Number(probe.dataset.total) };
    })()`,
  );

  const doServico = await initiativeService.list();
  if (lista.total !== doServico.length) {
    throw new Error(`a lista de iniciativas mostrou ${lista.total} e o servico tem ${doServico.length}`);
  }

  const linha = await initiativeService.get("example");
  if (linha === undefined) throw new Error('a iniciativa semente "example" nao esta cadastrada');

  await irPara(window, "initiatives", "example/context");
  const contexto = await esperarProbe<{ slug: string; titulo: string }>(
    window,
    "initiative",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=initiative]");
      const conteudo = document.querySelector("[data-locum-probe=initiative-context]");
      if (probe === null || conteudo === null || probe.dataset.tab !== "context") return null;
      return { slug: probe.dataset.slug, titulo: probe.dataset.titulo };
    })()`,
  );

  if (contexto.slug !== "example") throw new Error(`o detalhe abriu no slug ${contexto.slug} e nao example`);
  if (contexto.titulo !== linha.title) {
    throw new Error(`o detalhe mostrou o titulo "${contexto.titulo}" e o servico tem "${linha.title}"`);
  }

  const textoDoContexto = (await window.webContents.executeJavaScript(
    `document.querySelector("[data-locum-probe=initiative-context]")?.textContent ?? ""`,
  )) as string;
  const doArquivo = await initiativeService.readContext("example");
  if (doArquivo.content === null || !textoDoContexto.includes(linha.title)) {
    throw new Error(`a aba de contexto nao mostrou o titulo "${linha.title}"`);
  }

  await irPara(window, "initiatives", "example/agents");
  const abaAgents = await esperarProbe<{ tab: string }>(
    window,
    "initiative",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=initiative]");
      if (probe === null || probe.dataset.tab !== "agents") return null;
      return { tab: probe.dataset.tab };
    })()`,
  );
  if (abaAgents.tab !== "agents") throw new Error(`a aba ficou em "${abaAgents.tab}" e nao em "agents"`);

  // Os botoes de sessao sao conferidos por existir, e nunca clicados: o clique
  // abriria um terminal de verdade. A fiacao do servico vai com um espiao.
  await irPara(window, "initiatives", "example/actions");
  await esperarProbe<{ botoes: number }>(
    window,
    "initiative-session",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=initiative-session]");
      const botoes = probe?.querySelectorAll("button").length ?? 0;
      return botoes === 2 ? { botoes } : null;
    })()`,
  );
  await checkSessionWiring();

  return t("smoke.initiatives", { initiatives: lista.total });
}

/**
 * Abre a sessao da semente com `exec` espiao e confere o que ficaria pronto
 * para o terminal: o script, o prompt, as regras de `deny` e o `open -a`.
 */
async function checkSessionWiring(): Promise<void> {
  const { SessionService } = await import("../src/services/session-service.js");
  const chamadas: { command: string; args: string[] }[] = [];
  const service = new SessionService({
    exec: async (command, args) => {
      chamadas.push({ command, args });
    },
    resolveClaude: async () => "/bin/echo",
  });

  const aberta = await service.open("example", { terminal: "terminal" });
  const pasta = dirname(dirname(aberta.scriptPath));
  for (const arquivo of ["session.md", "session-settings.json", "open-session.command"]) {
    if (!existsSync(join(pasta, ".locum", arquivo))) throw new Error(`a sessao nao gravou .locum/${arquivo}`);
  }
  const esperado = JSON.stringify([{ command: "open", args: ["-a", "Terminal", aberta.scriptPath] }]);
  if (JSON.stringify(chamadas) !== esperado) {
    throw new Error(`a sessao chamou ${JSON.stringify(chamadas)} e o esperado era ${esperado}`);
  }
  if ((await service.readHandoff("example")) !== null) {
    throw new Error("a sessao recem aberta ja tinha passagem para ler");
  }
}

/**
 * Confere a tela de agents: a lista, o historico e a comparacao de versoes.
 *
 * Tudo que a janela mostra e conferido contra os mesmos servicos, e nao contra
 * numeros escritos aqui. O unico valor deste lado e a exigencia da story, que e
 * a diferenca de modo do passo de acao aparecer na comparacao: qual modo e de
 * cada versao sai do banco, porque o fixture pode mudar e o teste continua
 * valendo.
 *
 * O botao de contar tokens e conferido por existir, e nunca clicado. Clicar
 * subiria os servidores MCP citados pelo spec, e o loop roda sem ninguem
 * olhando: o que esta sendo provado aqui e a fiacao.
 */
async function checkAgents(window: BrowserWindow): Promise<string> {
  const { agentService } = await import("../src/services/agent-service.js");
  const { machineId } = await import("../src/services/machine-service.js");
  const { providerService } = await import("../src/services/provider-service.js");

  await irPara(window, "agents");
  const lista = await esperarProbe<{ agents: string; total: number }>(
    window,
    "agents",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=agents]");
      if (probe === null || probe.dataset.estado !== "ready") return null;
      return { agents: probe.dataset.agents, total: Number(probe.dataset.total) };
    })()`,
  );

  const doServico = await agentService.list();
  if (lista.agents !== doServico.map((a) => a.id).join(",")) {
    throw new Error(`a lista mostrou ${lista.agents} e o servico devolveu ${doServico.length} agent(s)`);
  }

  const desenhadas = (await window.webContents.executeJavaScript(
    `document.querySelectorAll("[data-locum-agent]").length`,
  )) as number;
  if (desenhadas !== doServico.length) {
    throw new Error(`a lista desenhou ${desenhadas} linha(s) para ${doServico.length} agent(s)`);
  }

  // Agent novo pela lista parte de um existente: o botão abre a escolha da
  // base já com o primeiro agent e o formulário da duplicação embaixo.
  const novo = (await window.webContents.executeJavaScript(
    `(async () => {
      document.querySelector("[data-locum-agent-novo]")?.click();
      for (let i = 0; i < 50; i++) {
        const painel = document.querySelector("[data-locum-probe=agent-novo]");
        if (painel !== null) return painel.querySelectorAll("option").length;
        await new Promise((r) => setTimeout(r, 50));
      }
      return -1;
    })()`,
  )) as number;
  if (novo !== doServico.length) {
    throw new Error(`o agent novo ofereceu ${novo} base(s) para ${doServico.length} agent(s)`);
  }

  // Criar com IA só aparece quando há quem escreva o rascunho. O smoke abre o
  // painel e não pede rascunho: isso chamaria modelo.
  const { criadorDisponivel } = await import("./agent-builder.js");
  const criador = await criadorDisponivel();
  const painelDaIa = (await window.webContents.executeJavaScript(
    `(async () => {
      for (let i = 0; i < 50; i++) {
        const botao = document.querySelector("[data-locum-agent-ia]");
        if (botao !== null) {
          botao.click();
          for (let j = 0; j < 50; j++) {
            if (document.querySelector("[data-locum-probe=agent-ia] textarea") !== null) return "aberto";
            await new Promise((r) => setTimeout(r, 50));
          }
          return "sem painel";
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return "sem botao";
    })()`,
  )) as string;
  if (painelDaIa !== (criador.disponivel ? "aberto" : "sem botao")) {
    throw new Error(`criar com IA: ${painelDaIa} com criador ${criador.disponivel ? "disponível" : "indisponível"}`);
  }

  // O alvo e quem tem historico: comparar versao exige duas, e um agent de uma
  // versao so provaria a tela de lista mais uma vez.
  let alvo: string | undefined;
  for (const agent of doServico) {
    if ((await agentService.listVersions(agent.id)).length >= 2) {
      alvo = agent.id;
      break;
    }
  }
  if (alvo === undefined) throw new Error("nenhum agent tem duas versoes para comparar");

  await irPara(window, "agents", alvo);
  const detalhe = await esperarProbe<{
    versoes: string;
    versao: number;
    comparando: string;
    diff: number;
    saiu: string;
    entrou: string;
  }>(
    window,
    "agent",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=agent]");
      const diff = document.querySelector("[data-locum-probe=diff]");
      const passos = document.querySelector("[data-locum-passos]");
      // As previas de modelo sao uma terceira leitura, e ela so comeca depois
      // que o perfil da maquina chega: girar ate ela terminar e o que separa
      // conferir o que a maquina resolve de conferir o estado de carregando.
      if (probe === null || diff === null || passos === null) return null;
      if (probe.dataset.versoes === "") return null;
      if (passos.dataset.locumMaquina === "" || passos.dataset.locumPrevias !== "ready") return null;
      return {
        versoes: probe.dataset.versoes,
        versao: Number(probe.dataset.versao),
        comparando: probe.dataset.comparando,
        diff: Number(diff.dataset.locumDiff),
        saiu: diff.dataset.locumSaiu ?? "",
        entrou: diff.dataset.locumEntrou ?? "",
      };
    })()`,
  );

  const versoes = await agentService.listVersions(alvo);
  if (detalhe.versoes !== versoes.map((v) => v.version).join(",")) {
    throw new Error(`o historico mostrou ${detalhe.versoes} e o servico tem ${versoes.length} versao(oes)`);
  }
  if (detalhe.versao !== versoes[0]!.version) {
    throw new Error(`a tela abriu na v${detalhe.versao} e o topo do historico e a v${versoes[0]!.version}`);
  }

  const atual = versoes[0]!;
  const anterior = versoes[1]!;
  if (detalhe.comparando !== `${anterior.version}:${atual.version}`) {
    throw new Error(`a comparacao ficou em ${detalhe.comparando} e o par esperado e o topo com o anterior`);
  }

  const modo = (v: (typeof versoes)[number]): string | undefined =>
    v.spec.steps.find((p) => p.type === "action")?.mode;
  const de = modo(anterior);
  const para = modo(atual);
  if (de === undefined || para === undefined) {
    throw new Error(`a v${anterior.version} ou a v${atual.version} nao tem passo de acao`);
  }
  if (de === para) {
    throw new Error(`as duas versoes do topo tem o passo de acao em "${de}", nao ha diferenca de modo`);
  }
  if (detalhe.diff === 0) throw new Error("a comparacao nao apontou nenhuma linha diferente");
  if (!detalhe.saiu.includes(`"mode": "${de}"`)) {
    throw new Error(`a comparacao nao mostrou o modo "${de}" saindo da v${anterior.version}`);
  }
  if (!detalhe.entrou.includes(`"mode": "${para}"`)) {
    throw new Error(`a comparacao nao mostrou o modo "${para}" entrando na v${atual.version}`);
  }

  // O que a maquina resolve para cada passo de modelo, conferido contra o mesmo
  // servico: uma tabela repetida deste lado passaria a concordar consigo mesma.
  const naTela = (await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll("[data-locum-modelo]")).map((e) => ({
      pedido: e.dataset.locumModelo,
      resolvido: e.dataset.locumResolvido ?? "",
    }))`,
  )) as { pedido: string; resolvido: string }[];

  const passosDeModelo = atual.spec.steps.filter((p) => p.type === "model");
  if (naTela.length !== passosDeModelo.length) {
    throw new Error(
      `a tela mostrou ${naTela.length} resolucao(oes) e a v${atual.version} tem ${passosDeModelo.length} passo(s) de modelo`,
    );
  }

  const previas = await providerService.resolvePreviews(
    passosDeModelo.map((p) => p.model),
    machineId,
  );
  for (const [i, passo] of passosDeModelo.entries()) {
    const previa = previas[i]!;
    const esperado = previa.ok ? previa.resolution.used : "";
    if (naTela[i]!.pedido !== passo.model) {
      throw new Error(`o passo ${passo.key} mostrou o modelo ${naTela[i]!.pedido} e o spec pede ${passo.model}`);
    }
    if (naTela[i]!.resolvido !== esperado) {
      throw new Error(
        `o passo ${passo.key} resolveu para "${naTela[i]!.resolvido}" na tela e "${esperado}" no servico`,
      );
    }
  }

  // Um spec sem ferramenta nao tem botao, e isso nao e falha: o agent semente
  // herda a lista vazia. O que nao pode e existir ferramenta sem como contar.
  const comFerramenta = passosDeModelo.filter(
    (p) => (p.tools ?? atual.spec.defaultTools).length > 0,
  ).length;
  const botoes = (await window.webContents.executeJavaScript(
    `document.querySelectorAll("[data-locum-contar]").length`,
  )) as number;
  if (botoes !== comFerramenta) {
    throw new Error(`${botoes} botao(oes) de contar token para ${comFerramenta} passo(s) com ferramenta`);
  }

  return t("smoke.agents", {
    agents: lista.total,
    versions: versoes.length,
    agent: alvo,
    from: de,
    to: para,
  });
}

/**
 * Confere a tela de configuracao.
 *
 * As quatro secoes sao comparadas contra os mesmos servicos que a janela leu
 * pela ponte, e nao contra numeros escritos deste lado: uma tabela repetida
 * aqui passaria a concordar consigo mesma no dia em que a tela mudasse.
 *
 * O botao de testar conexao e clicado, ao contrario do de reexecutar passo.
 * A diferenca nao e de gosto: reexecutar solta o executor de verdade e gasta
 * assinatura, enquanto testar sobe o servidor de brinquedo, que e local e nao
 * fala com ninguem. E e o unico jeito de provar o que a story pede, que e o
 * teste respondendo na interface e nao so o canal existindo.
 *
 * O que nao aparece em lugar nenhum e valor de segredo, e a verificacao cobra
 * isso: o marcador de credencial carrega a referencia e se ha algo guardado,
 * e mais nada.
 */
async function checkConfig(window: BrowserWindow): Promise<string> {
  const { agentService } = await import("../src/services/agent-service.js");
  const { machineId } = await import("../src/services/machine-service.js");
  const { mcpService } = await import("../src/services/mcp-service.js");
  const { providerService } = await import("../src/services/provider-service.js");
  const { FIXTURE_SERVER } = await import("../src/fixtures/mcp-fixture.js");

  await irPara(window, "settings", "models");
  const tela = await esperarProbe<{
    maquina: string;
    provedores: string;
    fallbacks: number;
    servidores: string;
  }>(
    window,
    "settings",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=settings]");
      if (probe === null || probe.dataset.estado !== "pronto") return null;
      return {
        maquina: probe.dataset.locumMaquina,
        provedores: probe.dataset.locumProvedores,
        fallbacks: Number(probe.dataset.locumFallbacks),
        servidores: probe.dataset.locumServidores,
      };
    })()`,
  );

  if (tela.maquina !== machineId) {
    throw new Error(`a tela diz estar em "${tela.maquina}" e a maquina e "${machineId}"`);
  }

  // A Configuração é a tela mais longa, e foi nela que o scroll quebrou. Aqui
  // se confere que o conteúdo passa da janela e que a área que rola anda; a
  // roda de verdade depende também de ela não ser arrastável, que a subida da
  // interface já confere.
  const rolagem = (await window.webContents.executeJavaScript(
    `(() => {
      const main = document.querySelector("[data-locum-probe=rota]");
      const antes = main.scrollTop;
      main.scrollTop = 400;
      const depois = main.scrollTop;
      main.scrollTop = antes;
      return { sobra: main.scrollHeight - main.clientHeight, andou: depois - antes };
    })()`,
  )) as { sobra: number; andou: number };
  if (rolagem.sobra > 0 && rolagem.andou <= 0) {
    throw new Error(`a Configuração passa ${rolagem.sobra}px da janela e não rola`);
  }

  const provedores = providerService.listProviders();
  if (tela.provedores !== provedores.map((p) => p.name).join(",")) {
    throw new Error(
      `a tela listou os provedores ${tela.provedores} e o servico tem ${provedores.length}`,
    );
  }

  // Disponibilidade por provider, e nao so a contagem: uma tela que mostrasse
  // todo mundo como indisponivel teria a mesma lista e diria outra coisa.
  const disponiveis = (await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll("[data-locum-provider]")).map((e) => ({
      nome: e.dataset.locumProvider,
      disponivel: e.dataset.locumDisponivel,
    }))`,
  )) as { nome: string; disponivel: string }[];
  // Por nome, e nao por posicao: a tela separa os ligados dos que faltam
  // ligar, entao a ordem dela nao e a do servico.
  for (const provedor of provedores) {
    const naTela = disponiveis.find((d) => d.nome === provedor.name);
    const esperado = provedor.available ? "sim" : "nao";
    if (naTela === undefined || naTela.disponivel !== esperado) {
      throw new Error(
        `o provider ${provedor.name} aparece como "${naTela?.disponivel ?? "ausente"}" e o servico diz "${esperado}"`,
      );
    }
  }

  const fallbacks = await providerService.getFallbacks(machineId);
  const linhasDeFallback = (await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll("[data-locum-fallback]")).map((e) => e.dataset.locumFallback)`,
  )) as string[];
  const esperadas = fallbacks.map((f) => `${f.fromModel}>${f.toModel}`);
  if (tela.fallbacks !== fallbacks.length || linhasDeFallback.join("|") !== esperadas.join("|")) {
    throw new Error(
      `a tabela de substituicao desenhou ${linhasDeFallback.length} linha(s) ` +
        `(${linhasDeFallback.join("|")}, contador ${tela.fallbacks}) e o servico tem ` +
        `${fallbacks.length} (${esperadas.join("|")})`,
    );
  }

  const servidores = await mcpService.list();
  if (tela.servidores !== servidores.map((s) => s.config.name).join(",")) {
    throw new Error(
      `a tela listou os servidores ${tela.servidores} e o servico tem ${servidores.length}`,
    );
  }
  if (!tela.servidores.split(",").includes(FIXTURE_SERVER)) {
    throw new Error(`o servidor de brinquedo ${FIXTURE_SERVER} nao apareceu na tela`);
  }

  // O orçamento saiu da Configuração e mora no detalhe de cada agent: cada um
  // tem de mostrar a linha dele lá.
  const orcamentos = await agentService.budgets();
  for (const orcamento of orcamentos) {
    await irPara(window, "agents", orcamento.agentId);
    await esperarProbe<true>(
      window,
      `orçamento de ${orcamento.agentId}`,
      `document.querySelector('[data-locum-orcamento="${orcamento.agentId}"]') === null ? null : true`,
    );
  }
  await irPara(window, "settings", "connections");

  // Segredo nao tem como chegar na tela, porque nao ha canal que o devolva. O
  // que da para conferir daqui e que o marcador nao guarda nada alem do
  // endereco e do sim ou nao, e e isso que esta sendo olhado.
  const credenciais = (await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll("[data-locum-credencial]")).map((e) => ({
      ref: e.dataset.locumCredencial,
      guardado: e.dataset.locumGuardado,
    }))`,
  )) as { ref: string; guardado: string }[];
  for (const credencial of credenciais) {
    if (credencial.guardado !== "sim" && credencial.guardado !== "nao") {
      throw new Error(`a credencial ${credencial.ref} mostrou "${credencial.guardado}"`);
    }
  }

  // O clique, que e o ponto da story. Ele sobe o servidor de brinquedo, que e
  // local: nao ha rede, nao ha assinatura e nao ha nada publicado.
  const clicou = (await window.webContents.executeJavaScript(
    `(() => {
      const botao = document.querySelector('[data-locum-testar="${FIXTURE_SERVER}"]');
      if (botao === null) return false;
      botao.click();
      return true;
    })()`,
  )) as boolean;
  if (!clicou) throw new Error(`a tela nao ofereceu botao de testar ${FIXTURE_SERVER}`);

  // Subir o processo e esperar a primeira resposta leva mais que uma leitura
  // de banco, e o tsx ainda compila o fixture antes de responder.
  const resultado = await esperarProbe<{ ok: string; ferramentas: number }>(
    window,
    `teste de ${FIXTURE_SERVER}`,
    `(() => {
      const probe = document.querySelector('[data-locum-teste="${FIXTURE_SERVER}"]');
      if (probe === null) return null;
      return { ok: probe.dataset.locumOk, ferramentas: Number(probe.dataset.locumFerramentas) };
    })()`,
    60_000,
  );

  const doServico = await mcpService.testConnection(FIXTURE_SERVER);
  if (resultado.ok !== (doServico.ok ? "sim" : "nao")) {
    throw new Error(
      `a tela disse "${resultado.ok}" para a conexao e o servico disse "${doServico.ok ? "sim" : "nao"}"` +
        (doServico.error === undefined ? "" : `: ${doServico.error}`),
    );
  }
  if (!doServico.ok) throw new Error(`o servidor de brinquedo nao conectou: ${doServico.error}`);

  // O teste grava a conexão no cadastro, e a linha relê: o selo tem de dizer
  // que o servidor respondeu.
  const saude = await esperarProbe<string>(
    window,
    `saúde de ${FIXTURE_SERVER}`,
    `(() => document.querySelector('[data-locum-servidor="${FIXTURE_SERVER}"] [data-locum-saude]')?.dataset.locumSaude ?? null)()`,
  );
  if (saude !== "ok") throw new Error(`o selo de ${FIXTURE_SERVER} mostrou "${saude}" depois de conectar`);
  const gravada = (await mcpService.get(FIXTURE_SERVER))?.health;
  if (gravada?.lastOkAt === null || gravada?.lastOkAt === undefined) {
    throw new Error(`o cadastro de ${FIXTURE_SERVER} não guardou a conexão`);
  }

  // Credencial recusada vira aviso na Hoje, e some quando o servidor volta.
  // A falha vai carimbada à frente do relógio: a tela ainda pode estar listando
  // as ferramentas do servidor, e essa conexão grava um OK que, com o carimbo de
  // agora, chegaria depois da falha e apagaria o aviso antes da Hoje ler.
  const adiante = Date.now() + 60 * 60_000;
  await mcpService.recordConnection(FIXTURE_SERVER, { ok: false, error: "HTTP 401: Unauthorized" }, new Date(adiante));
  try {
    await irPara(window, "today");
    const avisados = await esperarProbe<string>(
      window,
      "aviso de credencial na Hoje",
      `(() => document.querySelector("[data-locum-probe=hoje-credencial]")?.dataset.servidores ?? null)()`,
    );
    if (!avisados.split(",").includes(FIXTURE_SERVER)) {
      throw new Error(`a Hoje avisou ${avisados} e não ${FIXTURE_SERVER}`);
    }
  } finally {
    await mcpService.recordConnection(FIXTURE_SERVER, { ok: true }, new Date(adiante + 1));
  }
  await irPara(window, "settings");
  if (resultado.ferramentas !== doServico.toolCount) {
    throw new Error(
      `a tela contou ${resultado.ferramentas} ferramenta(s) e o servico contou ${doServico.toolCount}`,
    );
  }

  const providerKeys = await checkProviderKeys(window);
  const registered = await checkRegisteredProviders(window);
  const github = await checkGithub(window);
  const watched = await checkWatched(window);
  const slackWindow = await checkSlackWindow(window);
  const trackers = await checkTrackers(window);

  return t("smoke.config", {
    providers: provedores.length,
    fallbacks: fallbacks.length,
    servers: servidores.length,
    fixture: FIXTURE_SERVER,
    tools: resultado.ferramentas,
    budgets: orcamentos.length,
    providerKeys,
    registered,
    github,
    watched,
    slackWindow,
    trackers,
  });
}

/**
 * Confere a chave de provedor pela interface, sem chave de verdade e sem rede.
 *
 * O caminho inteiro da story cabe dentro da maquina. O que sairia daqui e a
 * resposta de um provedor a uma chave, e ela e exercitada contra um provedor
 * de mentira, montado so para este exame, cujo catalogo e um servidor de tres
 * linhas escutando em 127.0.0.1. Nenhuma chave de ninguem e usada, e nenhum
 * pacote passa da placa de loopback.
 *
 * O provedor de mentira nao e luxo: os provedores de verdade compartilham o
 * endereco `provider/<nome>` no cofre de quem desenvolve, e gravar neles para
 * provar o caminho destruiria uma chave que pode estar em uso. E por isso
 * tambem que o servico e construido aqui em vez de usar o singleton: o
 * registro dele so conhece provedor de verdade.
 *
 * Na interface o exame e o que da para fazer sem estragar nada: conferir que o
 * campo aparece para quem tem chave e nao aparece para quem nao tem, que o sim
 * ou nao bate com o cofre, e clicar em conferir so num provedor sem credencial,
 * onde a resposta sai de dentro da maquina.
 */
async function checkProviderKeys(window: BrowserWindow): Promise<string> {
  await irPara(window, "settings", "models");
  const { createServer } = await import("node:http");
  const { eq } = await import("drizzle-orm");
  const { db, schema } = await import("../src/db/index.js");
  const { secretService } = await import("../src/services/secret-service.js");
  const { settingsService } = await import("../src/services/settings-service.js");
  const { ProviderService, providerCredentialRef, providerService } = await import(
    "../src/services/provider-service.js"
  );

  if (!secretService.available) throw new Error("keychain indisponivel para chave de provedor");

  const nome = `locum-smoke-${randomUUID().slice(0, 8)}`;
  const variavel = "LOCUM_SMOKE_PROVIDER_KEY";
  const chave = `chave-de-mentira-${randomUUID()}`;
  const ref = providerCredentialRef(nome);

  const autorizacoes: (string | undefined)[] = [];
  const catalogo = createServer((requisicao, resposta) => {
    autorizacoes.push(requisicao.headers.authorization);
    resposta.setHeader("content-type", "application/json");
    resposta.end(JSON.stringify({ data: [{ id: "um" }, { id: "dois" }, { id: "tres" }] }));
  });
  await new Promise<void>((resolve) => {
    catalogo.listen(0, "127.0.0.1", resolve);
  });
  const porta = (catalogo.address() as { port: number }).port;

  // O registro de mentira, remontado a cada gravacao como o de verdade: e a
  // funcao inteira que entra no servico, e nao so o resultado dela.
  const fazer = (segredos: Record<string, string>) => ({
    [nome]: {
      available: () => Boolean(segredos[variavel]),
      requires: [variavel],
      secretVar: variavel,
      catalog: () => ({
        url: `http://127.0.0.1:${porta}/models`,
        headers: { Authorization: `Bearer ${segredos[variavel] ?? ""}` },
      }),
    },
  });
  const servico = new ProviderService(db, fazer({}), secretService, settingsService, fazer);

  try {
    const [vazia] = await servico.credentials();
    if (vazia === undefined) throw new Error("o provedor de mentira nao apareceu no cadastro");
    if (vazia.ref !== ref) throw new Error(`a chave nasceu apontando para ${vazia.ref}`);
    if (vazia.stored) throw new Error(`a referencia sorteada ${ref} ja tinha valor`);
    if (vazia.checkedAt !== null || vazia.modelCount !== null) {
      throw new Error("uma chave nova nasceu com conferencia");
    }

    // Sem chave, a conferencia responde de dentro da maquina: o servidor de
    // catalogo nao e procurado, e e por isso que a lista continua vazia logo
    // abaixo.
    const semChave = await servico.check(nome);
    if (semChave.ok || semChave.reason !== "missing") {
      throw new Error(`sem chave a conferencia respondeu ${JSON.stringify(semChave)}`);
    }
    if (autorizacoes.length > 0) throw new Error("a conferencia saiu perguntando sem ter chave");
    if (servico.isAvailable(nome)) throw new Error("o provedor nasceu disponivel sem chave");

    await servico.setSecret(nome, chave);
    if (readFileSync(secretService.pathFor(ref)).includes(chave)) {
      throw new Error("a chave do provedor foi para o disco em claro");
    }

    // O coracao da story: guardar torna o provedor disponivel na hora, sem
    // ninguem reabrir janela nem montar executor.
    if (!servico.isAvailable(nome)) {
      throw new Error("o provedor continuou indisponivel depois de guardar a chave");
    }

    const conferida = await servico.check(nome);
    if (!conferida.ok) throw new Error(`a conferencia recusou: ${JSON.stringify(conferida)}`);
    if (conferida.count !== 3) throw new Error(`o catalogo contou ${conferida.count} modelo(s)`);
    if (autorizacoes.at(-1) !== `Bearer ${chave}`) {
      throw new Error("o catalogo foi chamado sem a chave que a tela guardou");
    }

    const depois = (await servico.credentials())[0]!;
    if (!depois.stored) throw new Error("a chave nao ficou guardada");
    if (depois.checkedAt === null || depois.modelCount !== 3) {
      throw new Error("a conferencia nao sobreviveu ao cadastro");
    }
    if (depois.env) throw new Error(`${variavel} existe no ambiente e falseia o exame`);

    // Trocar a chave joga fora o catalogo que era dela. Sem isso a tela
    // mostraria a contagem antiga ao lado de uma chave nova, com cara de dado
    // conferido.
    await servico.setSecret(nome, `${chave}-outra`);
    const trocada = (await servico.credentials())[0]!;
    if (trocada.checkedAt !== null || trocada.modelCount !== null) {
      throw new Error("a conferencia da chave anterior sobreviveu a troca");
    }

    if (!(await servico.clearSecret(nome))) throw new Error("esquecer nao achou o que apagar");
    if (servico.isAvailable(nome)) throw new Error("o provedor sobreviveu ao esquecer");
    if ((await servico.credentials())[0]!.stored) {
      throw new Error("a chave sobreviveu ao esquecer");
    }
  } finally {
    secretService.remove(ref);
    await settingsService.remove(`provider:${ref}:checkedAt`);
    await settingsService.remove(`provider:${ref}:models`);
    await db.delete(schema.providers).where(eq(schema.providers.id, nome));
    await new Promise<void>((resolve) => catalogo.close(() => resolve()));
  }

  // Agora a interface, que e o que a story entrega. A tela ja esta montada, e
  // o que se confere nela nao grava nada.
  const linhas = (await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll("[data-locum-provider]")).map((e) => ({
      nome: e.dataset.locumProvider,
      guardada: e.dataset.locumChaveGuardada,
      referencia: e.dataset.locumChaveRef,
      campo: e.querySelector("[data-locum-chave-campo]") !== null,
      disponivel: e.dataset.locumDisponivel,
    }))`,
  )) as { nome: string; guardada: string; referencia: string; campo: boolean; disponivel: string }[];

  const cadastro = await providerService.credentials();
  for (const esperada of cadastro) {
    const naTela = linhas.find((l) => l.nome === esperada.provider);
    if (naTela === undefined) throw new Error(`o provedor ${esperada.provider} sumiu da tela`);

    // Campo de senha so para quem tem chave a guardar. A assinatura vive da
    // sessao do binario e o servidor local nao pede credencial: oferecer um
    // campo a eles seria convidar alguem a guardar um segredo que nada le.
    if (naTela.campo !== (esperada.variable !== null)) {
      throw new Error(
        `o provedor ${esperada.provider} ${naTela.campo ? "ofereceu" : "escondeu"} campo de chave indevidamente`,
      );
    }
    if (esperada.variable === null) continue;

    if (naTela.referencia !== esperada.ref) {
      throw new Error(
        `a tela aponta ${esperada.provider} para ${naTela.referencia} e o servico diz ${esperada.ref}`,
      );
    }
    const guardada = esperada.stored ? "sim" : "nao";
    if (naTela.guardada !== guardada) {
      throw new Error(
        `a tela diz "${naTela.guardada}" para a chave de ${esperada.provider} e o cofre diz "${guardada}"`,
      );
    }
  }

  // Sem credencial nenhuma, a tela nem oferece conferir: a resposta seria
  // "nao ha chave", e um botao que so pode dizer isso e ruido. Num provedor
  // com chave, clicar viraria uma chamada autenticada a API de alguem, feita
  // por um loop que roda sem ninguem olhando, entao o smoke nao clica.
  const semCredencial = cadastro.find((c) => c.variable !== null && !c.stored && !c.env);
  if (semCredencial === undefined) {
    return t("smoke.providerKeys", { path: t("smoke.providerKeysStored") });
  }

  const ofereceu = await window.webContents.executeJavaScript(
    `document.querySelector('[data-locum-chave-conferir="${semCredencial.provider}"]') !== null`,
  );
  if (ofereceu !== false) {
    throw new Error(`a tela ofereceu conferir ${semCredencial.provider} sem chave nenhuma`);
  }

  return t("smoke.providerKeys", {
    path: t("smoke.providerKeysRoundTrip", { provider: semCredencial.provider }),
  });
}

/**
 * Confere o cadastro de provedor compatível, sem provedor de verdade.
 *
 * O caminho inteiro da story cabe dentro da máquina, como no exame da chave:
 * os dois gateways cadastrados apontam para servidores de três linhas
 * escutando em 127.0.0.1, e as chaves são sorteadas. Nada sai da placa de
 * loopback, e nenhum provedor de verdade é tocado.
 *
 * Os dois catálogos respondem números diferentes de propósito. É o que separa
 * "dois cadastros aparecem" de "cada um tem o próprio catálogo": com listas
 * iguais, um registro que apontasse os dois para o mesmo endereço passaria.
 *
 * Um entra pelo serviço e o outro pela tela, e a remoção também vai pelos dois
 * caminhos, porque são dois códigos diferentes: o formulário da janela e o
 * método que o resto do app chama. O que é exercitado só de um lado é o aviso
 * de uso, que precisa de uma substituição apontando para o provedor, e essa
 * linha é plantada e apagada aqui.
 */
async function checkRegisteredProviders(window: BrowserWindow): Promise<string> {
  await irPara(window, "settings", "models");
  const { createServer } = await import("node:http");
  const { and, eq } = await import("drizzle-orm");
  const { db, schema } = await import("../src/db/index.js");
  const { machineId } = await import("../src/services/machine-service.js");
  const { secretService } = await import("../src/services/secret-service.js");
  const { settingsService } = await import("../src/services/settings-service.js");
  const { providerCredentialRef, providerService } = await import(
    "../src/services/provider-service.js"
  );

  if (!secretService.available) throw new Error("keychain indisponivel para provedor cadastrado");

  /** Um catálogo de mentira, que conta quantas chaves diferentes o procuraram. */
  const catalogo = async (modelos: string[]) => {
    const chamadas: (string | undefined)[] = [];
    const servidor = createServer((requisicao, resposta) => {
      chamadas.push(requisicao.headers.authorization);
      resposta.setHeader("content-type", "application/json");
      resposta.end(JSON.stringify({ data: modelos.map((id) => ({ id })) }));
    });
    await new Promise<void>((resolve) => {
      servidor.listen(0, "127.0.0.1", resolve);
    });
    const porta = (servidor.address() as { port: number }).port;
    return { chamadas, servidor, baseUrl: `http://127.0.0.1:${porta}/v1` };
  };

  const pelo = await catalogo(["um", "dois"]);
  const pela = await catalogo(["um", "dois", "tres", "quatro", "cinco"]);

  const idDoServico = `locum-smoke-svc-${randomUUID().slice(0, 8)}`;
  const idDaTela = `locum-smoke-ui-${randomUUID().slice(0, 8)}`;
  const chaveDoServico = `chave-de-mentira-${randomUUID()}`;
  const chaveDaTela = `chave-de-mentira-${randomUUID()}`;
  const substituicao = `${idDoServico}/um`;
  // O nome sai de variável e não de literal no objeto: `label` é propriedade
  // que o Electron pinta em menu, e a guarda de i18n acusa texto cravado nela.
  const nomeDoServico = `Gateway ${idDoServico}`;

  try {
    await providerService.register({
      id: idDoServico,
      label: nomeDoServico,
      baseUrl: pelo.baseUrl,
    });

    // Nome de provedor de fábrica é recusa, e não substituição: um cadastro
    // chamado `anthropic` mandaria a chave de quem tem uma para outro lugar.
    for (const proibido of ["anthropic", idDoServico]) {
      const recusou = await providerService
        .register({ id: proibido, label: nomeDoServico, baseUrl: pelo.baseUrl })
        .then(
          () => false,
          () => true,
        );
      if (!recusou) throw new Error(`o cadastro aceitou o identificador "${proibido}"`);
    }

    // O segundo pela tela, que é o que a story entrega. A seção relê depois de
    // gravar, então é por ela que os dois passam a aparecer na janela.
    const preencheu = await window.webContents.executeJavaScript(
      `(() => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        ).set;
        const digitar = (seletor, valor) => {
          const campo = document.querySelector(seletor);
          if (campo === null) return false;
          setter.call(campo, valor);
          campo.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        };
        if (!digitar("[data-locum-cadastrar-id]", ${JSON.stringify(idDaTela)})) return false;
        if (!digitar("[data-locum-cadastrar-nome]", "Gateway da tela")) return false;
        if (!digitar("[data-locum-cadastrar-url]", ${JSON.stringify(pela.baseUrl)})) return false;
        const botao = document.querySelector("[data-locum-cadastrar-salvar]");
        if (botao === null || botao.disabled) return false;
        botao.click();
        return true;
      })()`,
    );
    if (preencheu !== true) throw new Error("a tela nao ofereceu o formulario de cadastro");

    const naTela = await esperarProbe<Record<string, string>>(
      window,
      "provedores cadastrados na tela",
      `(() => {
        const linhas = Array.from(document.querySelectorAll("[data-locum-cadastrado]"));
        const achados = Object.fromEntries(
          linhas.map((e) => [e.dataset.locumCadastrado, e.dataset.locumCadastradoUrl]),
        );
        return ${JSON.stringify(idDaTela)} in achados ? achados : null;
      })()`,
    );
    if (naTela[idDoServico] !== pelo.baseUrl || naTela[idDaTela] !== pela.baseUrl) {
      throw new Error(
        `a tela listou ${JSON.stringify(naTela)} e os cadastros sao ${pelo.baseUrl} e ${pela.baseUrl}`,
      );
    }

    // Os dois no registro, ao lado dos de fábrica, e reconhecíveis como
    // cadastrados: sem isso a tela não teria como saber quais pode remover.
    const registro = new Map(providerService.listProviders().map((p) => [p.name, p]));
    const cadastros: [string, string][] = [
      [idDoServico, pelo.baseUrl],
      [idDaTela, pela.baseUrl],
    ];
    for (const [id, baseUrl] of cadastros) {
      const entrada = registro.get(id);
      if (entrada === undefined) throw new Error(`o provedor ${id} nao entrou no registro`);
      if (entrada.registered === null) throw new Error(`o provedor ${id} apareceu como de fabrica`);
      if (entrada.registered.baseUrl !== baseUrl) {
        throw new Error(`o provedor ${id} aponta para ${entrada.registered.baseUrl}`);
      }
      if (entrada.available) throw new Error(`o provedor ${id} nasceu disponivel sem chave`);
    }

    await providerService.setSecret(idDoServico, chaveDoServico);
    await providerService.setSecret(idDaTela, chaveDaTela);
    for (const id of [idDoServico, idDaTela]) {
      if (!providerService.isAvailable(id)) {
        throw new Error(`o provedor ${id} continuou apagado depois de guardar a chave`);
      }
    }

    // Cada um com o próprio catálogo, e cada catálogo procurado com a chave
    // dele. Contagens diferentes porque dois cadastros apontados para o mesmo
    // endereço passariam num exame que só contasse linhas.
    const doServico = await providerService.listModels(idDoServico);
    const daTela = await providerService.listModels(idDaTela);
    if (doServico.erro !== undefined) throw new Error(`o catalogo recusou: ${doServico.erro}`);
    if (daTela.erro !== undefined) throw new Error(`o catalogo recusou: ${daTela.erro}`);
    if (doServico.modelos.length !== 2 || daTela.modelos.length !== 5) {
      throw new Error(
        `os catalogos responderam ${doServico.modelos.length} e ${daTela.modelos.length} modelos`,
      );
    }
    if (pelo.chamadas.at(-1) !== `Bearer ${chaveDoServico}`) {
      throw new Error("o primeiro catalogo foi procurado com a chave errada");
    }
    if (pela.chamadas.at(-1) !== `Bearer ${chaveDaTela}`) {
      throw new Error("o segundo catalogo foi procurado com a chave errada");
    }

    // Um passo pode apontar para qualquer um dos dois: a prévia resolve sem
    // substituição, que é o que o executor faria antes de montar o runtime.
    const previas = await providerService.resolvePreviews(
      [`${idDoServico}/um`, `${idDaTela}/cinco`],
      machineId,
    );
    for (const [i, id] of [idDoServico, idDaTela].entries()) {
      const previa = previas[i];
      if (previa === undefined || !previa.ok) {
        throw new Error(`a previa de ${id} recusou: ${JSON.stringify(previa)}`);
      }
      if (previa.resolution.provider !== id) {
        throw new Error(`a previa de ${id} caiu em ${previa.resolution.provider}`);
      }
      if (previa.resolution.substitutionReason !== undefined) {
        throw new Error(`a previa de ${id} precisou substituir sem motivo`);
      }
    }

    // O aviso antes de remover. A substituição plantada é o uso, e sem `force`
    // a remoção devolve onde ele aparece em vez de apagar.
    await providerService.setFallback(machineId, substituicao, "claude-code/claude-sonnet-5");
    const avisou = await providerService.remove(idDoServico);
    if (avisou.removed) throw new Error("o provedor em uso foi removido sem aviso");
    if (!avisou.usedBy.some((uso) => uso.kind === "fallback" && uso.from === substituicao)) {
      throw new Error(`o aviso nao citou a substituicao: ${JSON.stringify(avisou.usedBy)}`);
    }
    if (!providerService.isAvailable(idDoServico)) {
      throw new Error("o provedor avisado saiu do registro sem ter sido removido");
    }

    const forcado = await providerService.remove(idDoServico, true);
    if (!forcado.removed) throw new Error("o provedor nao saiu nem com a decisao tomada");
    if (providerService.isAvailable(idDoServico)) {
      throw new Error("o provedor removido continuou no registro");
    }
    if (secretService.has(providerCredentialRef(idDoServico))) {
      throw new Error("a chave do provedor removido ficou no cofre");
    }

    // A remoção pela tela, no que não está em uso: um clique só, porque não há
    // o que avisar.
    const clicou = await window.webContents.executeJavaScript(
      `(() => {
        const botao = document.querySelector('[data-locum-cadastrado-remover="${idDaTela}"]');
        if (botao === null) return false;
        botao.click();
        return true;
      })()`,
    );
    if (clicou !== true) throw new Error(`a tela nao ofereceu botao de remover ${idDaTela}`);

    await esperarProbe<true>(
      window,
      `remocao de ${idDaTela}`,
      `document.querySelector('[data-locum-cadastrado="${idDaTela}"]') === null ? true : null`,
    );
    if (providerService.isAvailable(idDaTela)) {
      throw new Error("o provedor removido pela tela continuou no registro");
    }
    if ((await providerService.listRegistered()).some((p) => p.id === idDaTela)) {
      throw new Error("o provedor removido pela tela continuou no cadastro");
    }
  } finally {
    // A limpeza não confia em o exame ter chegado ao fim: o que ele planta no
    // banco de quem desenvolve sai daqui mesmo quando uma linha acima estourou.
    for (const id of [idDoServico, idDaTela]) {
      const ref = providerCredentialRef(id);
      secretService.remove(ref);
      await settingsService.remove(`provider:${ref}:checkedAt`);
      await settingsService.remove(`provider:${ref}:models`);
      await db.delete(schema.providers).where(eq(schema.providers.id, id));
    }
    await db
      .delete(schema.modelFallbacks)
      .where(
        and(
          eq(schema.modelFallbacks.machineId, machineId),
          eq(schema.modelFallbacks.fromModel, substituicao),
        ),
      );
    await providerService.loadSecrets();
    await new Promise<void>((resolve) => pelo.servidor.close(() => resolve()));
    await new Promise<void>((resolve) => pela.servidor.close(() => resolve()));
  }

  return t("smoke.registeredProviders", { service: idDoServico, window: idDaTela });
}

/**
 * Confere o tracker de tarefa, sem Jira e sem GitHub de verdade.
 *
 * O caminho inteiro da story cabe dentro da máquina: os dois cadastros apontam
 * para um servidor de poucas linhas escutando em 127.0.0.1, que responde as
 * rotas do Jira e as do GitHub, e as credenciais são sorteadas. Nada sai da
 * placa de loopback, e nenhuma conta de ninguém é tocada.
 *
 * As duas listas de destino têm tamanhos diferentes de propósito. É o que
 * separa "os dois cadastros respondem" de "cada adaptador fala a língua do
 * serviço dele": com listas iguais, um adaptador que batesse na rota errada
 * passaria.
 *
 * Um entra pelo serviço e o outro pela tela, porque são dois códigos
 * diferentes. Criar tarefa não é exercitado, e não é omissão: pela regra do
 * marco, abrir tarefa nunca é automático, e o que este exame confere sobre isso
 * é que a ponte não tem por onde. O caminho de criar só existe atrás da fila de
 * aprovação, e ele é assunto da próxima story.
 */
async function checkTrackers(window: BrowserWindow): Promise<string> {
  await irPara(window, "settings", "connections");
  // O GitHub Issues mora no painel do GitHub, e o Jira no da Atlassian.
  await abrirConexao(window, "github");
  const { createServer } = await import("node:http");
  const { eq } = await import("drizzle-orm");
  const { db, schema } = await import("../src/db/index.js");
  const { secretService } = await import("../src/services/secret-service.js");
  const { settingsService } = await import("../src/services/settings-service.js");
  const { trackerCredentialRef, trackerService } = await import(
    "../src/services/tracker-service.js"
  );
  const { BRIDGE_CHANNELS } = await import("./bridge-contract.js");

  if (!secretService.available) throw new Error("keychain indisponivel para o cofre do tracker");

  // A ponte não pode ter por onde abrir tarefa. A guarda de tipo do contrato já
  // para o build, e esta é a mesma pergunta feita em tempo de execução, contra
  // a lista que o preload realmente registra.
  const abertura = BRIDGE_CHANNELS.filter(
    (canal) => canal.startsWith("trackers.") && /create|issue/i.test(canal),
  );
  if (abertura.length > 0) {
    throw new Error(`a ponte expoe canal que abre tarefa: ${abertura.join(", ")}`);
  }

  const idDoServico = `locum-smoke-jira-${randomUUID().slice(0, 6)}`;
  const idDaTela = `locum-smoke-gh-${randomUUID().slice(0, 6)}`;
  const idDaAtlassian = `locum-smoke-atl-${randomUUID().slice(0, 6)}`;
  const contaDoJira = `smoke-${randomUUID().slice(0, 8)}@exemplo.invalido`;
  const tokenDoJira = `token-de-mentira-${randomUUID()}`;
  const tokenDoGithub = `token-de-mentira-${randomUUID()}`;
  const projetoDoJira = "SMOKE";
  const repoDaTela = "locum-smoke/exemplo";
  const pullRequest = "https://github.com/locum-smoke/exemplo/pull/42";
  const tarefaExistente = `${projetoDoJira}-7`;
  const nomeDoServico = `Jira ${idDoServico}`;
  const nomeDaTela = `Issues ${idDaTela}`;
  const nomeDaAtlassian = `Atlassian ${idDaAtlassian}`;

  /**
   * Um tracker de mentira que fala as duas línguas.
   *
   * As rotas do Jira e as do GitHub não colidem, então um servidor só atende os
   * dois cadastros e ainda guarda quem procurou com qual credencial, que é o
   * que prova que o segredo saiu do cofre e não de outro lugar.
   */
  const autorizacoes: Record<string, string | undefined> = {};
  const servidor = createServer((requisicao, resposta) => {
    const caminho = requisicao.url ?? "";
    const responder = (corpo: unknown): void => {
      resposta.setHeader("content-type", "application/json");
      resposta.end(JSON.stringify(corpo));
    };

    if (caminho.startsWith("/rest/api/3/project/search")) {
      autorizacoes.jira = requisicao.headers.authorization;
      responder({
        values: [
          { key: projetoDoJira, name: "Smoke" },
          { key: "OUTRO", name: "Outro" },
          { key: "TERCEIRO", name: "Terceiro" },
        ],
      });
      return;
    }

    if (caminho.startsWith("/rest/api/3/search/jql")) {
      autorizacoes.jira = requisicao.headers.authorization;
      const pedacos: Buffer[] = [];
      requisicao.on("data", (pedaco: Buffer) => pedacos.push(pedaco));
      requisicao.on("end", () => {
        // A tarefa só é devolvida quando a consulta cita o pull request. Um
        // servidor que respondesse sempre a mesma coisa não separaria "achou o
        // que ja existe" de "devolve qualquer tarefa".
        const corpo = Buffer.concat(pedacos).toString("utf8");
        const citou = corpo.includes(pullRequest);
        responder({
          issues: citou ? [{ key: tarefaExistente, fields: { summary: "ja aberta" } }] : [],
        });
      });
      return;
    }

    if (caminho.startsWith("/user/repos")) {
      autorizacoes.github = requisicao.headers.authorization;
      responder([{ full_name: repoDaTela, name: "exemplo" }, { full_name: "locum-smoke/outro" }]);
      return;
    }

    resposta.statusCode = 404;
    // A chave não é `message` de propósito: a guarda de i18n varre propriedade
    // que o Electron pinta, e o corpo de um 404 de mentira não é texto de tela.
    responder({ rota: caminho });
  });

  await new Promise<void>((resolve) => {
    servidor.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${(servidor.address() as { port: number }).port}`;

  try {
    await trackerService.register({
      id: idDoServico,
      kind: "jira",
      label: nomeDoServico,
      baseUrl,
      account: contaDoJira,
      project: projetoDoJira,
    });

    // O Jira autentica por e-mail e token, e o cadastro sem e-mail cria um
    // tracker que só falharia dentro de uma execução. Tipo inventado e
    // identificador repetido também são recusa.
    const recusas: { motivo: string; cadastro: Parameters<typeof trackerService.register>[0] }[] = [
      {
        motivo: "jira sem e-mail",
        cadastro: { id: `${idDoServico}-b`, kind: "jira", label: nomeDoServico, baseUrl },
      },
      {
        motivo: "tipo inventado",
        cadastro: { id: `${idDoServico}-c`, kind: "trello", label: nomeDoServico, baseUrl },
      },
      {
        motivo: "identificador repetido",
        cadastro: {
          id: idDoServico,
          kind: "jira",
          label: nomeDoServico,
          baseUrl,
          account: contaDoJira,
        },
      },
    ];
    for (const { motivo, cadastro } of recusas) {
      const recusou = await trackerService.register(cadastro).then(
        () => false,
        () => true,
      );
      if (!recusou) throw new Error(`o cadastro de tracker aceitou ${motivo}`);
    }

    // Sem credencial o teste responde de dentro da máquina, sem sair.
    const semCredencial = await trackerService.testConnection(idDoServico);
    if (semCredencial.ok || semCredencial.reason !== "missing") {
      throw new Error(`o teste sem credencial respondeu ${JSON.stringify(semCredencial)}`);
    }

    await trackerService.setSecret(idDoServico, tokenDoJira);
    const doServico = await trackerService.testConnection(idDoServico);
    if (!doServico.ok) throw new Error(`o Jira de mentira recusou: ${JSON.stringify(doServico)}`);
    if (doServico.count !== 3) throw new Error(`o Jira listou ${doServico.count} destino(s)`);

    // A credencial chegou pela autenticação básica, montada com o e-mail do
    // cadastro e o token do cofre. É o que prova que o segredo saiu de lá.
    const basica = `Basic ${Buffer.from(`${contaDoJira}:${tokenDoJira}`).toString("base64")}`;
    if (autorizacoes.jira !== basica) {
      throw new Error("o Jira foi procurado com credencial que nao veio do cofre");
    }

    const destinos = await trackerService.listProjects(idDoServico);
    if (!destinos.some((destino) => destino.key === projetoDoJira)) {
      throw new Error(`os destinos do Jira sao ${destinos.map((d) => d.key).join(",")}`);
    }

    // A procura por pull request, que é o que impede a segunda execução de
    // abrir uma segunda tarefa sobre o mesmo pull request.
    const achada = await trackerService.findIssueForPullRequest(idDoServico, pullRequest);
    if (achada?.key !== tarefaExistente) {
      throw new Error(`a procura devolveu ${JSON.stringify(achada)}`);
    }
    const semTarefa = await trackerService.findIssueForPullRequest(
      idDoServico,
      "https://github.com/locum-smoke/exemplo/pull/999",
    );
    if (semTarefa !== null) throw new Error("a procura inventou tarefa para um pull request novo");

    // O segundo pela tela, que é o que a story entrega.
    const preencheu = await window.webContents.executeJavaScript(
      `(() => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        ).set;
        const digitar = (seletor, valor) => {
          const campo = document.querySelector(seletor);
          if (campo === null) return false;
          setter.call(campo, valor);
          campo.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        };
        // O painel do GitHub só cadastra GitHub Issues, então não há tipo a
        // escolher, e um seletor aqui seria o Jira aparecendo fora do lugar.
        if (document.querySelector("[data-locum-tracker-tipo]") !== null) return false;
        if (!digitar("[data-locum-tracker-id]", ${JSON.stringify(idDaTela)})) return false;
        if (!digitar("[data-locum-tracker-nome]", ${JSON.stringify(nomeDaTela)})) return false;
        if (!digitar("[data-locum-tracker-url]", ${JSON.stringify(baseUrl)})) return false;
        if (!digitar("[data-locum-tracker-projeto]", ${JSON.stringify(repoDaTela)})) return false;
        const botao = document.querySelector("[data-locum-tracker-salvar]");
        if (botao === null || botao.disabled) return false;
        botao.click();
        return true;
      })()`,
    );
    if (preencheu !== true) throw new Error("a tela nao ofereceu o formulario de tracker");

    const naTela = await esperarProbe<Record<string, string>>(
      window,
      "trackers na tela",
      `(() => {
        const linhas = Array.from(document.querySelectorAll("[data-locum-tracker]"));
        const achados = Object.fromEntries(
          linhas.map((e) => [e.dataset.locumTracker, e.dataset.locumTrackerKind]),
        );
        return ${JSON.stringify(idDaTela)} in achados ? achados : null;
      })()`,
    );
    if (naTela[idDaTela] !== "github-issues" || idDoServico in naTela) {
      throw new Error(`o painel do GitHub listou ${JSON.stringify(naTela)}`);
    }

    // A credencial indo da tela para o cofre, e voltando como "guardada" e
    // nunca como valor: não existe canal que a devolva.
    const guardou = await window.webContents.executeJavaScript(
      `(() => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        ).set;
        const campo = document.querySelector('[data-locum-tracker-credencial="${idDaTela}"]');
        if (campo === null || campo.disabled) return false;
        setter.call(campo, ${JSON.stringify(tokenDoGithub)});
        campo.dispatchEvent(new Event("input", { bubbles: true }));
        const botao = document.querySelector('[data-locum-tracker-guardar="${idDaTela}"]');
        if (botao === null || botao.disabled) return false;
        botao.click();
        return true;
      })()`,
    );
    if (guardou !== true) throw new Error("a tela nao ofereceu campo de credencial do tracker");

    await esperarProbe<true>(
      window,
      `credencial de ${idDaTela}`,
      `(() => {
        const linha = document.querySelector('[data-locum-tracker="${idDaTela}"]');
        return linha !== null && linha.dataset.locumTrackerGuardado === "sim" ? true : null;
      })()`,
    );
    if (!secretService.has(trackerCredentialRef(idDaTela))) {
      throw new Error("a credencial digitada na tela nao chegou ao cofre");
    }

    // O clique de testar, que é o que a story pede: a tela pergunta os destinos
    // visíveis, e a resposta é do adaptador do GitHub, em outra rota.
    const clicou = await window.webContents.executeJavaScript(
      `(() => {
        const botao = document.querySelector('[data-locum-tracker-testar="${idDaTela}"]');
        if (botao === null) return false;
        botao.click();
        return true;
      })()`,
    );
    if (clicou !== true) throw new Error(`a tela nao ofereceu botao de testar ${idDaTela}`);

    const resultado = await esperarProbe<{ ok: string; projetos: number }>(
      window,
      `teste de ${idDaTela}`,
      `(() => {
        const probe = document.querySelector('[data-locum-tracker-teste="${idDaTela}"]');
        if (probe === null) return null;
        return { ok: probe.dataset.locumOk, projetos: Number(probe.dataset.locumProjetos) };
      })()`,
    );
    if (resultado.ok !== "sim") {
      throw new Error(`a tela disse "${resultado.ok}" para o teste do tracker`);
    }
    if (resultado.projetos !== 2) {
      throw new Error(`a tela contou ${resultado.projetos} destino(s) e o GitHub de mentira tem 2`);
    }
    if (autorizacoes.github !== `Bearer ${tokenDoGithub}`) {
      throw new Error("o GitHub foi procurado com credencial que nao veio do cofre");
    }

    // A remoção pela tela, que apaga cadastro e credencial juntos: deixar o
    // segredo guardaria um token que nada mais lê.
    const removeu = await window.webContents.executeJavaScript(
      `(() => {
        const botao = document.querySelector('[data-locum-tracker-remover="${idDaTela}"]');
        if (botao === null) return false;
        botao.click();
        return true;
      })()`,
    );
    if (removeu !== true) throw new Error(`a tela nao ofereceu botao de remover ${idDaTela}`);

    await esperarProbe<true>(
      window,
      `remocao de ${idDaTela}`,
      `document.querySelector('[data-locum-tracker="${idDaTela}"]') === null ? true : null`,
    );
    if (secretService.has(trackerCredentialRef(idDaTela))) {
      throw new Error("a credencial do tracker removido ficou no cofre");
    }

    // O Jira pela conexão Atlassian. O site entra como se copia da barra do
    // navegador, e o tracker não guarda credencial própria: quem autoriza é a
    // conexão. O teste de conexão não roda aqui porque, com a Atlassian
    // conectada na máquina, ele sairia para o site de verdade.
    await trackerService.register({
      id: idDaAtlassian,
      kind: "jira-atlassian",
      label: nomeDaAtlassian,
      baseUrl: "locum-smoke.atlassian.invalid",
      project: projetoDoJira,
    });
    const atlassian = (await trackerService.list()).find((tracker) => tracker.id === idDaAtlassian);
    if (atlassian?.baseUrl !== "https://locum-smoke.atlassian.invalid") {
      throw new Error(`o site da Atlassian ficou ${atlassian?.baseUrl}`);
    }
    const guardouNaAtlassian = await trackerService.setSecret(idDaAtlassian, tokenDoJira).then(
      () => true,
      () => false,
    );
    if (guardouNaAtlassian) throw new Error("o tracker pela Atlassian aceitou credencial propria");

    await abrirConexao(window, "atlassian");
    const naAtlassian = await esperarProbe<{ kind: string; credencial: boolean; outros: number }>(
      window,
      "trackers no painel da Atlassian",
      `(() => {
        const linha = document.querySelector('[data-locum-tracker="${idDaAtlassian}"]');
        if (linha === null) return null;
        return {
          kind: linha.dataset.locumTrackerKind,
          credencial: linha.querySelector("[data-locum-tracker-credencial]") !== null,
          outros: document.querySelectorAll('[data-locum-tracker-kind="github-issues"]').length,
        };
      })()`,
    );
    if (naAtlassian.kind !== "jira-atlassian" || naAtlassian.credencial || naAtlassian.outros > 0) {
      throw new Error(`o painel da Atlassian mostrou ${JSON.stringify(naAtlassian)}`);
    }

    if (!(await trackerService.remove(idDaAtlassian))) {
      throw new Error("o tracker pela Atlassian nao saiu");
    }

    if (!(await trackerService.remove(idDoServico))) {
      throw new Error("o tracker cadastrado pelo servico nao saiu");
    }
    if (secretService.has(trackerCredentialRef(idDoServico))) {
      throw new Error("a credencial do tracker removido pelo servico ficou no cofre");
    }
  } finally {
    // A limpeza não confia em o exame ter chegado ao fim: o que ele planta no
    // banco e no cofre de quem desenvolve sai daqui mesmo quando uma linha
    // acima estourou.
    for (const id of [idDoServico, idDaTela, idDaAtlassian]) {
      const ref = trackerCredentialRef(id);
      secretService.remove(ref);
      await settingsService.remove(`tracker:${ref}:checkedAt`);
      await settingsService.remove(`tracker:${ref}:projects`);
      await db.delete(schema.trackers).where(eq(schema.trackers.id, id));
    }
    await new Promise<void>((resolve) => servidor.close(() => resolve()));
  }

  return t("smoke.trackers", {
    service: idDoServico,
    window: idDaTela,
    projects: 5,
  });
}

/**
 * Prova que o passo que abre tarefa propõe, para, e não nasce em outro modo.
 *
 * Nada sai da máquina, e desta vez nem para o loopback: montar a proposta é
 * leitura de banco e concatenação de texto, então o exame não precisa de
 * servidor de mentira nem de credencial no cofre. Criar a tarefa de verdade
 * fica de fora de propósito: o que a story pede é que o passo pare na fila, e
 * aprovar aqui seria justamente a coisa que o passo existe para impedir.
 *
 * Os dois passos de modelo entram plantados como `done`, do jeito que o
 * executor retoma um run interrompido. É o que permite exercitar o passo de
 * ação sem gastar um minuto de assinatura para ouvir do modelo um texto que o
 * exame já conhece.
 */
async function checkTrackerIssue(): Promise<string> {
  const { eq } = await import("drizzle-orm");
  const { db, schema } = await import("../src/db/index.js");
  const { buildExecutor, buildGate } = await import("../src/executor/build.js");
  const { demoPr } = await import("../src/examples/demo-event.js");
  const { trackerIssueSteps } = await import("../src/examples/tracker-issue.js");
  const { agentService } = await import("../src/services/agent-service.js");
  const { trackerService } = await import("../src/services/tracker-service.js");
  const { TrackerIssueProposal } = await import("../src/trackers/proposal.js");
  const { AgentSpec } = await import("../src/config/types.js");

  const idDoTracker = `locum-smoke-issue-${randomUUID().slice(0, 6)}`;
  const agentId = `locum-smoke-issue-${randomUUID().slice(0, 6)}`;
  const eventId = `smoke-event-${randomUUID()}`;
  const destino = "locum-smoke/exemplo";
  // Fora do literal do cadastro porque o guarda de i18n olha a propriedade
  // `label`, e este nome e cadastro de mentira, nao texto de produto.
  const nomeDoTracker = `Issues ${idDoTracker}`;

  // O que o passo de modelo teria escrito. Os três textos são conferidos dentro
  // do corpo proposto: é o que separa "o corpo veio do passo anterior" de "o
  // handler escreveu alguma coisa parecida".
  const objetivo = "Corrigir a expiração de token, que hoje aceita token vencido em BRT.";
  const mudou = "O TokenValidator trocou UtcNow por Now e o cache perdeu a segurança de concorrência.";
  const testar = "Rodar a suíte de autenticação com a máquina em BRT e conferir a expiração no limite.";

  const spec = AgentSpec.parse({
    id: agentId,
    name: `Smoke ${agentId}`,
    defaultTools: [],
    skills: [],
    budget: {},
    steps: [
      {
        type: "model",
        key: "audit",
        name: "Auditoria",
        needs: [],
        model: "claude-code/claude-sonnet-5",
        requiresServers: [],
        prompt: "{{event.diff}}",
      },
      ...trackerIssueSteps({ tracker: idDoTracker, needs: "audit" }),
    ],
  });

  let runId: string | undefined;
  try {
    await trackerService.register({
      id: idDoTracker,
      kind: "github-issues",
      label: nomeDoTracker,
      // Endereço que existe como URL e não atende ninguém: o caminho exercitado
      // aqui não abre conexão, e um endereço de verdade esconderia isso.
      baseUrl: "http://127.0.0.1:9",
      project: destino,
    });

    const versao = await agentService.upsert(spec, `smoke ${agentId}`, "human");
    await db.insert(schema.events).values({
      id: eventId,
      source: "fixture",
      externalId: `smoke:${eventId}`,
      payload: demoPr,
    });

    const executor = await buildExecutor();
    runId = await executor.createRun(versao.id, eventId);

    for (const [idx, plantado] of [
      { stepKey: "audit", name: "Auditoria", output: { findings: [] } },
      { stepKey: "issue_body", name: "Texto da tarefa", output: { objective: objetivo, changes: mudou, testing: testar } },
    ].entries()) {
      await db.insert(schema.steps).values({
        id: `${runId}-${plantado.stepKey}`,
        runId,
        idx,
        stepKey: plantado.stepKey,
        name: plantado.name,
        status: "done",
        output: plantado.output,
      });
    }

    const estado = await executor.execute(runId);
    if (estado !== "paused") throw new Error(`o run terminou como "${estado}", e nao parado na fila`);

    const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
    if (run?.status !== "paused") throw new Error(`o run ficou "${String(run?.status)}" no banco`);

    const passos = await db.select().from(schema.steps).where(eq(schema.steps.runId, runId));
    const acao = passos.find((p) => p.stepKey === "open_issue");
    if (acao?.status !== "awaiting_approval") {
      throw new Error(`o passo de acao ficou "${String(acao?.status)}"`);
    }

    const pendencias = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId));
    if (pendencias.length !== 1) throw new Error(`o passo criou ${pendencias.length} pendencia(s)`);
    const pendencia = pendencias[0]!;
    if (pendencia.kind !== "tracker.create_issue" || pendencia.status !== "pending") {
      throw new Error(`a pendencia saiu como "${pendencia.kind}" em "${pendencia.status}"`);
    }

    const proposta = TrackerIssueProposal.parse(pendencia.payload);
    const tituloEsperado = `${demoPr.repoName}#${demoPr.pull}: ${demoPr.title}`;
    if (proposta.title !== tituloEsperado) {
      throw new Error(`o titulo proposto foi "${proposta.title}"`);
    }
    if (proposta.tracker !== idDoTracker || proposta.project !== destino) {
      throw new Error(`a proposta aponta para ${proposta.tracker} em ${proposta.project}`);
    }
    if (proposta.pullRequestUrl !== demoPr.url) {
      throw new Error(`a proposta cita ${proposta.pullRequestUrl} como pull request`);
    }
    for (const trecho of [objetivo, mudou, testar, demoPr.url]) {
      if (!proposta.body.includes(trecho)) {
        throw new Error(`o corpo proposto nao traz "${trecho.slice(0, 40)}"`);
      }
    }

    // A trava da story: o handler recusa nascer em rascunho ou em automatico, e
    // a recusa acontece antes de qualquer gravacao, entao nem pendencia orfa
    // fica para tras.
    const gate = buildGate();
    const carga = { ...demoPr, objective: objetivo, changes: mudou, testing: testar };
    for (const modo of ["draft", "auto"] as const) {
      const recusou = await gate
        .submit(
          { runId, stepId: acao.id, kind: "tracker.create_issue", payload: carga, target: idDoTracker },
          modo,
        )
        .then(
          () => false,
          () => true,
        );
      if (!recusou) throw new Error(`a gate aceitou abrir tarefa em modo "${modo}"`);
    }

    // E o corpo nao e inventado aqui: sem o que o passo de modelo escreve, a
    // proposta nao existe, em vez de sair um card com secao vazia.
    const { testing: _semTestar, ...semUmaSecao } = carga;
    const recusouVazio = await gate
      .submit(
        { runId, stepId: acao.id, kind: "tracker.create_issue", payload: semUmaSecao, target: idDoTracker },
        "approve",
      )
      .then(
        () => false,
        () => true,
      );
    if (!recusouVazio) throw new Error("a gate propos tarefa sem o texto do passo de modelo");

    const depois = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId));
    if (depois.length !== 1) throw new Error(`as recusas deixaram ${depois.length} pendencia(s)`);
  } finally {
    // O smoke roda no banco de quem desenvolve: o que foi plantado sai daqui
    // mesmo quando uma linha acima estourou.
    if (runId !== undefined) {
      await db.delete(schema.approvals).where(eq(schema.approvals.runId, runId));
      await db.delete(schema.steps).where(eq(schema.steps.runId, runId));
      await db.delete(schema.runs).where(eq(schema.runs.id, runId));
    }
    await db.delete(schema.events).where(eq(schema.events.id, eventId));
    await db.delete(schema.agentVersions).where(eq(schema.agentVersions.agentId, agentId));
    await db.delete(schema.agents).where(eq(schema.agents.id, agentId));
    await trackerService.remove(idDoTracker);
  }

  return t("smoke.trackerIssue", { tracker: idDoTracker, project: destino });
}

/**
 * Prova que o filtro de autoria decide o que acorda o agent.
 *
 * Os dois gatilhos olham a mesma varredura, e cada um leva só o pull request
 * do lado que cadastrou: o de `mine` roda no que a conta do token abriu, e o
 * de `others` no que veio de outra pessoa. É a distinção que a story pede, e
 * ela só aparece com os dois no mesmo tick, porque um gatilho sozinho passaria
 * por acidente se o filtro estivesse invertido.
 *
 * Nada aqui fala com o GitHub nem gasta assinatura: a varredura e a conta do
 * token entram trocadas, e o serviço de execução é substituído por um que só
 * anota o que teria rodado. Os eventos são plantados e apagados aqui mesmo,
 * porque o smoke roda no banco de quem desenvolve.
 */
async function checkAuthorship(): Promise<string> {
  const { db, schema } = await import("../src/db/index.js");
  const { and, eq, inArray } = await import("drizzle-orm");
  const { agentService } = await import("../src/services/agent-service.js");
  const { TriggerService } = await import("../src/services/trigger-service.js");
  const { ExecutionService } = await import("../src/services/execution-service.js");
  const { mcpService } = await import("../src/services/mcp-service.js");
  const { Scheduler } = await import("../src/triggers/scheduler.js");

  const [agent] = await agentService.list();
  if (agent === undefined) throw new Error("nenhum agent cadastrado para filtrar por autoria");

  // Dono, repositório e logins sorteados pelo mesmo motivo do `checkWatched`:
  // um padrão que casasse com repositório de verdade deixaria para trás, caso a
  // limpeza falhasse, um gatilho apontado para trabalho real.
  const dono = `locum-smoke-${randomUUID().slice(0, 8)}`;
  const repo = `^locum-smoke-${randomUUID().slice(0, 8)}$`;
  const eu = `locum-smoke-eu-${randomUUID().slice(0, 8)}`;
  const outra = `locum-smoke-outra-${randomUUID().slice(0, 8)}`;
  const cadencia = 7;

  const meu = { eventId: `smoke-event-${randomUUID()}`, author: eu, pull: 1 };
  const alheio = { eventId: `smoke-event-${randomUUID()}`, author: outra, pull: 2 };

  for (const alvo of [meu, alheio]) {
    await db.insert(schema.events).values({
      id: alvo.eventId,
      source: "github",
      externalId: `pr:${dono}/${repo}#${alvo.pull}:sha:${randomUUID().slice(0, 7)}`,
      payload: { owner: dono, repoName: repo, pull: alvo.pull, author: alvo.author },
    });
  }

  const triggerService = new TriggerService(db);
  const config = { kind: "poll" as const, source: "github", owner: dono, repoMatch: repo, everyMinutes: cadencia };
  const doMeu = await triggerService.set(
    agent.id,
    { ...config, authorship: "mine" },
    { enabled: true },
  );
  const doTime = await triggerService.set(
    agent.id,
    { ...config, authorship: "others" },
    { enabled: true },
  );

  /** O que o agendador teria mandado executar. Nenhum run chega a existir. */
  const pedidos: { triggerId: string; eventId: string | null }[] = [];
  const semExecutor = new (class extends ExecutionService {
    async startForEvent(
      input: Parameters<InstanceType<typeof ExecutionService>["startForEvent"]>[0],
    ) {
      pedidos.push({ triggerId: input.triggerId ?? "", eventId: input.eventId });
      return { runId: `smoke-run-${randomUUID()}`, status: "queued" as const };
    }
  })(db);

  // Só os dois gatilhos plantados: o banco de quem desenvolve pode ter outro
  // habilitado, e a batida do smoke não pode sair varrendo o que é de verdade.
  const meus = [doMeu.id, doTime.id];
  const soOsPlantados = new (class extends TriggerService {
    async enabled() {
      return (await this.list()).filter((gatilho) => meus.includes(gatilho.id));
    }
  })(db);

  const varrer = async (owner: string): Promise<string[]> => {
    if (owner !== dono) throw new Error(`a varredura visitou ${owner}, que nao e o dono plantado`);
    return [meu.eventId, alheio.eventId];
  };
  const naoConferir = async () => ({
    checked: 0,
    settled: [],
    stillOpen: 0,
    unreadable: 0,
    failed: [],
  });

  const agendador = new Scheduler(
    db,
    soOsPlantados,
    semExecutor,
    mcpService,
    await semSlack(),
    varrer,
    naoConferir,
    async () => eu,
  );

  try {
    const batida = await agendador.tick({ reason: "timer" });
    const achar = (triggerId: string) => {
      const saida = batida.outcomes.find((o) => o.triggerId === triggerId);
      if (saida === undefined) throw new Error(`o gatilho ${triggerId} ficou de fora da batida`);
      return saida;
    };

    for (const [gatilho, esperado, rotulo] of [
      [doMeu.id, meu.eventId, "mine"],
      [doTime.id, alheio.eventId, "others"],
    ] as const) {
      const saida = achar(gatilho);
      if (saida.status !== "fired") {
        throw new Error(`o gatilho de ${rotulo} respondeu ${saida.status}: ${saida.detail ?? ""}`);
      }
      // A varredura trouxe os dois, e é isso que o contador de eventos diz: o
      // que o filtro corta aparece na diferença entre eventos e execuções.
      if (saida.events !== 2) {
        throw new Error(`o gatilho de ${rotulo} contou ${saida.events} evento(s), e nao dois`);
      }
      const doGatilho = pedidos.filter((p) => p.triggerId === gatilho);
      if (doGatilho.length !== 1) {
        throw new Error(
          `o gatilho de ${rotulo} quis executar ${doGatilho.length} evento(s), e nao um`,
        );
      }
      if (doGatilho[0]?.eventId !== esperado) {
        throw new Error(`o gatilho de ${rotulo} acordou com o evento errado`);
      }
      if (saida.detail === undefined) {
        throw new Error(`o gatilho de ${rotulo} nao contou o evento que descartou`);
      }
    }

    // O outro lado da trava: sem conta conferida não dá para dizer de quem é o
    // pull request, e deixar passar acordaria cada gatilho com o do outro.
    const semConta = new Scheduler(
      db,
      soOsPlantados,
      semExecutor,
      mcpService,
      await semSlack(),
      varrer,
      naoConferir,
      async () => null,
    );
    const pedidosAntes = pedidos.length;
    // Uma hora à frente porque a batida anterior gravou o cursor: no mesmo
    // instante os dois gatilhos responderiam `waiting` e nada seria provado.
    const semConferir = await semConta.tick({ at: Date.now() + 3_600_000, reason: "timer" });
    for (const saida of semConferir.outcomes) {
      if (saida.status !== "failed") {
        throw new Error(`sem conta conferida o gatilho respondeu ${saida.status}`);
      }
    }
    if (pedidos.length !== pedidosAntes) {
      throw new Error("sem conta conferida o agendador ainda quis executar alguma coisa");
    }

    return t("smoke.authorship", { mine: "mine", others: "others", viewer: eu });
  } finally {
    for (const id of meus) await triggerService.remove(id);
    await db
      .delete(schema.cursors)
      .where(and(eq(schema.cursors.source, "scheduler"), inArray(schema.cursors.key, meus)));
    await db
      .delete(schema.events)
      .where(inArray(schema.events.id, [meu.eventId, alheio.eventId]));
  }
}

/**
 * Um cadastro de Slack que nao observa nada.
 *
 * Toda batida de exame passa por aqui em vez de pelo cadastro de verdade: o
 * smoke roda no banco de quem desenvolve, e se ele tiver um Slack cadastrado a
 * batida sairia perguntando mensagem a um workspace real por causa de um exame.
 * Nao varreria mais que leitura, mas nao e disto que o exame trata.
 */
async function semSlack(): Promise<SlackService> {
  const { SlackService, SLACK_SEM_CADASTRO } = await import("../src/services/slack-service.js");
  return new (class extends SlackService {
    async get() {
      return SLACK_SEM_CADASTRO;
    }
  })();
}

/**
 * Confere a fonte de mensagem de canal do Slack, contra o servidor de brinquedo.
 *
 * Nenhum Slack de verdade e alcancado, e nao ha token de Slack em lugar nenhum
 * do caminho: quem responde e o `slack_history` do fixture, um processo stdio
 * que sobe do proprio pacote e devolve mensagem no formato do Slack.
 *
 * O que esta sendo provado e o que a story pede. Primeiro que um canal
 * cadastrado vira evento normalizado, com autor, canal, texto e vinculo da
 * thread no topo do corpo, e nao enterrado num `item` cru. Depois que o cursor
 * e por canal: dois canais observados andam cada um com o seu, e o segundo nao
 * herda a janela que o primeiro ja consumiu. Por fim que a segunda varredura
 * nao reprocessa o que a primeira gravou, que e o que a chave externa existe
 * para garantir, porque o `oldest` do Slack e inclusive e devolve a ultima
 * mensagem de novo.
 *
 * Execucao nenhuma chega a existir: quem varre aqui e a fonte, e nao o
 * agendador, entao nenhum run e criado e nenhuma assinatura e gasta.
 */
async function checkSlack(): Promise<string> {
  const { db, schema } = await import("../src/db/index.js");
  const { and, eq, inArray } = await import("drizzle-orm");
  const { SlackService, SLACK_SEM_CADASTRO } = await import("../src/services/slack-service.js");
  const { ensureFixtureServer, FIXTURE_SERVER } = await import("../src/fixtures/mcp-fixture.js");
  const { pollSlack, slackCursorKey, slackSource } = await import("../src/sources/slack.js");

  /**
   * Onde o canal de brinquedo comeca, em epoch de segundos.
   *
   * Repetido do fixture de proposito: o exame precisa saber o carimbo exato
   * para conferir onde cada cursor parou, e importar a constante do servidor
   * traria o processo inteiro para dentro deste, que e o que o `foraDoAsar`
   * logo acima existe para evitar.
   */
  const PRIMEIRO_TS = Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000);

  await ensureFixtureServer({
    command: [process.execPath, foraDoAsar(join(__dirname, "mcp-fixture-server.mjs"))],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });

  // Canais sorteados de proposito, pelo mesmo motivo do `checkWatched`: o
  // cadastro que ficasse para tras se a limpeza falhasse nao pode apontar para
  // canal de verdade.
  const canais = [
    `C-smoke-${randomUUID().slice(0, 8)}`,
    `C-smoke-${randomUUID().slice(0, 8)}`,
  ];
  const mensagens = 3;
  const source = slackSource(FIXTURE_SERVER);

  // O cadastro do exame vive so nesta funcao: gravar no servico de verdade
  // sobrescreveria o Slack de quem desenvolve.
  const watch = {
    ...SLACK_SEM_CADASTRO,
    server: FIXTURE_SERVER,
    tool: "slack_history",
    channelArg: "channel_id",
    sinceArg: "oldest",
    limit: 50,
    channels: canais,
  };

  const externos = canais.flatMap((canal) =>
    Array.from({ length: mensagens }, (_, i) => `slack:${canal}:${PRIMEIRO_TS + i * 60}.000100`),
  );

  const limpar = async (): Promise<void> => {
    await db
      .delete(schema.events)
      .where(and(eq(schema.events.source, source), inArray(schema.events.externalId, externos)));
    await db
      .delete(schema.cursors)
      .where(
        and(
          eq(schema.cursors.source, source),
          inArray(schema.cursors.key, canais.map(slackCursorKey)),
        ),
      );
  };

  // Antes de comecar tambem: uma iteracao morta no meio deixaria os eventos
  // gravados, e a primeira varredura passaria sem provar nada.
  await limpar();

  try {
    const primeira = await pollSlack(watch, { db, slack: new SlackService() });
    for (const canal of primeira.byChannel) {
      if (canal.error !== undefined) throw new Error(`${canal.channel}: ${canal.error}`);
    }
    if (primeira.eventIds.length !== canais.length * mensagens) {
      throw new Error(
        `a primeira varredura do Slack gravou ${primeira.eventIds.length} evento(s), e nao ${canais.length * mensagens}`,
      );
    }

    const gravados = await db
      .select({ externalId: schema.events.externalId, payload: schema.events.payload })
      .from(schema.events)
      .where(and(eq(schema.events.source, source), inArray(schema.events.externalId, externos)));
    if (gravados.length !== externos.length) {
      throw new Error(`o banco ficou com ${gravados.length} mensagem(ns) de ${externos.length}`);
    }

    let respostas = 0;
    for (const evento of gravados) {
      const corpo = evento.payload as {
        author?: unknown;
        channel?: unknown;
        text?: unknown;
        threadTs?: unknown;
        reply?: unknown;
        permalink?: unknown;
        changedFiles?: unknown;
        repo?: unknown;
      };
      if (typeof corpo.author !== "string" || corpo.author === "") {
        throw new Error(`a mensagem ${evento.externalId} veio sem autor`);
      }
      if (typeof corpo.channel !== "string" || !canais.includes(corpo.channel)) {
        throw new Error(`a mensagem ${evento.externalId} veio sem canal`);
      }
      if (typeof corpo.text !== "string" || corpo.text === "") {
        throw new Error(`a mensagem ${evento.externalId} veio sem texto`);
      }
      if (typeof corpo.threadTs !== "string" || corpo.threadTs === "") {
        throw new Error(`a mensagem ${evento.externalId} veio sem vinculo de thread`);
      }
      if (typeof corpo.permalink !== "string") {
        throw new Error(`a mensagem ${evento.externalId} veio sem endereco`);
      }
      // Normalizada como a de qualquer outra fonte: o executor le `repo` e
      // `changedFiles` sem saber que o trabalho veio de uma conversa.
      if (!Array.isArray(corpo.changedFiles) || typeof corpo.repo !== "string") {
        throw new Error(`a mensagem ${evento.externalId} nao saiu normalizada`);
      }
      if (corpo.reply === true) respostas += 1;
    }
    // Uma resposta por canal, que e o que o fixture planta: sem isso o vinculo
    // da thread estaria sendo conferido so onde ele e o proprio `ts`.
    if (respostas !== canais.length) {
      throw new Error(`${respostas} mensagem(ns) em thread, e esperava ${canais.length}`);
    }

    // Um cursor por canal, que e o que a story pede: os dois existem, e cada um
    // parou no carimbo da ultima mensagem daquele canal.
    const ultimo = `${PRIMEIRO_TS + (mensagens - 1) * 60}.000100`;
    for (const canal of canais) {
      const [linha] = await db
        .select({ value: schema.cursors.value })
        .from(schema.cursors)
        .where(
          and(eq(schema.cursors.source, source), eq(schema.cursors.key, slackCursorKey(canal))),
        );
      if (linha?.value !== ultimo) {
        throw new Error(`o cursor de ${canal} parou em ${linha?.value ?? "nada"}, e nao em ${ultimo}`);
      }
    }

    const segunda = await pollSlack(watch, { db, slack: new SlackService() });
    if (segunda.eventIds.length !== 0) {
      throw new Error(`a segunda varredura do Slack gravou ${segunda.eventIds.length} evento(s)`);
    }
    if (segunda.seen === 0) {
      throw new Error("a segunda varredura do Slack nao chegou a ler nada");
    }

    return t("smoke.slack", { events: primeira.eventIds.length });
  } finally {
    await limpar();
  }
}

/**
 * Prova que o digest junta a conversa, agrupa, e para na fila como leitura.
 *
 * Nenhum Slack e alcancado, e nem o servidor de brinquedo sobe: o que a story
 * pede e o que acontece depois que a fonte ja gravou, entao as mensagens sao
 * plantadas direto na tabela de eventos, com a mesma cara que a fonte do M8.2
 * da a elas. Sinteticas de proposito: um exame que dependesse de conversa de
 * verdade nao teria como afirmar quantas mensagens deviam sobrar.
 *
 * Quatro coisas estao sendo provadas. Que a ingestao agrupa por canal e por
 * thread, e nao devolve uma lista corrida. Que ela filtra ruido antes do
 * modelo, que e a razao de ela ser deterministica. Que a entrega anda: a
 * segunda batida nao junta de novo o que ja saiu. E que o digest cai na fila
 * como pendencia de leitura e aparece na inbox, sem publicar nada em lugar
 * nenhum, porque este agent nao tem lado de fora.
 *
 * O passo de modelo entra plantado como `done`, do jeito que o executor retoma
 * um run interrompido: o exame ja conhece o texto que ele devolveria, e ouvi-lo
 * do modelo custaria um minuto de assinatura por iteracao do loop.
 */
async function checkDigest(): Promise<string> {
  const { and, eq, inArray } = await import("drizzle-orm");
  const { db, schema } = await import("../src/db/index.js");
  const { AgentSpec } = await import("../src/config/types.js");
  const { buildDigestEvent, collectSlackDigest, DIGEST_SOURCE, digestCursorKey } = await import(
    "../src/digest/ingest.js"
  );
  const { DigestProposal } = await import("../src/digest/proposal.js");
  const { buildExecutor, buildGate } = await import("../src/executor/build.js");
  const { slackDigestSpec } = await import("../src/examples/agents.js");
  const { agentService } = await import("../src/services/agent-service.js");
  const { approvalService } = await import("../src/services/approval-service.js");
  const { slackSource } = await import("../src/sources/slack.js");

  // Servidor, canais e agent sorteados pelo mesmo motivo do exame do Slack: o
  // smoke roda no banco de quem desenvolve, e o que ficasse para tras se a
  // limpeza falhasse nao pode se confundir com cadastro de verdade.
  const server = `locum-smoke-digest-${randomUUID().slice(0, 8)}`;
  const agentId = `locum-smoke-digest-${randomUUID().slice(0, 6)}`;
  const source = slackSource(server);
  const suporte = `C-smoke-a-${randomUUID().slice(0, 8)}`;
  const avisos = `C-smoke-b-${randomUUID().slice(0, 8)}`;

  const PRIMEIRO_TS = Math.floor(Date.parse("2026-02-01T00:00:00.000Z") / 1000);
  const carimbo = (i: number): string => `${PRIMEIRO_TS + i * 60}.000100`;

  const pergunta = "Alguem consegue olhar a fila do pedido 4471 hoje?";
  const resposta = "Olhei agora, travou na emissao da nota.";
  const aviso = "Deploy do orquestrador as 18h, janela de dez minutos.";
  const conversa = "bom dia";

  // O que a fonte do Slack grava, com dois pedacos de ruido no meio: o
  // marcador de quem entrou no canal, que o Slack manda como mensagem, e uma
  // mensagem sem texto, que e como chega anexo sem comentario.
  const mensagens = [
    { channel: suporte, ts: carimbo(0), threadTs: carimbo(0), author: "alice.exemplo", text: pergunta },
    { channel: suporte, ts: carimbo(1), threadTs: carimbo(0), author: "bruno.exemplo", text: resposta },
    { channel: suporte, ts: carimbo(2), threadTs: carimbo(2), author: "alice.exemplo", text: "alice entrou no canal", subtype: "channel_join" },
    { channel: avisos, ts: carimbo(3), threadTs: carimbo(3), author: "esteira", text: aviso },
    { channel: avisos, ts: carimbo(4), threadTs: carimbo(4), author: "esteira", text: "   " },
  ];
  const externos = mensagens.map((m) => `slack:${m.channel}:${m.ts}`);

  let runId: string | undefined;
  let eventId: string | null = null;

  const limpar = async (): Promise<void> => {
    if (runId !== undefined) {
      await db.delete(schema.approvals).where(eq(schema.approvals.runId, runId));
      await db.delete(schema.steps).where(eq(schema.steps.runId, runId));
      await db.delete(schema.runs).where(eq(schema.runs.id, runId));
    }
    await db.delete(schema.agentVersions).where(eq(schema.agentVersions.agentId, agentId));
    await db.delete(schema.agents).where(eq(schema.agents.id, agentId));
    await db
      .delete(schema.events)
      .where(and(eq(schema.events.source, source), inArray(schema.events.externalId, externos)));
    await db
      .delete(schema.events)
      .where(
        and(
          eq(schema.events.source, DIGEST_SOURCE),
          eq(schema.events.externalId, `${digestCursorKey(server)}:${carimbo(4)}`),
        ),
      );
    await db
      .delete(schema.cursors)
      .where(
        and(eq(schema.cursors.source, DIGEST_SOURCE), eq(schema.cursors.key, digestCursorKey(server))),
      );
  };

  await limpar();

  try {
    // Carimbo de chegada explicito e crescente: com o padrao, as cinco cairiam
    // no mesmo segundo e a ordem de leitura ficaria por conta do sqlite.
    const chegada = Math.floor(Date.now() / 1000);
    for (const [i, m] of mensagens.entries()) {
      await db.insert(schema.events).values({
        id: randomUUID(),
        source,
        externalId: `slack:${m.channel}:${m.ts}`,
        receivedAt: chegada + i,
        payload: {
          repo: `slack/${m.channel}`,
          changedFiles: [],
          server,
          channel: m.channel,
          author: m.author,
          text: m.text,
          ts: m.ts,
          threadTs: m.threadTs,
          reply: m.threadTs !== m.ts,
          permalink: `https://exemplo.invalido/${m.channel}/${m.ts}`,
          item: m.subtype === undefined ? { ts: m.ts } : { ts: m.ts, subtype: m.subtype },
          at: m.ts,
        },
      });
    }

    const pacote = await collectSlackDigest(server);
    if (pacote.channels.length !== 2) {
      throw new Error(`a ingestao agrupou ${pacote.channels.length} canal(is), e nao 2`);
    }
    if (pacote.dropped !== 2) {
      throw new Error(`a ingestao descartou ${pacote.dropped} mensagem(ns) de ruido, e nao 2`);
    }
    if (pacote.messages !== 3) {
      throw new Error(`sobraram ${pacote.messages} mensagem(ns) para o modelo, e nao 3`);
    }
    if (pacote.until !== carimbo(4)) {
      throw new Error(`a janela parou em ${pacote.until}, e nao em ${carimbo(4)}`);
    }

    const canalSuporte = pacote.channels.find((c) => c.channel === suporte);
    if (canalSuporte?.threads.length !== 1) {
      throw new Error(`o canal de suporte saiu com ${canalSuporte?.threads.length ?? 0} thread(s)`);
    }
    const thread = canalSuporte.threads[0]!;
    if (thread.messages.length !== 2 || thread.threadTs !== carimbo(0)) {
      throw new Error(`a thread saiu com ${thread.messages.length} mensagem(ns) em ${thread.threadTs}`);
    }
    // O assunto vem de quem abriu a thread, e nao da ultima resposta: e por ele
    // que o digest e lido, e a resposta sozinha nao diz do que se trata.
    if (thread.subject !== pergunta) throw new Error(`o assunto da thread saiu como "${thread.subject}"`);
    const canalAvisos = pacote.channels.find((c) => c.channel === avisos);
    if (canalAvisos?.threads.length !== 1 || canalAvisos.threads[0]!.messages.length !== 1) {
      throw new Error("o canal de avisos nao saiu com um assunto de uma mensagem");
    }

    eventId = await buildDigestEvent(pacote);
    if (eventId === null) throw new Error("a ingestao nao gravou o evento do digest");

    const [cursor] = await db
      .select({ value: schema.cursors.value })
      .from(schema.cursors)
      .where(
        and(eq(schema.cursors.source, DIGEST_SOURCE), eq(schema.cursors.key, digestCursorKey(server))),
      );
    if (cursor?.value !== carimbo(4)) {
      throw new Error(`o cursor da entrega parou em ${cursor?.value ?? "nada"}`);
    }

    // A entrega andou: a mesma conversa nao volta no proximo digest, que e o
    // que "desde a ultima entrega" quer dizer.
    const segundo = await collectSlackDigest(server);
    if (segundo.channels.length !== 0 || segundo.messages !== 0) {
      throw new Error(`a segunda batida juntou ${segundo.messages} mensagem(ns) de novo`);
    }
    if ((await buildDigestEvent(segundo)) !== null) {
      throw new Error("a segunda batida gravou digest de conversa nenhuma");
    }

    const spec = AgentSpec.parse({ ...slackDigestSpec, id: agentId, name: `Smoke ${agentId}` });
    const versao = await agentService.upsert(spec, `smoke ${agentId}`, "human");

    const executor = await buildExecutor();
    runId = await executor.createRun(versao.id, eventId);

    // O que o passo de modelo teria devolvido. Os assuntos do mesmo canal
    // entram fora de ordem de proposito: quem ordena e a proposta.
    const leitura = {
      headline: "Tres assuntos, um esperando voce.",
      items: [
        {
          channel: suporte,
          subject: conversa,
          kind: "ignore",
          summary: "Cumprimento de comeco de dia, sem nada pedido.",
        },
        {
          channel: avisos,
          subject: aviso,
          kind: "info",
          summary: "A esteira avisou a janela de deploy do orquestrador.",
        },
        {
          channel: suporte,
          subject: pergunta,
          kind: "needs_reply",
          summary: "Alice pergunta quem olha a fila do pedido, e Bruno achou o travamento na emissao da nota.",
          threadTs: carimbo(0),
        },
      ],
    };
    await db.insert(schema.steps).values({
      id: `${runId}-read`,
      runId,
      idx: 0,
      stepKey: "read",
      name: "Leitura",
      status: "done",
      output: leitura,
    });

    const estado = await executor.execute(runId);
    if (estado !== "paused") throw new Error(`o run terminou como "${estado}", e nao parado na fila`);

    const passos = await db.select().from(schema.steps).where(eq(schema.steps.runId, runId));
    const acao = passos.find((p) => p.stepKey === "deliver");
    if (acao?.status !== "awaiting_approval") {
      throw new Error(`o passo de entrega ficou "${String(acao?.status)}"`);
    }

    const pendencias = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId));
    if (pendencias.length !== 1) throw new Error(`o passo criou ${pendencias.length} pendencia(s)`);
    const pendencia = pendencias[0]!;
    if (pendencia.kind !== "digest.deliver" || pendencia.status !== "pending") {
      throw new Error(`a pendencia saiu como "${pendencia.kind}" em "${pendencia.status}"`);
    }

    // Aparece na inbox, que e onde a story pede que ele apareca, e pela mesma
    // consulta que a interface e a linha de comando usam.
    const fila = await approvalService.listPending();
    if (!fila.some((p) => p.id === pendencia.id)) {
      throw new Error("o digest nao apareceu na inbox");
    }

    const proposta = DigestProposal.parse(pendencia.payload);
    if (proposta.channels.length !== 2) {
      throw new Error(`a proposta agrupou ${proposta.channels.length} canal(is)`);
    }
    if (proposta.channels[0]!.channel !== suporte || proposta.channels[1]!.channel !== avisos) {
      throw new Error("a proposta nao ordenou os canais pelo nome");
    }
    if (proposta.channels[0]!.items[0]!.kind !== "needs_reply") {
      throw new Error("a proposta nao pos o que pede resposta na frente do canal");
    }
    if (proposta.counts.needs_reply !== 1 || proposta.counts.info !== 1 || proposta.counts.ignore !== 1) {
      throw new Error("a contagem por classe nao bate com o que o modelo classificou");
    }
    for (const trecho of [suporte, avisos, pergunta, aviso]) {
      if (!proposta.body.includes(trecho)) {
        throw new Error(`o digest proposto nao traz "${trecho.slice(0, 40)}"`);
      }
    }

    // As travas do handler: um digest entregue sozinho sairia da fila sem
    // ninguem ter lido, e rascunho de leitura nao quer dizer nada. A recusa
    // acontece antes de gravar, entao nem pendencia orfa fica para tras.
    const gate = buildGate();
    for (const modo of ["draft", "auto"] as const) {
      const recusou = await gate
        .submit({ runId, stepId: acao.id, kind: "digest.deliver", payload: leitura }, modo)
        .then(
          () => false,
          () => true,
        );
      if (!recusou) throw new Error(`a gate aceitou entregar o digest em modo "${modo}"`);
    }

    const recusouVazio = await gate
      .submit(
        { runId, stepId: acao.id, kind: "digest.deliver", payload: { headline: leitura.headline, items: [] } },
        "approve",
      )
      .then(
        () => false,
        () => true,
      );
    if (!recusouVazio) throw new Error("a gate propos digest sem assunto nenhum");

    const depois = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId));
    if (depois.length !== 1) throw new Error(`as recusas deixaram ${depois.length} pendencia(s)`);

    return t("smoke.digest", {
      channels: pacote.channels.length,
      messages: pacote.messages,
      dropped: pacote.dropped,
    });
  } finally {
    // O smoke roda no banco de quem desenvolve: o que foi plantado sai daqui
    // mesmo quando uma linha acima estourou.
    await limpar();
  }
}

/**
 * Prova que responder no Slack para na fila com o texto exato que sairia.
 *
 * Nenhum Slack é alcançado, e o servidor de brinquedo nem sobe: o que a story
 * pede acontece antes de qualquer chamada de ferramenta, e a publicação só
 * existe depois do clique de uma pessoa, que este exame não dá. A mensagem é
 * plantada direto na tabela de eventos, com a mesma cara que a fonte do M8.2
 * dá a ela.
 *
 * Quatro coisas estão sendo provadas. Que o passo de ação para o run e cria a
 * pendência. Que o que fica gravado nela é o texto do modelo, palavra por
 * palavra, com canal e thread vindos do evento e não do modelo. Que a thread é
 * conferida contra o que o Locum leu, então carimbo inventado não vira
 * pendência. E que a gate recusa `draft` e `auto`, que é a trava de código que
 * mantém a mensagem assinada por uma pessoa dependendo dessa pessoa.
 *
 * O passo de modelo entra plantado como `done`, como no exame do digest: o
 * exame já sabe o texto que ele devolveria, e ouvi-lo do modelo custaria um
 * minuto de assinatura por iteração do loop.
 */
async function checkSlackPost(): Promise<string> {
  const { and, eq, inArray } = await import("drizzle-orm");
  const { db, schema } = await import("../src/db/index.js");
  const { AgentSpec } = await import("../src/config/types.js");
  const { buildExecutor, buildGate } = await import("../src/executor/build.js");
  const { slackReplySpec } = await import("../src/examples/agents.js");
  const { agentService } = await import("../src/services/agent-service.js");
  const { approvalService } = await import("../src/services/approval-service.js");
  const { SlackPostProposal } = await import("../src/slack/proposal.js");
  const { slackSource } = await import("../src/sources/slack.js");

  // Servidor, canal e agent sorteados pelo mesmo motivo dos outros exames: o
  // smoke roda no banco de quem desenvolve, e o que ficasse para tras se a
  // limpeza falhasse nao pode se confundir com cadastro de verdade.
  const server = `locum-smoke-reply-${randomUUID().slice(0, 8)}`;
  const agentId = `locum-smoke-reply-${randomUUID().slice(0, 6)}`;
  const canal = `C-smoke-r-${randomUUID().slice(0, 8)}`;
  const source = slackSource(server);

  const abertura = `${Math.floor(Date.parse("2026-03-02T12:00:00.000Z") / 1000)}.000100`;
  const pergunta = "Alguem sabe se a emissao da nota do pedido 4471 voltou?";
  const permalink = `https://exemplo.invalido/${canal}/${abertura}`;
  const externalId = `slack:${canal}:${abertura}`;

  // O que o passo de modelo teria escrito. Confirmado adiante caractere por
  // caractere: a fila so vale como ultima leitura se o que ela mostra for o
  // que sai.
  const resposta = "Voltou as 11h40. A fila zerou e a nota do pedido 4471 saiu com o resto.";

  let runId: string | undefined;

  const limpar = async (): Promise<void> => {
    if (runId !== undefined) {
      await db.delete(schema.approvals).where(eq(schema.approvals.runId, runId));
      await db.delete(schema.steps).where(eq(schema.steps.runId, runId));
      await db.delete(schema.runs).where(eq(schema.runs.id, runId));
    }
    await db.delete(schema.agentVersions).where(eq(schema.agentVersions.agentId, agentId));
    await db.delete(schema.agents).where(eq(schema.agents.id, agentId));
    await db
      .delete(schema.events)
      .where(and(eq(schema.events.source, source), inArray(schema.events.externalId, [externalId])));
  };

  await limpar();

  try {
    const [evento] = await db
      .insert(schema.events)
      .values({
        id: randomUUID(),
        source,
        externalId,
        receivedAt: Math.floor(Date.now() / 1000),
        payload: {
          repo: `slack/${canal}`,
          changedFiles: [],
          server,
          channel: canal,
          author: "alice.exemplo",
          text: pergunta,
          ts: abertura,
          threadTs: abertura,
          reply: false,
          permalink,
          item: { ts: abertura },
          at: abertura,
        },
      })
      .returning({ id: schema.events.id });
    if (evento === undefined) throw new Error("o exame nao conseguiu plantar a mensagem do Slack");

    // O `target` do passo aponta para o servidor sorteado. No agent semente ele
    // fica ausente de proposito, e ai vale o Slack cadastrado na maquina; aqui
    // ele existe justamente para o exame nao tocar nesse cadastro.
    const spec = AgentSpec.parse({
      ...slackReplySpec,
      id: agentId,
      name: `Smoke ${agentId}`,
      steps: slackReplySpec.steps.map((passo) =>
        passo.type === "action" ? { ...passo, target: server } : passo,
      ),
    });
    const versao = await agentService.upsert(spec, `smoke ${agentId}`, "human");

    const executor = await buildExecutor();
    runId = await executor.createRun(versao.id, evento.id);

    await db.insert(schema.steps).values({
      id: `${runId}-write`,
      runId,
      idx: 0,
      stepKey: "write",
      name: "Escrever a resposta",
      status: "done",
      output: { text: resposta, threadTs: abertura },
    });

    const estado = await executor.execute(runId);
    if (estado !== "paused") throw new Error(`o run terminou como "${estado}", e nao parado na fila`);

    const passos = await db.select().from(schema.steps).where(eq(schema.steps.runId, runId));
    const acao = passos.find((p) => p.stepKey === "post");
    if (acao?.status !== "awaiting_approval") {
      throw new Error(`o passo de resposta ficou "${String(acao?.status)}"`);
    }

    const pendencias = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId));
    if (pendencias.length !== 1) throw new Error(`o passo criou ${pendencias.length} pendencia(s)`);
    const pendencia = pendencias[0]!;
    if (pendencia.kind !== "slack.post" || pendencia.status !== "pending") {
      throw new Error(`a pendencia saiu como "${pendencia.kind}" em "${pendencia.status}"`);
    }

    const fila = await approvalService.listPending();
    if (!fila.some((p) => p.id === pendencia.id)) {
      throw new Error("a resposta nao apareceu na inbox");
    }

    const proposta = SlackPostProposal.parse(pendencia.payload);
    if (proposta.text !== resposta) {
      throw new Error(`a fila guardou "${proposta.text}" e o modelo escreveu outra coisa`);
    }
    if (proposta.channel !== canal || proposta.threadTs !== abertura || proposta.server !== server) {
      throw new Error(`a proposta aponta para ${proposta.server}, canal ${proposta.channel}, thread ${proposta.threadTs}`);
    }
    // Assunto e endereco saem da mensagem lida, e nao do modelo: e por eles que
    // quem abre a fila sabe a que conversa a resposta esta entrando.
    if (proposta.subject !== pergunta || proposta.permalink !== permalink) {
      throw new Error("a proposta nao trouxe a mensagem original da thread");
    }

    const gate = buildGate();
    const carga = { repo: `slack/${canal}`, text: resposta, threadTs: abertura };

    // As travas do handler: mensagem em canal aparece assinada por uma pessoa,
    // entao ela nao sai sozinha, e rascunho de mensagem de thread nao existe no
    // Slack. A recusa acontece antes de gravar, entao nem pendencia orfa fica.
    for (const modo of ["draft", "auto"] as const) {
      const recusou = await gate
        .submit({ runId, stepId: acao.id, kind: "slack.post", payload: carga, target: server }, modo)
        .then(
          () => false,
          () => true,
        );
      if (!recusou) throw new Error(`a gate aceitou responder no Slack em modo "${modo}"`);
    }

    // Carimbo que o Locum nunca leu nao vira pendencia. E a trava que faz a
    // thread continuar vindo do evento mesmo tendo passado pelo modelo.
    const inventada = await gate
      .submit(
        {
          runId,
          stepId: acao.id,
          kind: "slack.post",
          payload: { ...carga, threadTs: "1700000000.000999" },
          target: server,
        },
        "approve",
      )
      .then(
        () => false,
        () => true,
      );
    if (!inventada) throw new Error("a gate propos resposta para uma thread que ninguem leu");

    const semTexto = await gate
      .submit(
        { runId, stepId: acao.id, kind: "slack.post", payload: { ...carga, text: "   " }, target: server },
        "approve",
      )
      .then(
        () => false,
        () => true,
      );
    if (!semTexto) throw new Error("a gate propos resposta sem texto nenhum");

    const depois = await db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId));
    if (depois.length !== 1) throw new Error(`as recusas deixaram ${depois.length} pendencia(s)`);

    return t("smoke.slackPost", { channel: canal, thread: abertura });
  } finally {
    await limpar();
  }
}

/**
 * Confere a varredura por consulta a servidor MCP, contra o servidor de brinquedo.
 *
 * A terceira forma de fonte do ADR 0001 e a unica que nao tem como ser exposta
 * a rede aqui: webhook espera chamada e a do GitHub precisa de token. Esta
 * cabe inteira dentro da maquina, porque o alvo e um processo stdio que sobe do
 * proprio pacote, entao a varredura de verdade roda sem nada sair.
 *
 * Tres coisas estao sendo provadas, e sao as tres que a fonte existe para
 * garantir: a consulta vira evento normalizado, a segunda varredura nao
 * reprocessa o que a primeira ja gravou, e o cursor nao anda quando a chamada
 * falha. Nenhuma execucao chega a existir: o `ExecutionService` e trocado por
 * um que so anota o pedido, senao o smoke gastaria assinatura a cada iteracao
 * do loop.
 */
async function checkMcpPoll(): Promise<string> {
  const { db, schema } = await import("../src/db/index.js");
  const { and, eq, inArray } = await import("drizzle-orm");
  const { agentService } = await import("../src/services/agent-service.js");
  const { TriggerService } = await import("../src/services/trigger-service.js");
  const { ExecutionService } = await import("../src/services/execution-service.js");
  const { mcpService } = await import("../src/services/mcp-service.js");
  const { Scheduler } = await import("../src/triggers/scheduler.js");
  const { ensureFixtureServer, FIXTURE_SERVER } = await import("../src/fixtures/mcp-fixture.js");
  const { cursorKey, pollMcpServer, sourceName } = await import("../src/sources/mcp-poll.js");

  const [agent] = await agentService.list();
  if (agent === undefined) throw new Error("nenhum agent cadastrado para varrer por MCP");

  // O mesmo lancamento do `checkRenderer`: o binario do Electron em modo Node,
  // e o bundle fora do asar, porque quem o le e um processo filho.
  await ensureFixtureServer({
    command: [process.execPath, foraDoAsar(join(__dirname, "mcp-fixture-server.mjs"))],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });

  const itens = 3;
  const tool = "feed";
  const args = { since: "{{cursor}}", count: itens };
  const source = sourceName(FIXTURE_SERVER);
  const chave = cursorKey({ tool, args });
  const externos = Array.from({ length: itens }, (_, i) => `${tool}:item-${i}`);

  /** O que o feed de brinquedo carimba no ultimo item, e onde o cursor deve parar. */
  const ultimoCarimbo = new Date(
    Date.parse("2026-01-01T00:00:00.000Z") + (itens - 1) * 60_000,
  ).toISOString();

  const limpar = async (): Promise<void> => {
    await db
      .delete(schema.events)
      .where(and(eq(schema.events.source, source), inArray(schema.events.externalId, externos)));
    await db
      .delete(schema.cursors)
      .where(and(eq(schema.cursors.source, source), eq(schema.cursors.key, chave)));
  };

  // Antes de comecar tambem, e nao so no fim: uma iteracao anterior que tenha
  // morrido no meio deixaria os eventos gravados, e a primeira varredura
  // encontraria zero novidade e passaria sem provar nada.
  await limpar();

  const triggerService = new TriggerService(db);
  const gatilho = await triggerService.set(
    agent.id,
    { kind: "mcp-poll", server: FIXTURE_SERVER, tool, args, everyMinutes: 7 },
    { enabled: true },
  );

  const pedidos: string[] = [];
  const semExecutor = new (class extends ExecutionService {
    async startForEvent(
      input: Parameters<InstanceType<typeof ExecutionService>["startForEvent"]>[0],
    ) {
      if (input.eventId !== null) pedidos.push(input.eventId);
      return { runId: `smoke-run-${randomUUID()}`, status: "queued" as const };
    }
  })(db);

  // So o gatilho plantado: o banco de quem desenvolve pode ter outro habilitado,
  // e a batida do smoke nao pode sair varrendo o que e de verdade.
  const soOPlantado = new (class extends TriggerService {
    async enabled() {
      return (await this.list()).filter((t) => t.id === gatilho.id);
    }
  })(db);

  const naoVarrer = async () => {
    throw new Error("o smoke da varredura por MCP nao pode varrer o GitHub");
  };
  const naoConferir = async () => ({
    checked: 0,
    settled: [],
    stillOpen: 0,
    unreadable: 0,
    failed: [],
  });

  const agendador = new Scheduler(
    db,
    soOPlantado,
    semExecutor,
    mcpService,
    await semSlack(),
    naoVarrer,
    naoConferir,
    async () => null,
  );

  const saidaDo = (batida: Awaited<ReturnType<typeof agendador.tick>>) => {
    const saida = batida.outcomes.find((o) => o.triggerId === gatilho.id);
    if (saida === undefined) throw new Error("o gatilho de MCP ficou de fora da batida");
    if (saida.status !== "fired") {
      throw new Error(`o gatilho de MCP respondeu ${saida.status}: ${saida.detail ?? ""}`);
    }
    return saida;
  };

  const cursorAgora = async (): Promise<string | undefined> => {
    const [linha] = await db
      .select({ value: schema.cursors.value })
      .from(schema.cursors)
      .where(and(eq(schema.cursors.source, source), eq(schema.cursors.key, chave)));
    return linha?.value;
  };

  try {
    const primeira = saidaDo(await agendador.tick({ reason: "timer" }));
    if (primeira.events !== itens) {
      throw new Error(`a primeira varredura gravou ${primeira.events} evento(s), e nao ${itens}`);
    }
    if (pedidos.length !== itens) {
      throw new Error(`a primeira varredura quis executar ${pedidos.length} evento(s)`);
    }

    // Evento normalizado como o de qualquer outra fonte: o executor le `repo` e
    // `changedFiles` sem saber que o trabalho veio de um servidor MCP.
    const gravados = await db
      .select({ externalId: schema.events.externalId, payload: schema.events.payload })
      .from(schema.events)
      .where(and(eq(schema.events.source, source), inArray(schema.events.externalId, externos)));
    if (gravados.length !== itens) {
      throw new Error(`o banco ficou com ${gravados.length} evento(s) da varredura por MCP`);
    }
    for (const evento of gravados) {
      const payload = evento.payload as { repo?: unknown; changedFiles?: unknown; item?: unknown };
      if (payload.repo !== `${FIXTURE_SERVER}/${tool}`) {
        throw new Error(`o evento ${evento.externalId} nao diz de onde veio`);
      }
      if (!Array.isArray(payload.changedFiles)) {
        throw new Error(`o evento ${evento.externalId} nao saiu normalizado`);
      }
      if ((payload.item as { text?: unknown } | undefined)?.text === undefined) {
        throw new Error(`o evento ${evento.externalId} nao guardou o item do servidor`);
      }
    }

    const depoisDaPrimeira = await cursorAgora();
    if (depoisDaPrimeira !== ultimoCarimbo) {
      throw new Error(`o cursor parou em ${depoisDaPrimeira}, e nao em ${ultimoCarimbo}`);
    }

    // Uma hora a frente porque a cadencia e de sete minutos: no mesmo instante o
    // gatilho responderia `waiting` e a deduplicacao nao seria exercitada. O
    // feed devolve o ultimo item de novo, entao quem precisa recusar e a chave
    // externa, e nao o servidor.
    const segunda = saidaDo(await agendador.tick({ at: Date.now() + 3_600_000, reason: "timer" }));
    if (segunda.events !== 0) {
      throw new Error(`a segunda varredura gravou ${segunda.events} evento(s), e devia zero`);
    }
    if (segunda.detail === undefined) {
      throw new Error("a segunda varredura nao contou o item que ja conhecia");
    }
    if (pedidos.length !== itens) {
      throw new Error(`a segunda varredura quis executar mais ${pedidos.length - itens} evento(s)`);
    }

    // O outro lado do contrato: chamada que falha nao pode mover o cursor, senao
    // a janela que ninguem leu ficaria para tras.
    await pollMcpServer(
      { server: FIXTURE_SERVER, tool, args },
      {
        db,
        call: async () => {
          throw new Error("queda proposital do servidor");
        },
      },
    ).then(
      () => {
        throw new Error("a varredura engoliu a queda do servidor");
      },
      () => undefined,
    );
    if ((await cursorAgora()) !== ultimoCarimbo) {
      throw new Error("o cursor andou mesmo com a chamada falhando");
    }

    return t("smoke.mcpPoll", { fixture: FIXTURE_SERVER, tool, events: itens });
  } finally {
    await triggerService.remove(gatilho.id);
    await db
      .delete(schema.cursors)
      .where(and(eq(schema.cursors.source, "scheduler"), eq(schema.cursors.key, gatilho.id)));
    await limpar();
  }
}

/**
 * Confere a secao do Slack observado, sem falar com o Slack.
 *
 * O caminho inteiro da story cabe dentro da maquina: escolher pela tela qual
 * servidor MCP responde pelo Slack, guardar, cadastrar um canal e ve-lo
 * aparecer na lista. Nenhum desses passos sai da maquina, porque quem sairia e
 * a varredura, e varredura nenhuma acontece aqui.
 *
 * O servidor escolhido e o de brinquedo e o canal e sorteado pelo mesmo motivo
 * do `checkWatched`: um canal de verdade que ficasse para tras se a limpeza
 * falhasse viraria leitura de conversa real na primeira batida.
 *
 * O cadastro anterior e devolvido no fim. O smoke roda no banco de quem
 * desenvolve, e sair de um exame tendo apagado o Slack dele seria estrago.
 */
async function checkSlackWindow(window: BrowserWindow): Promise<string> {
  await irPara(window, "settings", "connections");
  await abrirConexao(window, "slack");
  const { slackService } = await import("../src/services/slack-service.js");
  const { FIXTURE_SERVER } = await import("../src/fixtures/mcp-fixture.js");

  const antes = await slackService.get();
  const canal = `C-smoke-${randomUUID().slice(0, 8)}`;

  // A seção monta do zero quando se chega de outra tela, e a lista de
  // servidores do formulário vem depois, pela ponte. Escolher antes dela
  // chegar cai numa opção que ainda não existe e deixa o botão desabilitado.
  await esperarProbe<true>(
    window,
    "formulário do Slack",
    `document.querySelector('[data-locum-slack-escolha] option[value="${FIXTURE_SERVER}"]') === null ? null : true`,
  );

  // O bloco do servidor oficial aparece no mesmo painel, com o campo do client
  // id e o botão que cria o app. Conectar abriria o navegador, então o smoke
  // só confere que o caminho está lá e que nada foi ligado sozinho.
  const oficial = await esperarProbe<{ conectado: string; campo: boolean; manifesto: boolean }>(
    window,
    "bloco do Slack oficial",
    `(() => {
      const bloco = document.querySelector('[data-locum-probe="slack-oficial"]');
      if (bloco === null) return null;
      return {
        conectado: bloco.getAttribute("data-locum-slack-oficial-conectado"),
        campo: bloco.querySelector("[data-locum-slack-client-id]") !== null,
        manifesto: bloco.querySelector("[data-locum-slack-manifesto]") !== null,
      };
    })()`,
  );
  if (!oficial.campo || !oficial.manifesto) {
    throw new Error(`bloco do Slack oficial incompleto: ${JSON.stringify(oficial)}`);
  }

  try {
    const guardou = await window.webContents.executeJavaScript(
      `(() => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        ).set;
        const digitar = (seletor, valor) => {
          const campo = document.querySelector(seletor);
          if (campo === null) return false;
          setter.call(campo, valor);
          campo.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        };
        const escolher = (seletor, valor) => {
          const campo = document.querySelector(seletor);
          if (campo === null) return false;
          campo.value = valor;
          campo.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        };
        if (!escolher("[data-locum-slack-escolha]", ${JSON.stringify(FIXTURE_SERVER)})) return false;
        if (!digitar("[data-locum-slack-ferramenta]", "slack_history")) return false;
        const botao = document.querySelector("[data-locum-slack-salvar]");
        if (botao === null || botao.disabled) return false;
        botao.click();
        return true;
      })()`,
    );
    if (guardou !== true) throw new Error("a tela nao ofereceu o formulario do Slack");

    const guardado = await esperarDoServico("origem do Slack guardada pela tela", async () => {
      const atual = await slackService.get();
      return atual.server === FIXTURE_SERVER ? atual : undefined;
    });
    if (guardado.tool !== "slack_history") {
      throw new Error(`a tela gravou a ferramenta ${guardado.tool}`);
    }

    // A tela so aceita canal depois de saber a quem perguntar, e o botao fica
    // desabilitado enquanto a gravacao anterior nao volta. Esperar o marcador da
    // origem e esperar as duas coisas: sem isso o clique cai num botao surdo e o
    // exame acusa formulario ausente onde o que faltou foi um quadro.
    await esperarProbe<string>(
      window,
      "origem do Slack na tela",
      `(() => {
        const secao = document.querySelector('[data-locum-probe="slack"]');
        if (secao === null || secao.dataset.locumSlackServidor !== ${JSON.stringify(FIXTURE_SERVER)}) {
          return null;
        }
        // Pelo botao de guardar, e nao pelo de observar: o de observar fica
        // desabilitado tambem enquanto ninguem digitou canal, e esperar por ele
        // seria esperar para sempre.
        const botao = document.querySelector("[data-locum-slack-salvar]");
        return botao === null || botao.disabled ? null : secao.dataset.locumSlackServidor;
      })()`,
    );

    const cadastrou = await window.webContents.executeJavaScript(
      `(() => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        ).set;
        const campo = document.querySelector("[data-locum-slack-novo-canal]");
        if (campo === null) return false;
        setter.call(campo, ${JSON.stringify(canal)});
        campo.dispatchEvent(new Event("input", { bubbles: true }));
        const botao = document.querySelector("[data-locum-slack-adicionar]");
        if (botao === null || botao.disabled) return false;
        botao.click();
        return true;
      })()`,
    );
    if (cadastrou !== true) throw new Error("a tela nao ofereceu o campo de canal");

    await esperarDoServico("canal observado pela tela", async () => {
      const atual = await slackService.get();
      return atual.channels.includes(canal) ? atual : undefined;
    });

    // A recusa da ponte vira mensagem daqui antes de virar espera estourada.
    const recusa = (await window.webContents.executeJavaScript(
      `document.querySelector("[data-locum-slack-erro]")?.dataset.locumSlackErro ?? null`,
    )) as string | null;
    if (recusa !== null) throw new Error(`a secao do Slack recusou: ${recusa}`);

    const naTela = await esperarProbe<string>(
      window,
      "canal do Slack na tela",
      `document.querySelector('[data-locum-slack-canal="${canal}"]')
        ?.dataset.locumSlackCanal ?? null`,
    );
    if (naTela !== canal) throw new Error(`a tela mostrou o canal ${naTela}`);

    // A outra metade da regra, e a que nao da para ver na tela: nenhum canal da
    // ponte publica no Slack. A guarda de compilacao no contrato ja impede que
    // um apareca, e esta conferencia e o que sobra para quem le o smoke.
    const { BRIDGE_CHANNELS } = await import("./bridge-contract.js");
    const publica = BRIDGE_CHANNELS.filter((canal) =>
      /^slack\.(post|send|reply)/.test(canal),
    );
    if (publica.length > 0) {
      throw new Error(`a ponte expoe canal que publica no Slack: ${publica.join(", ")}`);
    }

    return t("smoke.slackWindow", { server: FIXTURE_SERVER, channel: canal });
  } finally {
    await slackService.removeChannel(canal);
    if (antes.server === null) {
      await slackService.clear();
    } else {
      await slackService.setSource(antes);
    }
  }
}

/**
 * Confere a secao dos repositorios observados, sem varrer nada.
 *
 * O caminho inteiro da story cabe dentro da maquina: cadastrar pela tela,
 * conferir que o gatilho nasceu parado, liga-lo e ver o agendador calcular a
 * proxima batida, e remover. Nenhum desses passos fala com o GitHub, porque
 * quem falaria e a batida, e batida nenhuma acontece aqui: o `tick` nao e
 * chamado, e o gatilho e removido antes de o smoke sair.
 *
 * O dono e o padrao de repositorio sao sorteados de proposito. O smoke roda no
 * banco de quem desenvolve, e um padrao que casasse com repositorio de verdade
 * deixaria para tras um gatilho apontado para trabalho real caso a limpeza
 * falhasse.
 */
async function checkWatched(window: BrowserWindow): Promise<string> {
  const { agentService } = await import("../src/services/agent-service.js");
  const { triggerService } = await import("../src/services/trigger-service.js");
  const { scheduler } = await import("../src/triggers/scheduler.js");

  const [agent] = await agentService.list();
  if (agent === undefined) throw new Error("nenhum agent cadastrado para observar repositorio");
  // Repositório observado é do agent, e mora no detalhe dele.
  await irPara(window, "agents", agent.id);

  const dono = `locum-smoke-${randomUUID().slice(0, 8)}`;
  const repo = `^locum-smoke-${randomUUID().slice(0, 8)}$`;
  const cadencia = 7;
  // Cadastrar pela tela com o filtro ligado, e não com o padrão: o que decide
  // se o agent acorda é a autoria gravada, e um formulário que a perdesse no
  // caminho faria a pessoa cadastrar "meus" e receber os do time inteiro.
  const autoria = "mine";
  const antes = (await triggerService.list()).map((gatilho) => gatilho.id);

  // O detalhe monta o formulário depois de ler o agent e os gatilhos, e
  // preencher antes disso falhava de vez em quando, sem nada errado na tela.
  await esperarProbe<boolean>(
    window,
    "formulario de observar",
    `document.querySelector("[data-locum-observar-salvar]") === null ? null : true`,
  );

  const preencheu = await window.webContents.executeJavaScript(
    `(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set;
      const digitar = (seletor, valor) => {
        const campo = document.querySelector(seletor);
        if (campo === null) return false;
        setter.call(campo, valor);
        campo.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      };
      const escolher = (seletor, valor) => {
        const campo = document.querySelector(seletor);
        if (campo === null) return false;
        campo.value = valor;
        campo.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      };
      // Dentro do agent a lista de agents não aparece: o agent já está escolhido.
      if (document.querySelector("[data-locum-observar-agent]") !== null) return false;
      if (!escolher("[data-locum-observar-autoria]", ${JSON.stringify(autoria)})) return false;
      if (!digitar("[data-locum-observar-dono]", ${JSON.stringify(dono)})) return false;
      if (!digitar("[data-locum-observar-repo]", ${JSON.stringify(repo)})) return false;
      if (!digitar("[data-locum-observar-cadencia]", ${JSON.stringify(String(cadencia))})) {
        return false;
      }
      const botao = document.querySelector("[data-locum-observar-salvar]");
      if (botao === null || botao.disabled) return false;
      botao.click();
      return true;
    })()`,
  );
  if (preencheu !== true) throw new Error("a tela nao ofereceu o formulario de observar");

  // O identificador so existe depois de o servico gravar, entao ele e
  // descoberto por diferenca em vez de vir da tela: assim o exame nao depende
  // de o marcador estar certo para achar o que tem que limpar depois.
  const criado = await esperarDoServico(
    "gatilho cadastrado pela tela",
    async () => (await triggerService.list()).find((gatilho) => !antes.includes(gatilho.id)),
  );

  try {
    // A recusa da ponte vira mensagem daqui antes de virar espera estourada:
    // "o marcador nao ficou pronto" nao diz por que a linha nao apareceu.
    const recusa = (await window.webContents.executeJavaScript(
      `document.querySelector("[data-locum-observados-erro]")
        ?.dataset.locumObservadosErro ?? null`,
    )) as string | null;
    if (recusa !== null) throw new Error(`a secao de observados recusou: ${recusa}`);

    if (criado.enabled) throw new Error("o gatilho cadastrado pela tela nasceu habilitado");
    if (criado.config.kind !== "poll") {
      throw new Error(`a tela cadastrou um gatilho do tipo ${criado.config.kind}`);
    }
    if (criado.config.owner !== dono || criado.config.repoMatch !== repo) {
      throw new Error(
        `a tela gravou ${criado.config.owner}/${criado.config.repoMatch} e nao ${dono}/${repo}`,
      );
    }
    if (criado.config.authorship !== autoria) {
      throw new Error(`a tela gravou a autoria ${criado.config.authorship} e nao ${autoria}`);
    }
    if (criado.config.everyMinutes !== cadencia) {
      throw new Error(`a cadencia gravada foi ${criado.config.everyMinutes} e nao ${cadencia}`);
    }

    const parado = (await scheduler.schedule()).find((s) => s.triggerId === criado.id);
    if (parado === undefined) throw new Error("o gatilho novo nao apareceu no agendador");
    // Parado nao tem proxima batida, e dizer uma data aqui seria prometer na
    // tela uma varredura que o agendador nao vai fazer.
    if (parado.nextDueAt !== null) {
      throw new Error(`o gatilho parado disse que bate em ${parado.nextDueAt}`);
    }

    const naTela = await esperarProbe<{
      habilitado: string;
      alvo: string;
      autoria: string;
      proxima: string;
    }>(
      window,
      "gatilho na tela",
      `(() => {
        const linha = document.querySelector('[data-locum-gatilho="${criado.id}"]');
        if (linha === null) return null;
        return {
          habilitado: linha.dataset.locumGatilhoHabilitado,
          alvo: linha.dataset.locumGatilhoAlvo,
          autoria: linha.dataset.locumGatilhoAutoria,
          proxima: linha.dataset.locumGatilhoProxima,
        };
      })()`,
    );
    if (naTela.habilitado !== "nao") throw new Error("a tela mostrou o gatilho novo como ligado");
    if (naTela.alvo !== `${dono}/${repo}`) {
      throw new Error(`a tela mostrou o alvo ${naTela.alvo} e o cadastro diz ${dono}/${repo}`);
    }
    if (naTela.autoria !== autoria) {
      throw new Error(`a tela mostrou a autoria ${naTela.autoria} e o cadastro diz ${autoria}`);
    }
    if (naTela.proxima !== "") {
      throw new Error(`a tela anunciou a batida ${naTela.proxima} de um gatilho parado`);
    }

    // O clique que a story cobra: ligado, ele aparece no agendador com a
    // proxima batida calculada. Ligar nao varre; quem varreria e o `tick`, que
    // este exame nao chama.
    const cliquei = Date.now();
    const ligou = await window.webContents.executeJavaScript(
      `(() => {
        const botao = document.querySelector('[data-locum-gatilho-ligar="${criado.id}"]');
        if (botao === null) return false;
        botao.click();
        return true;
      })()`,
    );
    if (ligou !== true) throw new Error("a tela nao ofereceu botao de ligar o gatilho");

    await esperarProbe<true>(
      window,
      "gatilho ligado pela tela",
      `document.querySelector('[data-locum-gatilho="${criado.id}"]')
        ?.dataset.locumGatilhoHabilitado === "sim" ? true : null`,
    );

    // O relogio e passado de fora para que as duas perguntas abaixo respondam
    // sobre o mesmo instante: gatilho que nunca disparou esta vencido agora, e
    // com dois `Date.now()` a comparacao viraria uma corrida de milissegundos.
    const agora = Date.now();
    const ligado = (await scheduler.schedule(agora)).find((s) => s.triggerId === criado.id);
    if (ligado?.enabled !== true) throw new Error("o gatilho ligado na tela continuou parado");
    if (ligado.nextDueAt === null) {
      throw new Error("o agendador nao calculou a proxima batida do gatilho ligado");
    }
    if (ligado.everyMinutes !== cadencia) {
      throw new Error(`o agendador leu a cadencia ${ligado.everyMinutes} e nao ${cadencia}`);
    }
    // Vencido, e nao daqui a uma cadencia: esperar sete minutos para a primeira
    // varredura de um gatilho que alguem acabou de ligar seria demora que
    // ninguem pediu.
    if (ligado.nextDueAt !== agora) {
      throw new Error(`o gatilho ligado agora quer bater em ${ligado.nextDueAt}`);
    }
    if ((await scheduler.nextDueAt(agora)) !== agora) {
      throw new Error("a batida do gatilho novo ficou de fora da proxima batida do agendador");
    }

    const naTelaLigado = await esperarProbe<string>(
      window,
      "batida do gatilho na tela",
      `(() => {
        const linha = document.querySelector('[data-locum-gatilho="${criado.id}"]');
        const proxima = linha?.dataset.locumGatilhoProxima;
        return proxima === undefined || proxima === "" ? null : proxima;
      })()`,
    );
    // A tela leu com o relogio dela, entao o que da para exigir e a janela: a
    // batida anunciada caiu entre o clique de ligar e agora, que e o que
    // "vencido" quer dizer. Igualdade exata aqui seria exigir que os dois lados
    // tivessem lido o relogio no mesmo milissegundo.
    const anunciada = Number(naTelaLigado);
    if (!Number.isFinite(anunciada) || anunciada < cliquei || anunciada > Date.now()) {
      throw new Error(`a tela anunciou a batida ${naTelaLigado}, fora da janela do clique`);
    }

    const removeu = await window.webContents.executeJavaScript(
      `(() => {
        const botao = document.querySelector('[data-locum-gatilho-remover="${criado.id}"]');
        if (botao === null) return false;
        botao.click();
        return true;
      })()`,
    );
    if (removeu !== true) throw new Error("a tela nao ofereceu botao de remover o gatilho");

    await esperarProbe<true>(
      window,
      "gatilho removido pela tela",
      `document.querySelector('[data-locum-gatilho="${criado.id}"]') === null ? true : null`,
    );
    if ((await triggerService.list()).some((gatilho) => gatilho.id === criado.id)) {
      throw new Error("o gatilho sobreviveu ao remover da tela");
    }

    return t("smoke.watched", {
      target: `${dono}/${repo}`,
      next: new Date(ligado.nextDueAt).toISOString(),
    });
  } finally {
    // O clique de remover pode nao ter chegado, e um gatilho de varredura
    // habilitado sobrevivendo ao smoke faria a proxima subida do app sair
    // varrendo uma organizacao que nao existe.
    await triggerService.remove(criado.id);
  }
}

/**
 * Espera o servico responder alguma coisa, com a mesma cadencia do `esperarProbe`.
 *
 * Existe porque o clique na tela e assincrono dos dois lados: o `call` volta
 * pela ponte e so depois o servico grava. Perguntar uma vez so ao banco daria
 * falso negativo por milissegundos.
 */
async function esperarDoServico<T>(
  nome: string,
  ler: () => Promise<T | undefined>,
  limiteMs = 20_000,
): Promise<T> {
  const limite = Date.now() + limiteMs;

  while (Date.now() < limite) {
    const visto = await ler();
    if (visto !== undefined) return visto;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`${nome} nao apareceu dentro de ${limiteMs / 1000}s`);
}

/**
 * Confere a secao da credencial do GitHub, sem nunca falar com o GitHub.
 *
 * O marco proibe credencial de verdade, e essa proibicao nao tira nada do que
 * a story pede: guardar, ler do cofre, conferir e esquecer sao quatro caminhos
 * que terminam dentro da maquina. O unico pedaco que sairia daqui e a resposta
 * do GitHub a um token, e ela e exercitada pelo servico com uma sonda trocada,
 * que e o que existe para isso no construtor.
 *
 * O exame roda contra uma referencia sorteada, e nao contra `source/github`. O
 * smoke roda no banco e no cofre de quem desenvolve, e escrever na referencia
 * de verdade apagaria um token que pode estar em uso.
 *
 * Na interface, o clique de conferir so acontece com o cofre vazio, quando a
 * resposta e "nao ha token" e nao sai da maquina. Com token guardado o exame
 * pula o clique de proposito: ele viraria uma chamada autenticada a API do
 * GitHub com a credencial de alguem, feita por um loop que roda sem ninguem
 * olhando.
 */
async function checkGithub(window: BrowserWindow): Promise<string> {
  await irPara(window, "settings", "connections");
  await abrirConexao(window, "github");
  const { secretService } = await import("../src/services/secret-service.js");
  const { settingsService } = await import("../src/services/settings-service.js");
  const {
    GITHUB_CREDENTIAL_REF,
    GITHUB_TOKEN_ENV,
    GithubService,
    githubToken,
  } = await import("../src/services/github-service.js");

  if (!secretService.available) throw new Error("keychain indisponivel para o cofre do GitHub");

  const ref = `source/locum-smoke-${randomUUID().slice(0, 8)}`;
  const token = `token-de-mentira-${randomUUID()}`;
  let recebido: string | null = null;

  const servico = new GithubService(
    secretService,
    settingsService,
    async (visto) => {
      recebido = visto;
      return { login: "locum-smoke", scopes: ["repo", "read:org"] };
    },
    ref,
  );

  try {
    const vazio = await servico.status();
    if (vazio.stored) throw new Error(`a referencia sorteada ${ref} ja tinha valor`);
    if (vazio.identity !== null) throw new Error("uma referencia nova nasceu com identidade");

    // Sem token, a conferencia responde de dentro da maquina: a sonda nao e
    // chamada, e e por isso que `recebido` continua nulo logo abaixo.
    const semToken = await servico.check();
    if (semToken.ok || semToken.reason !== "missing") {
      throw new Error(`sem token a conferencia respondeu ${JSON.stringify(semToken)}`);
    }
    if (recebido !== null) throw new Error("a conferencia saiu perguntando sem ter token");

    await servico.setToken(token);
    if (readFileSync(secretService.pathFor(ref)).includes(token)) {
      throw new Error("o token do GitHub foi para o disco em claro");
    }

    const conferida = await servico.check();
    if (!conferida.ok) throw new Error(`a conferencia recusou: ${JSON.stringify(conferida)}`);
    if (recebido !== token) throw new Error("a sonda recebeu um token diferente do guardado");
    if (conferida.login !== "locum-smoke") {
      throw new Error(`a conferencia devolveu a conta ${conferida.login}`);
    }

    const depois = await servico.status();
    if (!depois.stored) throw new Error("o token nao ficou guardado");
    if (depois.identity?.login !== "locum-smoke" || depois.checkedAt === null) {
      throw new Error("a identidade conferida nao sobreviveu ao status");
    }

    // Trocar o token joga fora a conta que era dele. Sem isso a tela mostraria
    // o login antigo ao lado de um token novo, com cara de dado conferido.
    await servico.setToken(`${token}-outro`);
    const trocado = await servico.status();
    if (trocado.identity !== null || trocado.checkedAt !== null) {
      throw new Error("a identidade do token anterior sobreviveu a troca");
    }

    if (!(await servico.clearToken())) throw new Error("esquecer nao achou o que apagar");
    if ((await servico.status()).stored) throw new Error("o token sobreviveu ao esquecer");
  } finally {
    secretService.remove(ref);
    await new GithubService(secretService, settingsService, undefined, ref).clearToken();
  }

  // O caminho que o source usa, com a variavel de ambiente fora do ar: e esse
  // "sem variavel de ambiente" que a story cobra.
  const doAmbiente = process.env[GITHUB_TOKEN_ENV];
  delete process.env[GITHUB_TOKEN_ENV];
  const jaGuardado = secretService.has(GITHUB_CREDENTIAL_REF);
  try {
    if (jaGuardado) {
      // Quem desenvolve ja guardou o token dele. Sobrescrever para provar o
      // caminho seria destruir o que esta em uso, entao o que se confere e que
      // o cofre responde sem o ambiente, que e a mesma afirmacao.
      const lido = githubToken();
      if (lido === undefined) throw new Error("o cofre tinha token e o source nao o enxergou");
    } else {
      secretService.set(GITHUB_CREDENTIAL_REF, token);
      try {
        if (githubToken() !== token) {
          throw new Error("o source nao leu do cofre o token que a interface guardaria");
        }
      } finally {
        secretService.remove(GITHUB_CREDENTIAL_REF);
      }
      if (githubToken() !== undefined) throw new Error("o token sobreviveu ao remove");
    }
  } finally {
    if (doAmbiente !== undefined) process.env[GITHUB_TOKEN_ENV] = doAmbiente;
  }

  // Agora a interface, que e o que a story entrega. A tela ja esta montada; o
  // marcador espera a leitura de `github.status` responder.
  const naTela = await esperarProbe<{ guardado: string; cofre: string; ambiente: string }>(
    window,
    "github",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=github]");
      if (probe === null || probe.dataset.locumGithubGuardado === "") return null;
      return {
        guardado: probe.dataset.locumGithubGuardado,
        cofre: probe.dataset.locumGithubCofre,
        ambiente: probe.dataset.locumGithubAmbiente,
      };
    })()`,
  );

  if (naTela.cofre !== "aberto") throw new Error("a tela diz que o cofre esta fechado");
  const esperado = secretService.has(GITHUB_CREDENTIAL_REF) ? "sim" : "nao";
  if (naTela.guardado !== esperado) {
    throw new Error(`a tela diz "${naTela.guardado}" e o cofre diz "${esperado}"`);
  }

  if (esperado === "sim") {
    // Com token guardado nao ha o que exercitar sem sair da maquina, e o que a
    // linha final do smoke diz e exatamente isso, sem fingir que conferiu.
    return t("smoke.github", { path: t("smoke.githubStored") });
  }

  const clicouConferir = await window.webContents.executeJavaScript(
    `(() => {
      const botao = document.querySelector("[data-locum-github-conferir]");
      if (botao === null) return false;
      botao.click();
      return true;
    })()`,
  );
  if (clicouConferir !== true) throw new Error("a tela nao ofereceu botao de conferir");

  const semTokenNaTela = await esperarProbe<string>(
    window,
    "conferencia do github",
    `document.querySelector("[data-locum-github-resultado]")?.dataset.locumGithubResultado ?? null`,
  );
  if (semTokenNaTela !== "missing") {
    throw new Error(`a tela respondeu "${semTokenNaTela}" para conferir sem token`);
  }

  // Digitar e guardar, que e o caminho que a story pede. O valor e de mentira e
  // sai logo abaixo; o que esta sendo provado e que ele chega ao cofre e que a
  // tela nao o mostra de volta.
  const guardou = await window.webContents.executeJavaScript(
    `(() => {
      const campo = document.querySelector("[data-locum-github-token]");
      const botao = document.querySelector("[data-locum-github-salvar]");
      if (campo === null || botao === null) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set;
      setter.call(campo, ${JSON.stringify(token)});
      campo.dispatchEvent(new Event("input", { bubbles: true }));
      botao.click();
      return true;
    })()`,
  );
  if (guardou !== true) throw new Error("a tela nao ofereceu campo e botao de guardar");

  try {
    await esperarProbe<true>(
      window,
      "token guardado pela tela",
      `document.querySelector("[data-locum-probe=github]")?.dataset.locumGithubGuardado === "sim"
        ? true
        : null`,
    );

    if (githubToken() !== token) {
      throw new Error("o que a tela guardou nao foi o que o source leu do cofre");
    }

    // O campo volta vazio e o valor nao aparece em lugar nenhum da pagina. E o
    // ponto da story: a tela grava segredo e nao o mostra, nem por acidente.
    const naPagina = await window.webContents.executeJavaScript(
      `(() => ({
        campo: document.querySelector("[data-locum-github-token]").value,
        html: document.documentElement.outerHTML.includes(${JSON.stringify(token)}),
      }))()`,
    );
    const visto = naPagina as { campo: string; html: boolean };
    if (visto.campo !== "") throw new Error("o campo ficou com o token depois de guardar");
    if (visto.html) throw new Error("o token apareceu no HTML da pagina");
  } finally {
    secretService.remove(GITHUB_CREDENTIAL_REF);
  }

  const esqueceu = await window.webContents.executeJavaScript(
    `(() => {
      const botao = document.querySelector("[data-locum-github-esquecer]");
      if (botao === null) return false;
      botao.click();
      return true;
    })()`,
  );
  if (esqueceu !== true) throw new Error("a tela nao ofereceu botao de esquecer");

  await esperarProbe<true>(
    window,
    "token esquecido pela tela",
    `document.querySelector("[data-locum-probe=github]")?.dataset.locumGithubGuardado === "nao"
      ? true
      : null`,
  );

  return t("smoke.github", { path: t("smoke.githubRoundTrip") });
}

/**
 * Confere a lista de execucoes e o detalhe de uma delas.
 *
 * Os dois lados sao comparados contra o mesmo servico, e nao contra numeros
 * escritos aqui: o que o loop precisa saber e se a janela mostra o que o banco
 * tem, nao se alguem lembrou de atualizar uma constante deste lado.
 *
 * O botao de reexecutar e conferido por existir, e nunca clicado. Clicar
 * soltaria o executor de verdade, que gasta minutos de assinatura e leva o run
 * junto: o que esta sendo provado aqui e a fiacao, e um passo por botao.
 *
 * Ao sair, a janela fica no detalhe, porque e la que vive o bloco de codigo
 * que a verificacao do destaque procura.
 */
/**
 * Confere que a revisão mostra o veredito gravado e que trocá-lo pela tela
 * chega à pendência.
 *
 * A troca passa pelo mesmo evento de mudança que o clique dispara, e a espera
 * é pelo banco, não pela tela: o que importa é o que a gate vai publicar. No
 * fim o veredito volta ao que era, porque a pendência plantada sobrevive entre
 * fumaças com `LOCUM_HOME` fixo.
 */
async function checkReviewVerdict(window: BrowserWindow): Promise<string> {
  const { approvalService } = await import("../src/services/approval-service.js");
  const { DEMO_APPROVAL_ID } = await import("../src/fixtures/demo-run.js");

  const gravado = async () =>
    ((await approvalService.get(DEMO_APPROVAL_ID))?.payload as { verdict?: string } | null)?.verdict ??
    "COMMENT";

  await irPara(window, "inbox", DEMO_APPROVAL_ID);
  const visto = await esperarProbe<{ valor: string; opcoes: string }>(
    window,
    "veredito",
    `(() => {
      const campo = document.querySelector("[data-locum-veredito]");
      if (campo === null) return null;
      return { valor: campo.value, opcoes: [...campo.options].map((o) => o.value).join(",") };
    })()`,
  );

  const original = await gravado();
  if (visto.valor !== original) {
    throw new Error(`a revisão mostrou o veredito ${visto.valor} e a pendência tem ${original}`);
  }
  if (visto.opcoes !== "APPROVE,COMMENT,REQUEST_CHANGES") {
    throw new Error(`a revisão ofereceu os vereditos ${visto.opcoes}`);
  }

  const trocar = async (valor: string) => {
    await window.webContents.executeJavaScript(
      `(() => {
        const campo = document.querySelector("[data-locum-veredito]");
        const definir = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
        definir.call(campo, ${JSON.stringify(valor)});
        campo.dispatchEvent(new Event("change", { bubbles: true }));
      })()`,
    );
    const limite = Date.now() + 10_000;
    while (Date.now() < limite) {
      if ((await gravado()) === valor) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`o veredito ${valor} escolhido na revisão não chegou à pendência`);
  };

  const outro = original === "APPROVE" ? "COMMENT" : "APPROVE";
  await trocar(outro);
  await trocar(original);

  const mensagem = await checkMessageReview(window);
  const documento = await checkDocumentReview(window);
  return `${original} -> ${outro} -> ${original}; ${mensagem}; ${documento}`;
}

/**
 * Tarefa para abrir num tracker na revisão: a tela mostra título e corpo
 * inteiros, sem os achados do run em que a pendência foi plantada.
 */
async function checkDocumentReview(window: BrowserWindow): Promise<string> {
  const { db, schema } = await import("../src/db/index.js");
  const { eq } = await import("drizzle-orm");
  const { DEMO_RUN_ID } = await import("../src/fixtures/demo-run.js");

  const id = "smoke-tracker-issue";
  // Texto de fixture, fora do dicionário de propósito: passa por variável.
  const titulo = "título da tarefa";
  const corpo = "## Contexto\ncorpo da tarefa";
  const carga = {
    tracker: "smoke",
    project: "PLAT",
    title: titulo,
    body: corpo,
    pullRequestUrl: "https://github.com/exemplo/loja-api/pull/482",
  };
  await db.delete(schema.approvals).where(eq(schema.approvals.id, id));
  await db.insert(schema.approvals).values({
    id,
    runId: DEMO_RUN_ID,
    stepId: `${DEMO_RUN_ID}-post`,
    kind: "tracker.create_issue",
    payload: carga,
    status: "pending",
  });

  try {
    await irPara(window, "inbox", id);
    const visto = await esperarProbe<{ titulo: boolean; corpo: string }>(
      window,
      "revisao-documento",
      `(() => {
        const probe = document.querySelector("[data-locum-probe=revisao-documento]");
        const corpo = document.querySelector("[data-locum-documento-corpo]");
        if (probe === null || corpo === null) return null;
        return { titulo: probe.textContent.includes(${JSON.stringify(carga.title)}), corpo: corpo.textContent };
      })()`,
    );
    if (!visto.titulo) throw new Error("a revisão da tarefa não mostrou o título");
    if (visto.corpo !== carga.body) throw new Error(`a revisão da tarefa mostrou o corpo "${visto.corpo}"`);
  } finally {
    await db.delete(schema.approvals).where(eq(schema.approvals.id, id));
  }

  // Resumo de canais: manchete e corpo, e a contagem no cabeçalho.
  const idDoResumo = "smoke-digest";
  const manchete = "manchete do resumo";
  const corpoDoResumo = "corpo do resumo";
  const resumo = {
    headline: manchete,
    channels: [{ channel: "C1", items: [] }],
    counts: { needs_reply: 2, info: 5, ignore: 1 },
    body: corpoDoResumo,
  };
  await db.delete(schema.approvals).where(eq(schema.approvals.id, idDoResumo));
  await db.insert(schema.approvals).values({
    id: idDoResumo,
    runId: DEMO_RUN_ID,
    stepId: `${DEMO_RUN_ID}-post`,
    kind: "digest.deliver",
    payload: resumo,
    status: "pending",
  });
  try {
    await irPara(window, "inbox", idDoResumo);
    const visto = await esperarProbe<{ manchete: boolean; contagem: boolean; corpo: string }>(
      window,
      "revisao-documento",
      `(() => {
        const probe = document.querySelector("[data-locum-probe=revisao-documento]");
        const corpo = document.querySelector("[data-locum-documento-corpo]");
        if (probe === null || corpo === null || !probe.textContent.includes(${JSON.stringify(manchete)})) return null;
        return { manchete: true, contagem: /2[^0-9]+5/.test(probe.textContent), corpo: corpo.textContent };
      })()`,
    );
    if (!visto.contagem) throw new Error("a revisão do resumo não mostrou a contagem");
    if (visto.corpo !== corpoDoResumo) throw new Error(`a revisão do resumo mostrou o corpo "${visto.corpo}"`);
  } finally {
    await db.delete(schema.approvals).where(eq(schema.approvals.id, idDoResumo));
  }
  return "tracker.create_issue e digest.deliver lidos";
}

/**
 * Resposta do Teams na revisão: a tela mostra a mensagem e o texto, e o texto
 * editado chega à pendência sem mexer no destino. A pendência é plantada no
 * run de demonstração e sai no fim, para não mudar a fila das outras
 * conferências.
 */
async function checkMessageReview(window: BrowserWindow): Promise<string> {
  const { db, schema } = await import("../src/db/index.js");
  const { eq } = await import("drizzle-orm");
  const { approvalService } = await import("../src/services/approval-service.js");
  const { DEMO_RUN_ID } = await import("../src/fixtures/demo-run.js");

  const id = "smoke-teams-reply";
  const carga = { chatId: "19:smoke", text: "texto do modelo", subject: "pode olhar o deploy?", author: "Ana", webUrl: null };
  await db.delete(schema.approvals).where(eq(schema.approvals.id, id));
  await db.insert(schema.approvals).values({
    id,
    runId: DEMO_RUN_ID,
    stepId: `${DEMO_RUN_ID}-post`,
    kind: "teams.post",
    payload: carga,
    status: "pending",
  });

  try {
    await irPara(window, "inbox", id);
    const visto = await esperarProbe<{ texto: string; assunto: boolean }>(
      window,
      "revisao-mensagem",
      `(() => {
        const probe = document.querySelector("[data-locum-probe=revisao-mensagem]");
        const campo = document.querySelector("[data-locum-mensagem-texto]");
        if (probe === null || campo === null) return null;
        return { texto: campo.value, assunto: probe.textContent.includes(${JSON.stringify(carga.subject)}) };
      })()`,
    );
    if (visto.texto !== carga.text) throw new Error(`a revisão mostrou o texto "${visto.texto}"`);
    if (!visto.assunto) throw new Error("a revisão não mostrou a mensagem a que se responde");

    await window.webContents.executeJavaScript(
      `(() => {
        const campo = document.querySelector("[data-locum-mensagem-texto]");
        const definir = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        definir.call(campo, "texto revisado");
        campo.dispatchEvent(new Event("input", { bubbles: true }));
      })()`,
    );
    const limite = Date.now() + 10_000;
    while (Date.now() < limite) {
      const gravada = (await approvalService.get(id))?.payload as typeof carga | undefined;
      if (gravada?.text === "texto revisado") {
        if (gravada.chatId !== carga.chatId) throw new Error(`a edição mudou o destino para ${gravada.chatId}`);
        return "teams.post editado";
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("o texto editado na revisão não chegou à pendência");
  } finally {
    await db.delete(schema.approvals).where(eq(schema.approvals.id, id));
  }
}

async function checkRuns(window: BrowserWindow, runId: string): Promise<string> {
  const { runService } = await import("../src/services/run-service.js");

  await irPara(window, "runs");
  const lista = await esperarProbe<{ estado: string; runs: string; total: number }>(
    window,
    "runs",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=runs]");
      if (probe === null || probe.dataset.estado !== "ready") return null;
      return { estado: probe.dataset.estado, runs: probe.dataset.runs, total: Number(probe.dataset.total) };
    })()`,
  );

  const doServico = (await runService.list({ limit: 500 })).map((r) => r.id);
  if (lista.runs !== doServico.join(",")) {
    throw new Error(`a lista mostrou ${lista.runs} e o servico devolveu ${doServico.join(",")}`);
  }
  if (!doServico.includes(runId)) {
    throw new Error(`o run plantado ${runId} nao apareceu na lista`);
  }

  // A linha so existe no DOM se a janela virtual a desenhou: lista vazia de
  // linhas com o total certo passaria pela conferencia acima.
  const desenhadas = (await window.webContents.executeJavaScript(
    `document.querySelectorAll("[data-locum-run]").length`,
  )) as number;
  if (desenhadas === 0) throw new Error("a lista de execucoes nao desenhou nenhuma linha");

  // A iniciativa visitada em checkInitiatives (example) continua a ultima
  // visitada, e o chip precisa mostrar ela mesmo fora de uma rota de iniciativa.
  const chip = (await window.webContents.executeJavaScript(
    `document.querySelector("[data-locum-probe=execucoes-initiative]")?.dataset.slug ?? null`,
  )) as string | null;
  if (chip !== "example") {
    throw new Error(`o chip de iniciativa mostrou "${chip}" e nao "example"`);
  }

  await irPara(window, "runs", runId);
  const detalhe = await esperarProbe<{ run: string; passos: number; chaves: string; achados: number }>(
    window,
    "execucao",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=execucao]");
      // Os passos e os achados sao duas leituras, e a segunda demora mais.
      // O menos um e o "ainda lendo" das duas, entao girar enquanto ele
      // aparecer e o que separa conferir o estado final de conferir o inicial.
      if (probe === null || probe.dataset.passos === "-1" || probe.dataset.achados === "-1") return null;
      return {
        run: probe.dataset.run,
        passos: Number(probe.dataset.passos),
        chaves: probe.dataset.chaves,
        achados: Number(probe.dataset.achados),
      };
    })()`,
  );

  const doBanco = await runService.get(runId);
  if (doBanco === undefined) throw new Error(`o run plantado ${runId} sumiu do banco`);

  const chaves = doBanco.spec.steps.map((p) => p.key);
  if (chaves.length !== 4) {
    throw new Error(`o agent semente passou a ter ${chaves.length} passos e o smoke espera quatro`);
  }
  if (detalhe.passos !== doBanco.steps.length) {
    throw new Error(`o detalhe mostrou ${detalhe.passos} passo(s) e o run tem ${doBanco.steps.length}`);
  }
  if (detalhe.chaves !== doBanco.steps.map((p) => p.stepKey).join(",")) {
    throw new Error(`o detalhe listou os passos ${detalhe.chaves}`);
  }

  const achados = (await runService.findings(runId)).length;
  if (detalhe.achados !== achados) {
    throw new Error(`o detalhe mostrou ${detalhe.achados} achado(s) e o servico tem ${achados}`);
  }

  const rerun = (await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll("[data-locum-rerun]")).map((b) => b.dataset.locumRerun).join(",")`,
  )) as string;
  if (rerun !== detalhe.chaves) {
    throw new Error(`os botoes de reexecutar cobrem ${rerun} e os passos sao ${detalhe.chaves}`);
  }

  const grafo = await checkGrafo(window, doBanco);

  return t("smoke.runs", {
    runs: lista.total,
    rows: desenhadas,
    steps: detalhe.passos,
    findings: detalhe.achados,
    graph: grafo,
  });
}

/**
 * Confere o grafo do run que esta aberto na janela.
 *
 * O esperado sai do `needs` do spec, e nao de uma lista escrita aqui: o que
 * precisa ser provado e que o desenho segue a dependencia declarada, e nao que
 * alguem lembrou de atualizar dois lugares ao mesmo tempo.
 *
 * O no e a aresta sao contados no DOM alem de conferidos no marcador, pelo
 * mesmo motivo da lista virtualizada: um grafo que montasse a conta certa e
 * desenhasse nada passaria pela primeira conferencia inteira.
 */
async function checkGrafo(
  window: BrowserWindow,
  run: Awaited<ReturnType<RunService["get"]>>,
): Promise<string> {
  if (run === undefined) throw new Error("o grafo foi conferido sem run");

  const chaves = run.spec.steps.map((p) => p.key);
  const esperadas = run.spec.steps.flatMap((passo) =>
    passo.needs.filter((n) => chaves.includes(n)).map((n) => `${n}->${passo.key}`),
  );
  if (esperadas.length !== 3) {
    throw new Error(`o agent semente passou a ter ${esperadas.length} arestas e o smoke espera tres`);
  }

  const visto = await esperarProbe<{
    arestas: string;
    desenhadas: number;
    estados: string;
    nos: string;
  }>(
    window,
    "grafo",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=grafo]");
      if (probe === null) return null;
      const caixas = Array.from(document.querySelectorAll("[data-locum-no]"));
      // A aresta so entra no DOM depois que o React Flow mede as caixas, que e
      // um quadro depois do no aparecer: sem esta espera a contagem sairia
      // zero com o grafo certo na tela.
      const linhas = document.querySelectorAll(".react-flow__edge").length;
      if (caixas.length === 0 || linhas === 0) return null;
      return {
        arestas: probe.dataset.arestas,
        desenhadas: linhas,
        estados: caixas.map((c) => c.dataset.locumNo + ":" + c.dataset.locumEstado).join(","),
        nos: probe.dataset.nos,
      };
    })()`,
  );

  if (visto.nos !== chaves.join(",")) {
    throw new Error(`o grafo listou os nos ${visto.nos} e o spec tem ${chaves.join(",")}`);
  }
  if (visto.arestas !== esperadas.join(",")) {
    throw new Error(`o grafo listou as arestas ${visto.arestas} e o spec pede ${esperadas.join(",")}`);
  }
  if (visto.desenhadas !== esperadas.length) {
    throw new Error(`o grafo desenhou ${visto.desenhadas} aresta(s) e o spec pede ${esperadas.length}`);
  }

  // O estado por no e o que separa "desenhou caixa" de "desenhou o run": o
  // passo pulado e o que espera aprovacao so aparecem se vierem do banco.
  const doBanco = run.steps.map((p) => `${p.stepKey}:${p.status}`).join(",");
  if (visto.estados !== doBanco) {
    throw new Error(`o grafo mostrou ${visto.estados} e o run esta em ${doBanco}`);
  }
  for (const exigido of ["skipped", "awaiting_approval"]) {
    if (!visto.estados.includes(`:${exigido}`)) {
      throw new Error(`o grafo do fixture nao mostrou nenhum passo ${exigido}`);
    }
  }

  return t("smoke.graph", {
    nodes: chaves.length,
    edges: visto.desenhadas,
    states: visto.estados,
  });
}

/**
 * Gira ate o marcador responder com algo que nao seja nulo.
 *
 * O limite entra por parametro porque nem toda espera e da mesma natureza:
 * uma leitura de banco responde em milissegundos, e um teste de conexao MCP
 * sobe um processo antes de responder.
 */
async function esperarProbe<T>(
  window: BrowserWindow,
  nome: string,
  script: string,
  limiteMs = 20_000,
): Promise<T> {
  const limite = Date.now() + limiteMs;

  while (Date.now() < limite) {
    const visto = (await window.webContents.executeJavaScript(script)) as T | null;
    if (visto !== null) return visto;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`o marcador ${nome} nao ficou pronto dentro de ${limiteMs / 1000}s`);
}

type Dicionario = typeof en;

/**
 * O texto que o dicionário tem para uma chave, lido do arquivo.
 *
 * O exame não pergunta pelo mesmo `t` que monta a bandeja e a notificação: duas
 * chamadas à mesma porta concordariam entre si até com o dicionário vazio. Aqui
 * o JSON é lido direto, e o que está sendo comparado é o texto que o tradutor
 * escreveu com o que apareceu no menu.
 *
 * A forma de plural sai do `Intl.PluralRules`, que é o que o i18next usa do
 * outro lado. Reimplementar a regra, ainda que com um `if`, faria o exame
 * concordar consigo mesmo: em português a forma "one" cobre o zero, e um exame
 * que não soubesse disso passaria a exigir o texto errado. O `_zero` é a
 * exceção que o próprio i18next abre para contagem zero, e vem antes das formas.
 */
type Vars = Record<string, string | number>;

function doDicionario(
  dicionario: Dicionario,
  idioma: string,
  caminho: string,
  vars: Vars = {},
): string {
  const partes = caminho.split(".");
  const folha = partes.pop() ?? "";
  let no: unknown = dicionario;
  for (const parte of partes) no = (no as Record<string, unknown>)[parte];
  const formas = no as Record<string, string | undefined>;

  const count = vars["count"];
  const chaves =
    typeof count === "number"
      ? [
          ...(count === 0 ? [`${folha}_zero`] : []),
          `${folha}_${new Intl.PluralRules(idioma).select(count)}`,
          `${folha}_other`,
        ]
      : [folha];

  const modelo = chaves.map((chave) => formas[chave]).find((texto) => texto !== undefined);
  if (modelo === undefined) throw new Error(`o dicionario ${idioma} nao tem ${caminho}`);

  return Object.entries(vars).reduce(
    (texto, [nome, valor]) => texto.replaceAll(`{{${nome}}}`, String(valor)),
    modelo,
  );
}

interface IdiomaVisto {
  idioma: string;
  documento: string;
  preferencia: string;
  estrito: string;
  rodape: string;
  runs: number;
}

/** O texto que cada tela desenhou, com o que ela contou. */
interface TelasVistas {
  inbox: string;
  pendencias: number;
  execucoes: string;
  total: number;
  agents: string;
  quantosAgents: number;
  orcamento: string;
  execucoesDeHoje: number;
  gastoDeHoje: string;
}

/**
 * O que a janela aplicou de idioma, junto do rodapé que ela desenhou.
 *
 * O rodapé entra porque atributo de marcador prova que o estado chegou, e não
 * que o texto mudou: uma tradução esquecida deixaria o marcador em `pt-BR` com
 * a tela inteira em inglês. O exame espera as leituras terminarem antes de
 * olhar, senão pegaria o texto de "carregando" em vez do plural.
 */
async function lerIdioma(window: BrowserWindow): Promise<IdiomaVisto> {
  return esperarProbe<IdiomaVisto>(
    window,
    "idioma",
    `(() => {
      const idioma = document.querySelector("[data-locum-probe=idioma]");
      const ponte = document.querySelector("[data-locum-probe=ponte]");
      if (idioma === null || ponte === null) return null;
      if (ponte.dataset.estado !== "pronto") return null;
      return {
        idioma: idioma.dataset.idioma,
        documento: document.documentElement.lang,
        preferencia: idioma.dataset.preferencia,
        estrito: idioma.dataset.estrito,
        rodape: (ponte.textContent ?? "").trim(),
        runs: Number(ponte.dataset.runs),
      };
    })()`,
  );
}

/**
 * O que as quatro telas escreveram, no idioma corrente.
 *
 * Todas elas contam coisas, e contagem e onde tradução quebra primeiro: o
 * plural do português troca a palavra, e um texto montado com "(oes)" no fim
 * passaria por qualquer conferência de marcador. Por isso o exame compara a
 * frase inteira com o dicionário, e não só o número ao lado dela.
 *
 * De configuração vem a linha de gasto do dia, e não um título de seção: o
 * título sairia igual traduzido ou não numa tela onde o resto ficou em
 * inglês, e a frase com plural não sai.
 */
async function lerTelas(window: BrowserWindow): Promise<TelasVistas> {
  await irPara(window, "inbox");
  const inbox = await esperarProbe<{ texto: string; pendencias: number }>(
    window,
    "inbox",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=inbox]");
      if (probe === null) return null;
      return { texto: (probe.textContent ?? "").trim(), pendencias: Number(probe.dataset.pendencias) };
    })()`,
  );

  await irPara(window, "runs");
  const execucoes = await esperarProbe<{ texto: string; total: number }>(
    window,
    "runs",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=runs]");
      if (probe === null || probe.dataset.estado !== "ready") return null;
      return { texto: (probe.textContent ?? "").trim(), total: Number(probe.dataset.total) };
    })()`,
  );

  await irPara(window, "agents");
  const agents = await esperarProbe<{ texto: string; total: number }>(
    window,
    "agents",
    `(() => {
      const probe = document.querySelector("[data-locum-probe=agents]");
      if (probe === null || probe.dataset.estado !== "ready") return null;
      return { texto: (probe.textContent ?? "").trim(), total: Number(probe.dataset.total) };
    })()`,
  );

  // O orçamento mora no detalhe do agent desde que saiu da Configuração.
  const { agentService: agentsDoOrcamento } = await import("../src/services/agent-service.js");
  const [comOrcamento] = await agentsDoOrcamento.budgets();
  if (comOrcamento === undefined) throw new Error("nenhum agent com orçamento para ler o texto");
  await irPara(window, "agents", comOrcamento.agentId);
  const orcamento = await esperarProbe<{ texto: string; runs: number; gasto: string }>(
    window,
    "orcamento",
    `(() => {
      const linha = document.querySelector('[data-locum-orcamento="${comOrcamento.agentId}"]');
      const hoje = linha?.querySelector("[data-locum-hoje]");
      if (linha === null || hoje === undefined || hoje === null) return null;
      return {
        texto: (hoje.textContent ?? "").trim(),
        runs: Number(hoje.dataset.locumHoje),
        gasto: linha.dataset.locumGastoHoje,
      };
    })()`,
  );

  return {
    inbox: inbox.texto,
    pendencias: inbox.pendencias,
    execucoes: execucoes.texto,
    total: execucoes.total,
    agents: agents.texto,
    quantosAgents: agents.total,
    orcamento: orcamento.texto,
    execucoesDeHoje: orcamento.runs,
    gastoDeHoje: orcamento.gasto,
  };
}

/** Recarrega a página e espera ela terminar de carregar. */
async function recarregar(window: BrowserWindow): Promise<void> {
  const carregou = new Promise<void>((resolve) => {
    window.webContents.once("did-finish-load", () => resolve());
  });
  window.webContents.reload();
  await carregou;
}

/**
 * Prova que a preferência de idioma manda na janela e que o texto muda com ela.
 *
 * A troca é pedida de dentro da página, pelo mesmo canal que a tela de
 * configuração vai usar, e não por chamada direta ao serviço deste lado: o que
 * interessa saber é que o caminho inteiro funciona, da janela até `settings` e
 * de volta. A página recarrega entre uma e outra de propósito: este exame prova
 * que a preferência sobrevive a uma subida, e não que a tela troca no lugar,
 * que é o que o `checkLanguagePicker` prova logo em seguida.
 *
 * O retorno padrão é conferido no serviço, com uma etiqueta de sistema que o
 * Locum não fala: a máquina do loop está num idioma só, e esperar que ela
 * esteja em alemão para exercitar o `en` seria um exame que nunca roda.
 */
async function checkI18n(window: BrowserWindow): Promise<string> {
  const { BRIDGE_GLOBAL } = await import("./bridge-contract.js");
  const { FALLBACK_LANGUAGE, i18nService, matchLanguage } = await import(
    "../src/services/i18n-service.js"
  );

  const original = await i18nService.getPreference();
  // O canal de trocar idioma agora mexe também na instância do processo
  // principal, que é a que escreve a linha final do smoke.
  const idiomaDoPrincipal = idiomaAtual();

  async function preferir(idioma: string | null): Promise<IdiomaVisto> {
    const argumento = idioma === null ? "null" : JSON.stringify(idioma);
    await window.webContents.executeJavaScript(
      `globalThis.${BRIDGE_GLOBAL}.i18n.setPreference(${argumento}).then(() => null)`,
    );
    await recarregar(window);
    return lerIdioma(window);
  }

  /** As quatro telas conferidas contra o dicionário do idioma que está valendo. */
  async function conferirTelas(dicionario: Dicionario, idioma: string): Promise<TelasVistas> {
    const telas = await lerTelas(window);
    const cobrar = (onde: string, visto: string, caminho: string, vars: Vars): void => {
      const esperado = doDicionario(dicionario, idioma, caminho, vars);
      if (visto !== esperado) {
        throw new Error(
          `${onde} em ${idioma} escreveu "${visto}" e o dicionario pede "${esperado}"`,
        );
      }
    };

    cobrar("a inbox", telas.inbox, "inbox.waiting", { count: telas.pendencias });
    cobrar("as execucoes", telas.execucoes, "runs.count", { count: telas.total });
    cobrar("a lista de agents", telas.agents, "agents.count", { count: telas.quantosAgents });
    cobrar("o orcamento", telas.orcamento, "settings.budgets.today", {
      count: telas.execucoesDeHoje,
      spent: Number(telas.gastoDeHoje).toFixed(3),
    });
    return telas;
  }

  try {
    const portugues = await preferir("pt-BR");
    if (portugues.idioma !== "pt-BR" || portugues.documento !== "pt-BR") {
      throw new Error(
        `a preferencia pt-BR deixou a janela em ${portugues.idioma} e o documento em ${portugues.documento}`,
      );
    }
    // A guarda de chave ausente segue `isPackaged`: em desenvolvimento ela
    // estoura para o buraco aparecer, e no pacote fica desligada para quem
    // instalou nao levar uma tela quebrada por causa de uma traducao faltando.
    // Conferir os dois lados importa porque o smoke roda das duas formas, e
    // exigir sempre ligada reprovaria o `.app` por estar certo.
    const estritoEsperado = String(!app.isPackaged);
    if (portugues.estrito !== estritoEsperado) {
      throw new Error(
        `a guarda de chave ausente esta ${portugues.estrito} e neste modo devia estar ${estritoEsperado}`,
      );
    }
    const esperadoPt = doDicionario(ptBR, "pt-BR", "bridge.runs", { count: portugues.runs });
    if (!portugues.rodape.includes(esperadoPt)) {
      throw new Error(`o rodape em pt-BR ficou "${portugues.rodape}" e devia trazer "${esperadoPt}"`);
    }
    const telasPt = await conferirTelas(ptBR, "pt-BR");

    const ingles = await preferir("en");
    if (ingles.idioma !== "en" || ingles.preferencia !== "en") {
      throw new Error(`a preferencia en deixou a janela em ${ingles.idioma}`);
    }
    const esperadoEn = doDicionario(en, "en", "bridge.runs", { count: ingles.runs });
    if (!ingles.rodape.includes(esperadoEn)) {
      throw new Error(`o rodape em en ficou "${ingles.rodape}" e devia trazer "${esperadoEn}"`);
    }
    if (ingles.rodape === portugues.rodape) {
      throw new Error(`o texto nao mudou de idioma, ficou "${ingles.rodape}" nos dois`);
    }
    const telasEn = await conferirTelas(en, "en");
    // Dicionário igual nos dois idiomas passaria pelas conferências acima sem
    // ninguém ter traduzido nada. A lista de execuções é a que prova: o plural
    // do português troca a palavra, e o da inbox pode coincidir com zero item.
    if (telasEn.execucoes === telasPt.execucoes) {
      throw new Error(`a lista de execucoes ficou "${telasEn.execucoes}" nos dois idiomas`);
    }

    // Sem preferencia, quem manda e a maquina, e o exame confere contra o que o
    // servico resolve para a etiqueta que o Electron devolveu.
    const doSistema = await preferir(null);
    const daMaquina = matchLanguage(app.getLocale()) ?? FALLBACK_LANGUAGE;
    if (doSistema.preferencia !== "" || doSistema.idioma !== daMaquina) {
      throw new Error(
        `sem preferencia a janela ficou em ${doSistema.idioma} e o sistema pede ${daMaquina}`,
      );
    }

    const desconhecido = await i18nService.resolve("de-DE");
    if (desconhecido.language !== FALLBACK_LANGUAGE) {
      throw new Error(`maquina em de-DE caiu em ${desconhecido.language} e nao no idioma base`);
    }

    const escolha = await checkLanguagePicker(window);

    return t("smoke.language", {
      pt: portugues.rodape,
      en: ingles.rodape,
      system: doSistema.idioma,
      fallback: FALLBACK_LANGUAGE,
      screens: t("smoke.screens", {
        agents: telasPt.agents,
        budget: telasPt.orcamento,
        inbox: telasPt.inbox,
        runs: telasPt.execucoes,
      }),
      picker: escolha,
    });
  } finally {
    // O exame escreve em `settings`, que sobrevive a ele. Sem isto, a proxima
    // subida do Locum nesta maquina abriria no idioma da ultima verificacao.
    await i18nService.setPreference(original);
    await aplicarIdioma(idiomaDoPrincipal);
  }
}

/** O botão de devolver a escolha ao sistema, que não é código de idioma. */
const SEGUIR_O_SISTEMA = "sistema";

/**
 * Prova que a seção de idioma da configuração troca tudo com um clique.
 *
 * O clique é no botão da tela, e não numa chamada ao canal: entre os dois está
 * justamente o que esta story entrega, que é a seção existir e estar ligada ao
 * provedor de idioma. Nada recarrega entre uma escolha e outra, e a prova
 * disso é uma marca deixada no `globalThis` da página, que uma recarga apagaria.
 *
 * A bandeja entra pelos rótulos montados em memória, como no `checkMainText`:
 * o que precisa ficar provado é que o processo principal virou de idioma na
 * mesma batida, e não que existe um ícone pendurado na barra do sistema.
 */
async function checkLanguagePicker(window: BrowserWindow): Promise<string> {
  const { trayMenuLabels } = await import("./tray.js");
  const { FALLBACK_LANGUAGE, matchLanguage } = await import("../src/services/i18n-service.js");

  const dicionarios: Record<string, Dicionario> = { en, "pt-BR": ptBR };

  await irPara(window, "settings");

  const rotulos: string[] = [];
  const daBandeja: string[] = [];

  for (const idioma of ["pt-BR", "en"]) {
    const visto = await escolherIdioma(window, idioma, idioma, dicionarios);

    if (visto.preferencia !== idioma) {
      throw new Error(
        `o clique em ${idioma} gravou a preferencia como "${visto.preferencia}"`,
      );
    }
    if (idiomaAtual() !== idioma) {
      throw new Error(
        `a janela foi para ${idioma} e o processo principal ficou em ${idiomaAtual()}`,
      );
    }

    // O item de abrir, que é frase curta e sem contagem: o que está sendo
    // provado aqui é o idioma da bandeja, e a contagem já tem exame próprio.
    const abrir = trayMenuLabels()[2] ?? "";
    const esperado = doDicionario(dicionarios[idioma] as Dicionario, idioma, "tray.open");
    if (abrir !== esperado) {
      throw new Error(
        `depois do clique em ${idioma} a bandeja ficou com "${abrir}" e o dicionario pede "${esperado}"`,
      );
    }

    rotulos.push(visto.rotulo);
    daBandeja.push(abrir);
  }

  if (rotulos[0] === rotulos[1] || daBandeja[0] === daBandeja[1]) {
    throw new Error(`o clique nao mudou o texto, ficou "${rotulos.join('" e "')}"`);
  }

  // Seguir o sistema não é escolher o idioma que o sistema fala agora: a
  // preferência sai de `settings`, e a máquina volta a mandar no dia em que
  // ela mudar de idioma.
  const daMaquina = matchLanguage(app.getLocale()) ?? FALLBACK_LANGUAGE;
  const sistema = await escolherIdioma(window, SEGUIR_O_SISTEMA, daMaquina, dicionarios);
  if (sistema.preferencia !== "" || sistema.ativo !== daMaquina) {
    throw new Error(
      `seguir o sistema deixou a tela em ${sistema.ativo} com a preferencia "${sistema.preferencia}"`,
    );
  }
  if (idiomaAtual() !== daMaquina) {
    throw new Error(`seguir o sistema deixou o processo principal em ${idiomaAtual()}`);
  }

  return t("smoke.picker", {
    pt: rotulos[0] ?? "",
    en: rotulos[1] ?? "",
    tray: daBandeja.join(" / "),
  });
}

interface EscolhaVista {
  ativo: string;
  preferencia: string;
  documento: string;
  rotulo: string;
  semRecarregar: boolean;
}

/**
 * Clica num botão da seção de idioma e espera a tela assentar no novo idioma.
 *
 * A espera é pelo texto, e não pelo atributo do marcador: o estado do React
 * chega um quadro antes do `changeLanguage` terminar, e conferir o atributo
 * aprovaria uma tela que mudou de idioma por dentro sem reescrever uma palavra.
 * O rótulo de seguir o sistema serve de amostra porque é o único da seção que
 * sai do dicionário: os outros são o nome de cada idioma nele mesmo.
 *
 * A preferência gravada entra na espera junto do texto, e não numa conferência
 * depois: numa máquina que já está no idioma escolhido nada no texto muda, e o
 * exame leria o estado anterior antes de o clique chegar a `settings`.
 */
async function escolherIdioma(
  window: BrowserWindow,
  alvo: string,
  idioma: string,
  dicionarios: Record<string, Dicionario>,
): Promise<EscolhaVista> {
  const esperado = doDicionario(
    dicionarios[idioma] as Dicionario,
    idioma,
    "settings.language.system",
  );
  // Seguir o sistema apaga a preferência, e o marcador escreve string vazia
  // onde ela não existe: atributo de dado não guarda nulo.
  const preferencia = alvo === SEGUIR_O_SISTEMA ? "" : alvo;

  const seletor = `[data-locum-idioma=${JSON.stringify(alvo)}]`;

  const clicou = (await window.webContents.executeJavaScript(
    `(() => {
      // Marca que uma recarga apagaria: a troca tem que acontecer na mesma
      // página, e não numa que subiu de novo por baixo do exame.
      globalThis.__locumSemRecarregar = true;
      const botao = document.querySelector(${JSON.stringify(seletor)});
      if (botao === null) return false;
      botao.click();
      return true;
    })()`,
  )) as boolean;
  if (!clicou) throw new Error(`a secao de idioma nao tem botao para ${alvo}`);

  const visto = await esperarProbe<EscolhaVista>(
    window,
    "idioma-escolha",
    `(() => {
      const secao = document.querySelector("[data-locum-probe=idioma-escolha]");
      if (secao === null) return null;
      if (secao.dataset.locumIdiomaAtivo !== ${JSON.stringify(idioma)}) return null;
      if (secao.dataset.locumIdiomaPreferencia !== ${JSON.stringify(preferencia)}) return null;
      const sistema = secao.querySelector(${JSON.stringify(
        `[data-locum-idioma=${JSON.stringify(SEGUIR_O_SISTEMA)}]`,
      )});
      const rotulo = (sistema?.textContent ?? "").trim();
      if (rotulo !== ${JSON.stringify(esperado)}) return null;
      return {
        ativo: secao.dataset.locumIdiomaAtivo,
        preferencia: secao.dataset.locumIdiomaPreferencia,
        documento: document.documentElement.lang,
        rotulo,
        semRecarregar: globalThis.__locumSemRecarregar === true,
      };
    })()`,
  );

  if (!visto.semRecarregar) {
    throw new Error(`a troca para ${idioma} recarregou a janela em vez de trocar no lugar`);
  }
  if (visto.documento !== idioma) {
    throw new Error(`a tela foi para ${idioma} e o documento ficou marcado como ${visto.documento}`);
  }

  return visto;
}

/**
 * Prova que a bandeja e a notificação saem no idioma escolhido.
 *
 * Nada é pendurado na barra do sistema nem exibido: o menu é montado e lido em
 * memória, e a notificação nasce sem `show()`. O loop roda sem ninguém olhando,
 * e alerta na tela de quem estiver usando a máquina não é coisa que um exame
 * possa fazer.
 *
 * O esperado sai do arquivo de dicionário, e a comparação entre os dois idiomas
 * entra junto: texto igual nos dois significa tradução esquecida, que é
 * exatamente o que passa despercebido num menu que quase ninguém abre.
 */
async function checkMainText(): Promise<string> {
  const { trayMenuLabels, trayPendingCount } = await import("./tray.js");
  const { noticeText } = await import("./notify.js");
  const { promptDoSistema } = await import("./chat.js");

  const antes = idiomaAtual();
  const idiomas: [string, Dicionario][] = [
    ["pt-BR", ptBR],
    ["en", en],
  ];

  const aviso = {
    key: "critical_finding:run-smoke-texto",
    runId: "run-smoke-texto",
    kind: "critical_finding" as const,
    agentName: "pr-review",
    criticalCount: 3,
    at: 1_760_000_000,
  };

  const bandeja: string[] = [];
  const avisos: string[] = [];
  const prompts: string[] = [];

  try {
    for (const [idioma, dicionario] of idiomas) {
      await aplicarIdioma(idioma);

      // A contagem é a que a bandeja leu da fila mais cedo: o que está sendo
      // provado aqui é o idioma, e reler o banco só traria outra oportunidade
      // de a contagem mudar no meio do exame.
      const pendentes = trayPendingCount();
      const rotulos = trayMenuLabels();
      const esperados = [
        doDicionario(dicionario, idioma, "tray.pending", { count: pendentes }),
        "",
        doDicionario(dicionario, idioma, "tray.open"),
        doDicionario(dicionario, idioma, "tray.pause"),
        "",
        doDicionario(dicionario, idioma, "tray.version", { version: VERSAO }),
        doDicionario(dicionario, idioma, "menu.app.about"),
        "",
        doDicionario(dicionario, idioma, "tray.quit"),
      ];
      if (rotulos.join("|") !== esperados.join("|")) {
        throw new Error(
          `a bandeja em ${idioma} montou "${rotulos.join("|")}" e o dicionario pede "${esperados.join("|")}"`,
        );
      }

      const texto = noticeText(aviso);
      const titulo = doDicionario(dicionario, idioma, "notification.criticalFinding.title", {
        agent: aviso.agentName,
        count: aviso.criticalCount,
      });
      const corpo = doDicionario(dicionario, idioma, "notification.criticalFinding.body", {
        count: aviso.criticalCount,
      });
      if (texto.title !== titulo || texto.body !== corpo) {
        throw new Error(
          `a notificacao em ${idioma} saiu como "${texto.title}" e "${texto.body}"`,
        );
      }

      // Run que falhou sem deixar mensagem: o corpo vem do dicionario. Com
      // mensagem ele sai como veio, porque a frase e do provedor.
      const semMensagem = noticeText({ ...aviso, kind: "run_failed", criticalCount: 0 });
      const esperadoSemMensagem = doDicionario(
        dicionario,
        idioma,
        "notification.runFailed.noError",
      );
      if (semMensagem.body !== esperadoSemMensagem) {
        throw new Error(`a falha sem mensagem em ${idioma} saiu como "${semMensagem.body}"`);
      }
      const comMensagem = noticeText({ ...aviso, kind: "run_failed", error: "socket hang up" });
      if (comMensagem.body !== "socket hang up") {
        throw new Error(`o erro do provedor foi reescrito para "${comMensagem.body}"`);
      }

      // O prompt de sistema do assistente e texto de produto, e a linha que
      // manda responder num idioma e a que decide o idioma da resposta. Sem
      // isto a tela viraria de idioma e o assistente continuaria respondendo
      // no anterior.
      const prompt = promptDoSistema();
      const esperadoPrompt = doDicionario(dicionario, idioma, "assistant.system");
      if (prompt !== esperadoPrompt) {
        throw new Error(`o prompt do assistente em ${idioma} nao saiu do dicionario`);
      }

      bandeja.push(rotulos[2] ?? "");
      avisos.push(texto.title);
      prompts.push(prompt.split("\n")[1] ?? "");
    }

    if (bandeja[0] === bandeja[1] || avisos[0] === avisos[1] || prompts[0] === prompts[1]) {
      throw new Error(`o texto do processo principal nao mudou de idioma: ${bandeja.join(", ")}`);
    }
  } finally {
    // O exame trocou o idioma da instância que a bandeja e a notificação usam
    // de verdade. Sem devolver, o resto do smoke sairia no último idioma visto.
    await aplicarIdioma(antes);
  }

  return t("smoke.mainText", {
    assistant: prompts.join(" / "),
    notification: avisos.join(" / "),
    tray: bandeja.join(" / "),
  });
}

/**
 * Espera o shiki terminar e devolve quantos trechos ele coloriu.
 *
 * O destaque nao esta no HTML construido: ele acontece no navegador, depois de
 * um import dinamico do pacote da linguagem. Contar `span` com cor e o que
 * separa "o componente montou" de "o destaque funcionou": sem a gramatica o
 * shiki ainda desenha o `pre`, so que com o codigo todo na mesma cor.
 */
async function esperarDestaque(window: BrowserWindow): Promise<number> {
  const limite = Date.now() + 20_000;

  while (Date.now() < limite) {
    const coloridos = (await window.webContents.executeJavaScript(
      `(() => {
        const bloco = document.querySelector("[data-locum-probe=code-block] pre.shiki");
        if (bloco === null) return 0;
        return bloco.querySelectorAll("span[style*='color']").length;
      })()`,
    )) as number;

    if (coloridos > 0) return coloridos;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error("o bloco de codigo nao ficou destacado dentro de 20s");
}

/** Quantas pendencias a fila tem, lida direto do servico. */
async function countPending(): Promise<number> {
  const { approvalService } = await import("../src/services/approval-service.js");
  return (await approvalService.listPending()).length;
}

/**
 * Guarda ou apaga um segredo e sai, sem janela e sem bandeja.
 *
 * Enquanto nao existe interface, e o unico jeito de por uma chave no keychain,
 * porque o `safeStorage` so existe dentro do Electron. O valor entra pelo
 * stdin, nunca por argumento: argumento aparece na lista de processos.
 */
async function runSecretCommand(): Promise<void> {
  const { installSecretBackend } = await import("./safe-storage.js");
  const { secretService } = await import("../src/services/secret-service.js");

  if (!installSecretBackend()) throw new Error("keychain indisponivel para o safeStorage");

  const removeRef = flagValue("--remove-secret");
  if (removeRef !== undefined) {
    console.log(secretService.remove(removeRef) ? `${removeRef} apagado` : `${removeRef} nao existia`);
    return;
  }

  const ref = flagValue("--set-secret");
  if (ref === undefined) throw new Error("uso: --set-secret <escopo/nome>, com o valor no stdin");

  const pedacos: Buffer[] = [];
  for await (const pedaco of process.stdin) pedacos.push(pedaco as Buffer);
  const secret = Buffer.concat(pedacos).toString("utf8").trim();
  if (secret.length === 0) throw new Error("nada chegou pelo stdin");

  secretService.set(ref, secret);
  console.log(`${ref} guardado no keychain`);
}

/**
 * O servidor MCP do Locum, servido pelo próprio aplicativo.
 *
 * Pelo binário do `.app`, e não por um `node` solto, porque só o processo do
 * Locum abre o cofre: o token do GitHub e as chaves de provedor que a pessoa
 * guardou na configuração estão cifrados pelo `safeStorage`, e um processo de
 * fora enxergaria o texto cifrado sem conseguir lê-lo. É assim que quem baixa
 * o `.dmg` usa o Locum pelo Claude Code sem exportar variável nenhuma.
 *
 * Sem bandeja, janela nem agendador: o aplicativo aberto já faz esse papel, e
 * um segundo agendador dispararia cada gatilho duas vezes. O processo vive
 * enquanto o cliente mantiver o stdin aberto.
 */
async function serveMcp(): Promise<void> {
  const { installSecretBackend } = await import("./safe-storage.js");
  if (!installSecretBackend()) console.error("keychain indisponivel, credenciais vem so do ambiente");

  const { providerService } = await import("../src/services/provider-service.js");
  await providerService.loadSecrets();

  const { closeMcpPool } = await import("../src/executor/build.js");
  const { buildMcpServer } = await import("../src/mcp-server/server.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

  const sair = (): void => {
    void closeMcpPool()
      .catch(() => undefined)
      .finally(() => app.exit(0));
  };
  process.stdin.on("end", sair);
  process.stdin.on("close", sair);

  const server = buildMcpServer();
  await server.connect(new StdioServerTransport());
  console.error("servidor MCP do locum no ar, pelo aplicativo");
}

/**
 * Poe o processo principal no idioma de quem esta na maquina.
 *
 * Qual idioma vale sai do mesmo servico que responde a janela, entao a bandeja
 * e a tela nunca discordam; o que a casca traz e so a etiqueta do sistema, que
 * e a unica parte que depende do Electron. Fora de app empacotado, chave
 * ausente estoura, como na janela: texto cru num menu da barra do sistema passa
 * despercebido por semanas.
 */
/**
 * Cria ou atualiza o esquema antes de qualquer serviço tocar o banco.
 *
 * Primeira coisa da subida, antes até do idioma: o dicionário sai de
 * `settings`, que é tabela, e numa máquina onde o Locum acabou de ser
 * instalado não existe tabela nenhuma. O `drizzle-kit push` que criava o
 * esquema é ferramenta de desenvolvimento e não viaja no pacote.
 *
 * A pasta vem por caminho explícito porque o migrator lê os `.sql` do disco:
 * o build copia `drizzle/` para junto do `main.cjs`, e é de lá que ela sai
 * tanto rodando por `npx electron dist/main.cjs` quanto empacotada.
 */
async function migrarEsquema(): Promise<import("../src/db/migrate.js").ResultadoDaMigracao> {
  const { migrateDb } = await import("../src/db/migrate.js");
  return migrateDb(join(__dirname, "drizzle"));
}

async function setupI18n(): Promise<string> {
  const { i18nService } = await import("../src/services/i18n-service.js");
  const { language } = await i18nService.resolve(app.getLocale());
  iniciarI18n({ idioma: language, estrito: !app.isPackaged });
  return language;
}

/**
 * Fotografa cada destino, para que a interface possa ser olhada e não só
 * descrita por linha de log.
 *
 * Nasceu de uma pergunta constrangedora: as telas foram construídas por
 * verificação automática, e ninguém tinha visto nenhuma delas. Critério
 * funcional não enxerga hierarquia, ritmo nem estado vazio.
 */
async function capturarTelas(janela: BrowserWindow): Promise<void> {
  const destino = flagValue("--capturas-em") ?? join(process.cwd(), "capturas");
  mkdirSync(destino, { recursive: true });
  janela.setSize(1280, 860);

  // O detalhe de execução e o assistente também entram: eles são metade do
  // aplicativo e não apareciam em captura nenhuma, que é como a lista de
  // execuções passou dias mostrando carimbo de máquina sem ninguém ver.
  // Importado aqui e não no topo: o módulo nativo do SQLite só carrega depois
  // que o processo aponta o binding compilado para o Electron, e um import de
  // topo puxaria o banco antes disso.
  const { runService } = await import("../src/services/run-service.js");
  const primeiroRun = (await runService.list({ limit: 1 }))[0]?.id;
  const primeiroAgent = (await (await import("../src/services/agent-service.js")).agentService.list())[0]?.id;

  const { approvalService } = await import("../src/services/approval-service.js");
  const primeiraPendencia = (await approvalService.listPending())[0]?.id;
  const { initiativeService } = await import("../src/services/initiative-service.js");
  const primeiraIniciativa = (await initiativeService.list())[0]?.slug;

  const destinos: [string, string | undefined][] = [
    ["today", undefined],
    ["inbox", undefined],
    ["inbox", primeiraPendencia],
    ["runs", undefined],
    ["runs", primeiroRun],
    ["agents", undefined],
    ["agents", primeiroAgent],
    ["initiatives", undefined],
    ["initiatives", primeiraIniciativa],
    ["sessions", undefined],
    // Uma foto por seção, com o nome dela: a Configuração tem três.
    ["settings", "general"],
    ["settings", "models"],
    ["settings", "connections"],
  ];

  for (const [id, detalhe] of destinos) {
    await irPara(janela, id, detalhe);
    // A tela pede dado pela ponte ao montar, e fotografar antes da resposta
    // registraria o esqueleto em vez do conteúdo.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const imagem = await janela.webContents.capturePage();
    const sufixo = detalhe === undefined ? "" : id === "settings" ? `-${detalhe}` : "-detalhe";
    writeFileSync(join(destino, `${id}${sufixo}.png`), imagem.toPNG());
  }

  // O que vigia e quanto gasta ficam abaixo dos passos, fora da primeira foto.
  if (primeiroAgent) {
    await irPara(janela, "agents", primeiroAgent);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await janela.webContents.executeJavaScript(
      `(document.querySelector("[data-locum-probe=observados]")?.scrollIntoView({ block: "start" }), null)`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    writeFileSync(join(destino, "agents-vigia.png"), (await janela.webContents.capturePage()).toPNG());
  }

  // O editor abre por clique, então a captura clica.
  if (primeiroAgent) {
    await irPara(janela, "agents", primeiroAgent);
    await janela.webContents.executeJavaScript(
      `(document.querySelector("[data-locum-editar]")?.click(), null)`,
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    writeFileSync(join(destino, "agents-editor.png"), (await janela.webContents.capturePage()).toPNG());
  }

  // Resposta de Slack ou Teams não existe no exemplo; uma do Teams entra só
  // para a foto, na fila e na revisão, e sai em seguida.
  {
    const { db, schema } = await import("../src/db/index.js");
    const { eq } = await import("drizzle-orm");
    const { DEMO_RUN_ID } = await import("../src/fixtures/demo-run.js");
    const id = "captura-teams-reply";
    await db.insert(schema.approvals).values({
      id,
      runId: DEMO_RUN_ID,
      stepId: `${DEMO_RUN_ID}-post`,
      kind: "teams.post",
      payload: {
        chatId: "19:captura",
        text: "Olhei o deploy de ontem: a falha veio do timeout do gateway, já subi o ajuste e acompanho até o fim do dia.",
        subject: "Alguém sabe por que o deploy da API de pedidos falhou ontem à noite?",
        author: "Ana Souza",
        webUrl: null,
        channel: { teamId: "t", channelId: "deploys", threadId: "m", label: null },
      },
      status: "pending",
    });
    try {
      await irPara(janela, "inbox");
      await new Promise((resolve) => setTimeout(resolve, 1200));
      writeFileSync(join(destino, "inbox-mensagem.png"), (await janela.webContents.capturePage()).toPNG());
      await irPara(janela, "inbox", id);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      writeFileSync(join(destino, "inbox-mensagem-detalhe.png"), (await janela.webContents.capturePage()).toPNG());
    } finally {
      await db.delete(schema.approvals).where(eq(schema.approvals.id, id));
    }
  }

  // Tarefa para o tracker, idem: só para a foto da revisão.
  {
    const { db, schema } = await import("../src/db/index.js");
    const { eq } = await import("drizzle-orm");
    const { DEMO_RUN_ID } = await import("../src/fixtures/demo-run.js");
    const id = "captura-tracker-issue";
    const titulo = "Retentativa sem limite no cliente do gateway";
    const corpo =
      "## Contexto\nO PR #482 adiciona retentativa sem teto no cliente HTTP do gateway.\n\n## O que fazer\n- limitar a três tentativas\n- registrar a última falha";
    await db.insert(schema.approvals).values({
      id,
      runId: DEMO_RUN_ID,
      stepId: `${DEMO_RUN_ID}-post`,
      kind: "tracker.create_issue",
      payload: {
        tracker: "exemplo",
        project: "PLAT",
        title: titulo,
        body: corpo,
        pullRequestUrl: "https://github.com/exemplo/loja-api/pull/482",
      },
      status: "pending",
    });
    try {
      await irPara(janela, "inbox", id);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      writeFileSync(join(destino, "inbox-tarefa-detalhe.png"), (await janela.webContents.capturePage()).toPNG());
    } finally {
      await db.delete(schema.approvals).where(eq(schema.approvals.id, id));
    }
  }

  // O painel do assistente abre por atalho, então a captura usa o mesmo caminho.
  await irPara(janela, "inbox");
  await janela.webContents.executeJavaScript(
    `(() => {
      const evento = new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true });
      globalThis.dispatchEvent(evento);
      return null;
    })()`,
  );
  await new Promise((resolve) => setTimeout(resolve, 600));
  writeFileSync(join(destino, "assistente.png"), (await janela.webContents.capturePage()).toPNG());

  console.log(`capturas em ${destino}`);
}

async function main(): Promise<void> {
  await app.whenReady();
  // Servidor MCP não tem janela nem ícone no dock: quem o abre é o Claude Code,
  // a cada sessão, e um ícone pulando a cada sessão nova seria ruído.
  if (modoMcp) app.dock?.hide();

  // Antes de tudo que lê o banco, inclusive do idioma, que mora em `settings`.
  const esquema = await migrarEsquema();

  // Antes de qualquer texto: bandeja, notificacao e o proprio smoke falam pelo
  // dicionario, e pedir chave antes disso estoura de proposito.
  await setupI18n();

  if (esquema.criado) console.log(t("schema.created", { count: esquema.disponiveis }));
  else if (esquema.adotado) console.log(t("schema.adopted", { count: esquema.disponiveis }));

  if (flagValue("--set-secret") !== undefined || flagValue("--remove-secret") !== undefined) {
    await runSecretCommand();
    app.exit(0);
    return;
  }

  // Como este Locum sobe como servidor MCP, para a tela poder cadastrá-lo no
  // Claude Code. Empacotado, o binário do `.app` basta; rodando por `electron dist/main.cjs`,
  // o Electron precisa saber qual script abrir.
  const { claudeCodeService } = await import("../src/services/claude-code-service.js");
  claudeCodeService.useLauncher({
    command: process.execPath,
    args: app.isPackaged ? [] : [join(__dirname, "main.cjs")],
  });

  // Conexão por OAuth abre o navegador padrão para a pessoa autorizar, e todo
  // uso de servidor MCP renova antes o token que estiver perto de vencer. Vale
  // também no modo MCP, que usa os mesmos servidores pelo Claude Code.
  const { mcpOAuthService } = await import("../src/services/mcp-oauth-service.js");
  const { mcpService } = await import("../src/services/mcp-service.js");
  mcpOAuthService.useBrowser((url) => shell.openExternal(url));
  mcpService.useRefresher((name) => mcpOAuthService.refreshIfNeeded(name));

  if (modoMcp) {
    await serveMcp();
    return;
  }

  // Achar o `claude` abre um shell de login, que leva segundos. Começar agora
  // faz a primeira visita à vitrine de conexões encontrar a resposta pronta.
  void import("../src/runtimes/claude-binary.js").then(({ claudeBinary }) => claudeBinary());

  // O nucleo abre o banco no import, entao tudo que fala com ele entra por
  // import dinamico, depois da variavel de ambiente do binding.
  const { setupTray, teardownTray, trayPendingCount } = await import("./tray.js");

  // O pool de servidores MCP vive entre execuções, então quem fecha os
  // processos é a saída do aplicativo. O `app.exit` da fumaça pula o
  // `will-quit`, e por isso ela fecha o pool na mão antes de sair.
  const { closeMcpPool } = await import("../src/executor/build.js");
  let poolFechado = false;
  app.on("will-quit", (event) => {
    if (poolFechado) return;
    event.preventDefault();
    // Batida nova no meio da saída abriria servidor MCP depois do pool fechado.
    void import("./power.js").then(({ teardownPower }) => teardownPower());
    void closeMcpPool()
      .catch(() => undefined)
      .finally(() => {
        poolFechado = true;
        // `exit`, e não um segundo `quit`: com o `will-quit` já cancelado uma
        // vez, o Electron ignora o `quit` seguinte e o processo fica de pé sem
        // janela, sem bandeja respondendo e sem sair.
        app.exit(0);
      });
  });

  if (smoke) {
    // Sem dock e sem janela: o loop de verificacao roda sem ninguem olhando, e
    // uma janela aberta travaria a iteracao esperando um clique. A bandeja
    // continua valendo, porque ela nao pede clique de ninguem para existir.
    app.dock?.hide();
    // A pasta de rascunho nasce vazia, e boa parte da bateria parte do agent
    // semente. Numa pasta que já o tem, `upsert` com o mesmo spec não grava nada.
    const { agentService } = await import("../src/services/agent-service.js");
    const { prReviewSpec } = await import("../src/examples/agents.js");
    await agentService.upsert(prReviewSpec, "seed", "human");
    const agents = await checkCore();
    const schema = t("smoke.schema", { count: esquema.disponiveis });

    const loginItem = await checkLoginItem();

    const tray = await setupTray({ openWindow: showWindow });
    const { appMenuLabels, setupAppMenu } = await import("./menu.js");
    setupAppMenu({ janela: ensureWindow });
    const menu = appMenuLabels();
    const esperado = ["Locum", t("menu.edit.title"), t("menu.view.title"), t("menu.window.title"), t("menu.help.title")];
    if (menu.join("|") !== esperado.join("|")) {
      throw new Error(`o menu da aplicação saiu com ${menu.join(", ")} e o dicionário pede ${esperado.join(", ")}`);
    }
    const pending = await countPending();
    if (tray.isDestroyed()) throw new Error("bandeja nao sobreviveu a criacao");
    if (trayPendingCount() !== pending) {
      throw new Error(
        `bandeja marca ${trayPendingCount()} pendencia(s) e a fila tem ${pending}`,
      );
    }
    const mainText = await checkMainText();
    teardownTray();

    const power = await checkPower();
    const updates = await checkUpdates();
    const secrets = await checkSecrets();
    const avisos = await checkNotifications();
    const conferencia = await checkReconcile();
    const autoria = await checkAuthorship();
    const varreduraMcp = await checkMcpPoll();
    const slack = await checkSlack();
    const digest = await checkDigest();
    const respostaNoSlack = await checkSlackPost();
    const tarefa = await checkTrackerIssue();
    const deepLink = await checkDeepLink();
    const ponte = await checkBridge();
    const renderer = await checkRenderer();

    console.log(
      t("smoke.ok", {
        agents,
        schema,
        pending,
        loginItem,
        power,
        updates,
        secrets,
        notifications: avisos,
        reconcile: conferencia,
        authorship: autoria,
        mcpPoll: varreduraMcp,
        slack,
        digest,
        slackPost: respostaNoSlack,
        trackerIssue: tarefa,
        deepLink,
        bridge: ponte,
        renderer,
        mainText,
      }),
    );
    await closeMcpPool();
    app.exit(0);
    return;
  }

  // Antes da bandeja e do agendador: qualquer coisa que monte executor precisa
  // do cofre ja ligado para achar a credencial no keychain.
  const { installSecretBackend } = await import("./safe-storage.js");
  if (!installSecretBackend()) {
    console.log("keychain indisponivel, credenciais vem so do ambiente");
  }

  // Logo depois do cofre, e nao so quando um executor for montado: a tela de
  // configuracao pergunta a disponibilidade dos provedores assim que abre, e
  // sem isto quem guardou a chave pelo app apareceria como indisponivel ate a
  // primeira execucao reconstruir o registro.
  const { providerService } = await import("../src/services/provider-service.js");
  const doCofre = await providerService.loadSecrets();
  if (doCofre.length > 0) console.log(`cofre: chave de ${doCofre.join(", ")}`);

  // Depois do cofre, porque o retorno de OAuth guarda token, e antes da janela,
  // para que a URL que subiu o app nao fique esperando na fila.
  const { registerProtocol, setupDeepLink } = await import("./deep-link.js");
  const protocolo = await registerProtocol();
  if (!protocolo.registered) {
    console.log("deep link: o sistema nao deu o esquema locum:// ao Locum, ver docs/estado-atual.md");
  }
  const esperando = setupDeepLink(handleDeepLink);
  if (esperando > 0) console.log(`deep link: ${esperando} url(s) esperavam desde a subida`);

  const { applyPreference } = await import("./login-item.js");
  const startup = await applyPreference();
  if (startup.preference !== null) {
    console.log(
      t("loginItem.applied", { preference: startup.preference, status: startup.status }),
    );
  }

  await setupTray({ openWindow: showWindow });

  const { setupAppMenu } = await import("./menu.js");
  setupAppMenu({ janela: ensureWindow });

  const { setupNotifications } = await import("./notify.js");
  const jaNaFila = await setupNotifications({ openInbox });
  if (jaNaFila > 0) console.log(`notificacao: ${jaNaFila} aviso(s) ja na fila, nenhum exibido`);

  const { setupClock, setupPower } = await import("./power.js");
  setupPower();
  setupClock();

  // Depois de tudo que o Locum precisa para funcionar: atualizar é o único
  // passo da subida que fala com a internet, e ele não pode atrasar a bandeja
  // nem a janela. Desligado, que é o padrão, não custa nada.
  const { setupUpdater } = await import("./updater.js");
  const atualizacao = await setupUpdater();
  if (atualizacao.armed) console.log(`atualização: ${atualizacao.current}, conferindo o GitHub ao abrir e a cada 6h`);
  else console.log(`atualização: parada (${atualizacao.reason}${atualizacao.detail ? `: ${atualizacao.detail}` : ""})`);

  // Antes da janela: o preload chama os canais assim que o documento carrega, e
  // canal ainda nao registrado volta como erro de IPC para o renderer.
  const { setupBridge } = await import("./bridge.js");
  setupBridge({ inboxTarget: pendingInboxTarget });

  await ensureWindow();

  app.on("activate", showWindow);
}

app.on("window-all-closed", () => {
  // No macOS o padrao e o app seguir vivo sem janela, e o Locum depende disso:
  // ele existe para vigiar em segundo plano.
  if (process.platform !== "darwin") app.quit();
});

main().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
