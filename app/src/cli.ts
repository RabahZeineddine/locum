import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateDb } from "./db/migrate.js";
import { McpTransport } from "./config/types.js";
import { buildExecutor, closeMcpPool } from "./executor/build.js";
import { agentService } from "./services/agent-service.js";
import { approvalService } from "./services/approval-service.js";
import { credentialService } from "./services/credential-service.js";
import { executionService } from "./services/execution-service.js";
import { machineId } from "./services/machine-service.js";
import { metricsService, type VersionMetrics } from "./services/metrics-service.js";
import { mcpService } from "./services/mcp-service.js";
import { providerService } from "./services/provider-service.js";
import { reconcileService } from "./services/reconcile-service.js";
import { runService, type RunSummary } from "./services/run-service.js";
import { secretService } from "./services/secret-service.js";
import { startupService } from "./services/startup-service.js";
import { updateService } from "./services/update-service.js";
import { triggerService } from "./services/trigger-service.js";
import { collectSlackDigest, buildDigestEvent } from "./digest/ingest.js";
import { slackService } from "./services/slack-service.js";
import { pollOpenPullRequests } from "./sources/github.js";
import { scheduler, type TickResult } from "./triggers/scheduler.js";

/**
 * Grava um agent de um arquivo JSON. O Locum não traz agent de fábrica, então
 * é por aqui (ou pela tela Agents) que o primeiro entra. Os de
 * `examples/agents/` servem de ponto de partida.
 */
async function importAgent(caminho: string): Promise<void> {
  const { version, created } = await agentService.importSpec(readFileSync(caminho, "utf8"), basename(caminho));
  console.log(`${version.agentId} v${version.version} ${created ? "criado" : "atualizado"} (${version.id})`);
}

/** Escreve o spec mais recente em arquivo, ou na saída quando não há caminho. */
async function exportAgent(agentId: string, caminho?: string): Promise<void> {
  const texto = await agentService.exportSpec(agentId);
  if (caminho === undefined) process.stdout.write(texto);
  else {
    writeFileSync(caminho, texto);
    console.log(`${agentId} exportado para ${caminho}`);
  }
}

/** Separa `--agent <id>` do resto dos argumentos. */
function opcaoAgent(args: string[]): { agentId?: string; resto: string[] } {
  const i = args.indexOf("--agent");
  if (i < 0) return { resto: args };
  const agentId = args[i + 1];
  if (!agentId) throw new Error("--agent pede o id do agent");
  return { agentId, resto: [...args.slice(0, i), ...args.slice(i + 2)] };
}

/** Roda o pipeline num alvo, real ou sintetico, e imprime o resultado. */
async function start(target: string, agentId?: string): Promise<void> {
  const started = await executionService.start({ target, agentId });
  console.log(`run ${started.runId} (${started.source} ${started.repo}#${started.pull})`);

  await printRun(started.runId);
  console.log(`\nstatus: ${started.status}`);
}

/**
 * Junta o que chegou no Slack desde a ultima entrega e roda o agent de digest.
 *
 * A regra de agrupar, filtrar e mover o cursor mora na ingestao, e a de
 * classificar mora no agent: aqui so se amarram as duas, porque a tela e o
 * agendador vao amarrar as mesmas duas.
 */
async function digest(agentId: string): Promise<void> {
  const watch = await slackService.get();
  if (watch.server === null) {
    throw new Error("nenhum servidor de Slack cadastrado nesta maquina");
  }

  const bundle = await collectSlackDigest(watch.server);
  const eventId = await buildDigestEvent(bundle);
  if (eventId === null) {
    console.log(`nada novo no Slack desde ${bundle.since}`);
    return;
  }
  console.log(
    `${bundle.messages} mensagem(ns) em ${bundle.channels.length} canal(is),` +
      ` ${bundle.dropped} descartada(s), janela ate ${bundle.until}`,
  );

  // O agent é o que a pessoa importou, e não o exemplo: regravar o exemplo a
  // cada digest desfaria qualquer edição feita nele.
  const version = await agentService.getLatestVersion(agentId);
  if (!version) throw new Error(`agent "${agentId}" não existe; importe um, por exemplo examples/agents/slack-digest.json`);
  const executor = await buildExecutor();
  const runId = await executor.createRun(version.id, eventId);
  const status = await executor.execute(runId);

  await printRun(runId);
  console.log(`\nstatus: ${status}`);
}

async function printRun(runId: string): Promise<void> {
  const run = await runService.get(runId);
  if (!run) throw new Error(`run ${runId} nao encontrado`);

  console.log("");
  for (const s of run.steps) {
    const model = s.modelUsed ?? "acao";
    const sub = s.substitutionReason ? ` (substituido)` : "";
    const secs = s.startedAt && s.endedAt ? `${s.endedAt - s.startedAt}s` : "-";
    console.log(
      ` ${String(s.idx + 1).padStart(2)}  ${s.name.padEnd(22)} ${s.status.padEnd(18)} ${model}${sub}  ${secs}  ${s.costUsd.toFixed(3)}`,
    );
    if (s.error) console.log(`     erro: ${s.error}`);
  }
  console.log(
    `\ncusto do run: ${run.costUsd.toFixed(3)} USD cobrado` +
      ` \u00b7 ${run.estimateUsd.toFixed(3)} USD equivalente (assinatura nao cobra)`,
  );
  if (run.error) console.log(`motivo da parada: ${run.error}`);

  const findings = await runService.findings(runId);
  if (findings.length > 0) {
    console.log(`\nachados (${findings.length}):`);
    for (const f of findings) {
      console.log(` [${f.severity}] ${f.file ?? "geral"}${f.line ? `:${f.line}` : ""}  ${f.problem}`);
    }
  }
}

/** Ultimas execucoes, opcionalmente so as de um status. */
async function runs(status?: string): Promise<void> {
  const rows = await runService.list(status ? { status } : {});
  if (rows.length === 0) {
    console.log(status ? `nenhum run com status ${status}` : "nenhum run registrado");
    return;
  }
  for (const r of rows) console.log(formatRun(r));
}

function formatRun(run: RunSummary): string {
  const quando = new Date(run.createdAt * 1000).toISOString().slice(0, 16).replace("T", " ");
  const agent = `${run.agentId} v${run.agentVersion}`;
  return `${run.id}  ${quando}  ${agent.padEnd(20)} ${run.status.padEnd(10)} ${run.costUsd.toFixed(3)} USD`;
}

/**
 * O que roda nesta maquina, a tabela de substituicao e onde cada modelo pedido
 * pelos agents cadastrados cairia hoje.
 */
async function providers(): Promise<void> {
  for (const p of providerService.listProviders()) {
    const via = p.subscription ? "assinatura" : "api";
    const motivo = p.available
      ? ""
      : p.requires.length > 0
        ? `faltam ${p.requires.join(", ")}`
        : "binario claude ausente ou sessao expirada";
    console.log(` ${p.available ? " " : "-"} ${p.name.padEnd(12)} ${via.padEnd(10)} ${motivo}`);
  }

  const fallbacks = await providerService.getFallbacks(machineId);
  console.log(`\nsubstituicoes de ${machineId}:`);
  if (fallbacks.length === 0) console.log("  nenhuma");
  for (const f of fallbacks) console.log(`  ${f.fromModel} -> ${f.toModel} (ordem ${f.order})`);

  // Os modelos que os agents cadastrados pedem, de todos eles: sem agent de
  // fábrica, o que interessa é onde os passos desta máquina cairiam hoje.
  const modelos = new Set<string>();
  for (const agent of await agentService.list()) {
    const versao = await agentService.getLatestVersion(agent.id);
    for (const passo of versao?.spec.steps ?? []) if (passo.type === "model") modelos.add(passo.model);
  }
  console.log("\nmodelos pedidos pelos agents:");
  if (modelos.size === 0) console.log("  nenhum agent cadastrado");
  for (const modelo of modelos) {
    const preview = await providerService.resolvePreview(modelo, machineId);
    console.log(
      preview.ok
        ? `  ${modelo} -> ${preview.resolution.used}${preview.resolution.substitutionReason ? " (substituido)" : ""}`
        : `  ${modelo} -> sem saida: ${preview.error}`,
    );
  }
}

/** Cruza o review humano com os achados do run e imprime o gabarito. */
async function reconcile(runId: string, force: boolean): Promise<void> {
  const report = await reconcileService.reconcileRun(runId, { force });
  console.log(`${report.prKey}  ${report.state}`);
  if (report.skipped) {
    console.log(`nada gravado: ${report.skipped}`);
    return;
  }
  console.log(`${report.findingCount} achado(s), ${report.signalCount} sinal(is) humano(s)`);
  for (const [estado, quantos] of Object.entries(report.outcomes)) {
    if (quantos > 0) console.log(`  ${estado.padEnd(20)} ${quantos}`);
  }
  console.log(`  ${"nao visto pelo agent".padEnd(20)} ${report.unmatchedSignals}`);
}

/**
 * Recalcula as janelas a partir do gabarito e imprime precisao por versao.
 *
 * Agrega antes de imprimir porque a tabela e derivada: sem recalcular, o
 * numero na tela seria o da ultima vez que alguem rodou isto.
 */
async function metrics(agentId?: string): Promise<void> {
  const versions = await metricsService.aggregate(agentId ? { agentId } : {});
  if (versions.length === 0) {
    console.log("nenhuma janela medida: rode reconcile para gravar os desfechos");
  }
  for (const v of versions) console.log(formatVersion(v));

  const usage = await metricsService.usage(agentId ? { agentId, days: 7 } : { days: 7 });
  if (usage.length > 0) {
    console.log("\ngasto dos ultimos 7 dias:");
    for (const u of usage) {
      console.log(`  ${u.day}  ${u.agentId.padEnd(20)} ${u.costUsd.toFixed(3)} USD  ${u.runs} run(s)`);
    }
  }
}

function formatVersion(v: VersionMetrics): string {
  const janela = [v.windowStart, v.windowEnd]
    .map((t) => new Date(t * 1000).toISOString().slice(0, 10))
    .join(" a ");
  const skills = v.skillSet.length > 0 ? v.skillSet.map((s) => s.name).join("+") : "sem skill";
  return (
    `${v.agentId} v${v.version}`.padEnd(22) +
    ` ${janela}  ${String(v.findingCount).padStart(3)} achado(s)` +
    `  precisao ${pct(v.precision)}  concordancia ${pct(v.agreement)}` +
    `  ${String(v.missed).padStart(3)} nao visto(s)  ${skills}`
  );
}

/** Sem desfecho que sustente a fracao, mostrar zero mentiria. */
function pct(value: number | null): string {
  return value === null ? "  n/d" : `${(value * 100).toFixed(0).padStart(3)}%`;
}

async function inbox(): Promise<void> {
  const rows = await approvalService.listPending();
  const paradas = await approvalService.listStuck();
  for (const r of paradas) {
    console.log(`${r.id}  ${r.kind}  PAROU NA PUBLICACAO  run ${r.runId}`);
    console.log(`   confira o destino e rode stuck:published ${r.id} ou stuck:retry ${r.id}`);
  }
  if (rows.length === 0) {
    if (paradas.length === 0) console.log("nada pendente");
    return;
  }
  for (const r of rows) {
    console.log(`${r.id}  ${r.kind}  ${r.agentId} v${r.agentVersion} / ${r.stepName}  run ${r.runId}`);
    console.log(`   ${JSON.stringify(r.payload).slice(0, 200)}`);
  }
}

/** Lista os servidores cadastrados, marcando os que estao desligados. */
async function mcpList(): Promise<void> {
  const entries = await mcpService.list();
  if (entries.length === 0) {
    console.log("nenhum servidor MCP cadastrado");
    return;
  }
  for (const { config, enabled } of entries) {
    const alvo = config.transport === "stdio" ? config.command!.join(" ") : config.url!;
    console.log(
      `${enabled ? " " : "-"} ${config.name.padEnd(20)} ${config.transport.padEnd(6)} ${config.scope.padEnd(5)} ${alvo}`,
    );
  }
}

/** Catalogo do servidor, com o peso de cada ferramenta no contexto. */
async function mcpTools(name: string): Promise<void> {
  const tools = await mcpService.listTools(name);
  if (tools.length === 0) {
    console.log(`${name} nao expoe nenhuma ferramenta`);
    return;
  }
  for (const tool of tools) {
    console.log(`${tool.name.padEnd(20)} ~${String(tool.estimatedTokens).padStart(5)} tok  ${tool.description}`);
  }
  console.log(`${tools.length} ferramenta(s)`);
}

async function mcpTest(name: string): Promise<void> {
  const check = await mcpService.testConnection(name);
  if (check.ok) {
    console.log(`${name} ok em ${check.elapsedMs}ms, ${check.toolCount} ferramenta(s)`);
    return;
  }
  console.log(`${name} falhou em ${check.elapsedMs}ms: ${check.error}`);
  process.exitCode = 1;
}

/** Lista os gatilhos cadastrados e quando cada um quer a proxima batida. */
async function triggers(): Promise<void> {
  const list = await triggerService.list();
  if (list.length === 0) {
    console.log("nenhum gatilho cadastrado");
    return;
  }
  for (const t of list) {
    const estado = t.enabled ? "habilitado " : "desabilitado";
    console.log(`${t.id}  ${estado}  ${t.agentId}  ${JSON.stringify(t.config)}`);
  }
  const next = await scheduler.nextDueAt();
  console.log(`\nproxima batida: ${next === null ? "nenhuma" : new Date(next).toISOString()}`);
}

/** Uma batida do agendador. Quem repete e o sistema, nao um laco daqui. */
async function tick(wait: boolean): Promise<void> {
  const result: TickResult = await scheduler.tick({ wait });
  if (result.outcomes.length === 0) console.log("nenhum gatilho habilitado");
  for (const o of result.outcomes) {
    const detalhe = o.detail ? `  ${o.detail}` : "";
    console.log(
      `${o.status.padEnd(8)} ${o.kind.padEnd(9)} ${o.agentId}  ` +
        `${o.events} evento(s), ${o.runs.length} run(s)${detalhe}`,
    );
    for (const runId of o.runs) console.log(`         run ${runId}`);
  }

  // A conferencia sai sempre, inclusive sem gatilho nenhum habilitado: ela nao
  // depende de gatilho, e quem roda o `tick` a mao esta perguntando tambem se
  // algum pull request fechou desde a ultima vez.
  const c = result.reconciled;
  const erro = c.detail ? `  ${c.detail}` : "";
  console.log(
    `\nconferencia: ${c.checked} execucao(oes) olhada(s), ${c.settled} com desfecho, ` +
      `${c.stillOpen} com PR aberto, ${c.unreadable} sem PR, ${c.failed} com falha${erro}`,
  );
  console.log(
    `proxima batida: ${result.nextDueAt === null ? "nenhuma" : new Date(result.nextDueAt).toISOString()}`,
  );
}

/**
 * Estado da preferencia de subir junto com o login.
 *
 * A linha de comando so mexe no que esta guardado: quem fala com o item de
 * login do macOS e o processo do Electron, entao o que se grava aqui vale a
 * partir da proxima vez que o Locum subir.
 */
async function startup(decision: boolean | null): Promise<void> {
  if (decision !== null) await startupService.setPreference(decision);

  const preference = await startupService.getPreference();
  if (preference === null) {
    console.log("inicio no login: nao decidido, e o app nao liga sozinho");
    return;
  }
  console.log(
    `inicio no login: ${preference ? "ligado" : "desligado"}` +
      (decision === null ? "" : ", valendo na proxima vez que o Locum subir"),
  );
}

/**
 * Estado do interruptor da atualização automática.
 *
 * Como o do login, a linha de comando só mexe no que está guardado: quem fala
 * com o GitHub é o processo do Electron. Sem decisão, vale ligado.
 */
async function updates(decision: boolean | null): Promise<void> {
  if (decision !== null) await updateService.setEnabled(decision);

  const { preference, enabled } = await updateService.state();
  if (preference === null) {
    console.log("atualização automática: não decidido, e o padrão é ligado");
    return;
  }
  console.log(
    `atualização automática: ${enabled ? "ligada" : "desligada"}` +
      (decision === null ? "" : ", valendo na próxima vez que o Locum subir"),
  );
}

/**
 * O que esta guardado no cofre e quem aponta para la.
 *
 * Nenhum valor sai impresso, e pela linha de comando nem daria: o keychain so
 * abre dentro do app. Aqui se enxerga o endereco, nao o segredo.
 */
async function secrets(): Promise<void> {
  const { available, refs } = await credentialService.overview();
  console.log(
    available
      ? "cofre: legivel neste processo"
      : "cofre: so o app Electron le, aqui vale a variavel de ambiente",
  );

  const quem = (ref: (typeof refs)[number]): string =>
    ref.users.length === 0
      ? "sem cadastro apontando"
      : ref.users.map((uso) => `${uso.kind} ${uso.name}`).join(", ");

  const guardados = refs.filter((ref) => ref.stored);
  console.log("\nguardados:");
  if (guardados.length === 0) console.log("  nenhum");
  for (const ref of guardados) console.log(`  ${ref.ref.padEnd(32)} ${quem(ref)}`);

  const orfaos = refs.filter((ref) => !ref.stored);
  if (orfaos.length > 0) {
    console.log("\napontam para credencial que nao existe no cofre:");
    for (const ref of orfaos) console.log(`  ${ref.ref.padEnd(32)} ${quem(ref)}`);
  }
}

/** Liga ou desliga um cadastro de uma credencial do cofre. */
async function secretLink(alvo: string, ref: string | null): Promise<void> {
  const at = alvo.indexOf(":");
  const kind = at < 0 ? "" : alvo.slice(0, at);
  const name = alvo.slice(at + 1);
  if (kind !== "provider" && kind !== "mcp") {
    throw new Error("alvo invalido, use provider:<nome> ou mcp:<nome>");
  }

  if (kind === "provider") await providerService.setCredentialRef(name, ref);
  else await mcpService.setCredentialRef(name, ref);

  console.log(ref === null ? `${alvo} desvinculado` : `${alvo} aponta para ${ref}`);
  if (ref !== null && !secretService.has(ref)) {
    console.log(`nada guardado em ${ref} ainda: grave com "electron dist/main.cjs --set-secret ${ref}"`);
  }
}

/**
 * Aplica migração pendente antes de qualquer comando.
 *
 * O processo principal do Electron já fazia isso na subida, e a linha de
 * comando não: aberta contra um banco de antes de uma migração, ela quebrava na
 * primeira consulta, com coluna inexistente. O loop nunca pegou porque cria um
 * banco novo a cada rodada, sempre no esquema mais recente.
 *
 * A pasta é resolvida pelo próprio arquivo, e não pelo diretório de trabalho,
 * porque quem chama pode estar em qualquer lugar.
 */
function migrarAntes(): void {
  migrateDb(fileURLToPath(new URL("../drizzle", import.meta.url)));
}

async function main(): Promise<void> {
  migrarAntes();
  const [cmd, ...todos] = process.argv.slice(2);
  const { agentId, resto: args } = opcaoAgent(todos);
  const arg = args[0];
  const executor = () => buildExecutor();

  switch (cmd) {
    case "import":
      if (!arg) throw new Error("uso: import <arquivo.json>");
      await importAgent(arg);
      break;
    case "export":
      if (!arg) throw new Error("uso: export <agent-id> [arquivo.json]");
      await exportAgent(arg, args[1]);
      break;
    case "demo":
      // "demo limpo" roda o diff correto, que tem que voltar sem achado.
      await start(arg === "limpo" ? "sintetico-limpo" : "sintetico", agentId);
      break;
    case "fixture:run": {
      // Execucao plantada, sem chamar modelo. Ela existe para a interface e
      // para o smoke terem o que mostrar num banco novo sem gastar assinatura.
      const { ensureDemoRun } = await import("./fixtures/demo-run.js");
      const id = await ensureDemoRun();
      await printRun(id);
      break;
    }
    case "review":
      if (!arg) throw new Error("uso: review owner/repo#123 [--agent <id>]");
      await start(arg, agentId);
      break;
    case "poll": {
      const owner = process.env.GITHUB_OWNER;
      if (!owner) throw new Error("GITHUB_OWNER ausente");
      const ids = await pollOpenPullRequests(owner, new RegExp(arg ?? ".*"));
      console.log(`${ids.length} evento(s) novo(s)`);
      break;
    }
    case "digest":
      await digest(agentId ?? "slack-digest");
      break;
    case "inbox":
      await inbox();
      break;
    case "runs":
      await runs(arg);
      break;
    case "reconcile": {
      if (!arg) throw new Error("uso: reconcile <run-id> [--force]");
      await reconcile(arg, args.includes("--force"));
      break;
    }
    case "metrics":
      await metrics(arg);
      break;
    case "triggers":
      await triggers();
      break;
    case "tick":
      await tick(args.includes("--wait"));
      break;
    case "providers":
      await providers();
      break;
    case "startup":
      await startup(null);
      break;
    case "startup:on":
      await startup(true);
      break;
    case "startup:off":
      await startup(false);
      break;
    case "updates":
      await updates(null);
      break;
    case "updates:on":
      await updates(true);
      break;
    case "updates:off":
      await updates(false);
      break;
    case "secrets":
      await secrets();
      break;
    case "secret:link": {
      const [alvo, ref] = args;
      if (!alvo || !ref) throw new Error("uso: secret:link <provider|mcp>:<nome> <escopo/nome>");
      await secretLink(alvo, ref);
      break;
    }
    case "secret:unlink":
      if (!arg) throw new Error("uso: secret:unlink <provider|mcp>:<nome>");
      await secretLink(arg, null);
      break;
    case "mcp":
      await mcpList();
      break;
    case "mcp:register": {
      const [name, rawTransport, alvo] = args;
      if (!name || !rawTransport || !alvo) {
        throw new Error("uso: mcp:register <nome> <stdio|http|sse> <comando-ou-url>");
      }
      const transport = McpTransport.safeParse(rawTransport);
      if (!transport.success) throw new Error("transporte invalido, use stdio, http ou sse");

      // O comando chega como uma string so para caber em um argumento de shell.
      const { config } = await mcpService.register({
        name,
        transport: transport.data,
        ...(transport.data === "stdio" ? { command: alvo.split(/\s+/) } : { url: alvo }),
      });
      console.log(`${config.name} cadastrado (${config.transport})`);
      break;
    }
    case "mcp:tools":
      if (!arg) throw new Error("uso: mcp:tools <nome>");
      await mcpTools(arg);
      break;
    case "mcp:test":
      if (!arg) throw new Error("uso: mcp:test <nome>");
      await mcpTest(arg);
      break;
    case "mcp:remove":
      if (!arg) throw new Error("uso: mcp:remove <nome>");
      console.log((await mcpService.remove(arg)) ? `${arg} removido` : `${arg} nao estava cadastrado`);
      break;
    case "mcp:enable":
    case "mcp:disable": {
      if (!arg) throw new Error(`uso: ${cmd} <nome>`);
      await mcpService.setEnabled(arg, cmd === "mcp:enable");
      console.log(`${arg} ${cmd === "mcp:enable" ? "habilitado" : "desabilitado"}`);
      break;
    }
    case "approve":
    case "reject": {
      if (!arg) throw new Error(`uso: ${cmd} <approval-id>`);
      const { status, run } = await (await executor()).decide(arg, cmd === "approve" ? "approved" : "rejected");
      const desfecho =
        status === "conflict" ? "conflito, nada publicado" : status === "approved" ? "aprovado e publicado" : "rejeitado";
      console.log(`${arg} ${desfecho}, run ${run}`);
      break;
    }
    case "stuck:published":
    case "stuck:retry": {
      if (!arg) throw new Error(`uso: ${cmd} <approval-id>`);
      const desfecho = cmd === "stuck:published" ? "published" : "retry";
      const { status, run } = await (await executor()).settleStuck(arg, desfecho);
      console.log(status === "approved" ? `${arg} fechada como publicada, run ${run}` : `${arg} de volta na fila`);
      break;
    }
    case "resume": {
      const ids = await (await executor()).resumeAll();
      console.log(`${ids.length} run(s) retomado(s)`);
      break;
    }
    case "run":
      if (!arg) throw new Error("uso: run <run-id>");
      console.log(await (await executor()).execute(arg));
      await printRun(arg);
      break;
    case "rerun": {
      const [runId, stepKey] = args;
      if (!runId || !stepKey) throw new Error("uso: rerun <run-id> <chave-do-passo>");
      console.log(await runService.rerunStep(runId, stepKey));
      await printRun(runId);
      break;
    }
    default:
      console.log(
        [
          "uso: pnpm dev <comando>",
          "",
          "  import <arquivo.json>    grava um agent de arquivo (exemplos em examples/agents/)",
          "  export <agent> [arquivo] escreve o spec mais recente, no formato do import",
          "  demo [--agent id]        roda o agent num PR sintetico, sem credencial",
          "  demo limpo               o mesmo, num PR correto que deve voltar sem achado",
          "  fixture:run              planta uma execucao pronta no banco, sem chamar modelo",
          "  review owner/repo#123    roda o agent num PR especifico (--agent quando houver mais de um)",
          "  poll [regex-de-repo]     varre PRs abertos da org e cria eventos",
          "  digest [--agent id]      junta o Slack desde a ultima entrega e roda o agent de digest (slack-digest)",
          "  inbox                    lista aprovacoes pendentes",
          "  stuck:published <id>     pendencia parada na publicacao: saiu",
          "  stuck:retry <id>         pendencia parada na publicacao: volta para a fila",
          "  runs [status]            lista as ultimas execucoes",
          "  reconcile <run-id>       cruza o review humano com os achados e grava os desfechos",
          "  metrics [agent-id]       recalcula e imprime precisao por versao de agent",
          "  triggers                 lista os gatilhos e quando o agendador quer a proxima batida",
          "  tick [--wait]            uma batida do agendador nos gatilhos habilitados",
          "  providers                lista provedores, substituicoes e a resolucao de cada passo",
          "  startup                  mostra se o Locum sobe junto com o login",
          "  startup:on               passa a subir no login a partir da proxima subida",
          "  startup:off              deixa de subir no login",
          "  updates                  mostra se a atualização automática está ligada",
          "  updates:on               liga a verificação de atualização na subida do app",
          "  updates:off              desliga a verificação de atualização",
          "  secrets                  credenciais guardadas no cofre e quem aponta para elas",
          "  secret:link <provider|mcp>:<nome> <escopo/nome>",
          "  secret:unlink <provider|mcp>:<nome>",
          "  mcp                      lista os servidores MCP cadastrados",
          "  mcp:register <nome> <transporte> <comando-ou-url>",
          "  mcp:tools <nome>         lista as ferramentas que o servidor expoe",
          "  mcp:test <nome>          conecta no servidor e informa o resultado",
          "  mcp:remove <nome>        tira o servidor do cadastro",
          "  mcp:enable <nome>        volta a expor o servidor ao executor",
          "  mcp:disable <nome>       tira o servidor do executor sem apagar",
          "  approve <id>             publica a acao",
          "  reject <id>              descarta",
          "  resume                   retoma runs interrompidos",
          "  run <run-id>             continua um run especifico",
          "  rerun <run-id> <passo>   zera o passo e os que dependem dele, e roda de novo",
        ].join("\n"),
      );
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeMcpPool().catch(() => undefined));
