import { listTeamsChannels } from "../src/teams/channels.js";
import { app, BrowserWindow, dialog, ipcMain, type WebContents } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { agentBuilder, criadorDisponivel } from "./agent-builder.js";
import { chatSession } from "./chat.js";
import {
  BRIDGE_CHANNELS,
  type BridgeChannel,
  type LocumApi,
  type WindowLanguage,
} from "./bridge-contract.js";
import { buildExecutor, buildGate } from "../src/executor/build.js";
import { aplicarIdioma, t } from "./i18n.js";
import { VERSAO } from "./versao.js";
import { agentService } from "../src/services/agent-service.js";
import { approvalService } from "../src/services/approval-service.js";
import { claudeCodeService } from "../src/services/claude-code-service.js";
import { connectionService } from "../src/services/connection-service.js";
import { credentialService } from "../src/services/credential-service.js";
import { executionService } from "../src/services/execution-service.js";
import { githubService } from "../src/services/github-service.js";
import { i18nService } from "../src/services/i18n-service.js";
import { initiativeService } from "../src/services/initiative-service.js";
import { machineService } from "../src/services/machine-service.js";
import { mcpService } from "../src/services/mcp-service.js";
import { metricsService } from "../src/services/metrics-service.js";
import { priceService } from "../src/services/price-service.js";
import { promptService } from "../src/services/prompt-service.js";
import { providerService } from "../src/services/provider-service.js";
import { runService } from "../src/services/run-service.js";
import { sessionService } from "../src/services/session-service.js";
import { claudeSessionsService } from "../src/services/claude-sessions-service.js";
import { slackService } from "../src/services/slack-service.js";
import { startupService } from "../src/services/startup-service.js";
import { updateService } from "../src/services/update-service.js";
import { trackerService } from "../src/services/tracker-service.js";
import { triggerService } from "../src/services/trigger-service.js";
import { scheduler } from "../src/triggers/scheduler.js";
import { refreshTray } from "./tray.js";

export interface BridgeHandlers {
  /** Run para onde o ultimo clique de notificacao mandou. */
  inboxTarget: () => string | null;
}

/**
 * Janelas que o Locum abriu, por id de `webContents`.
 *
 * A ponte so responde a elas. Nao e paranoia gratuita: o dia em que a interface
 * mostrar qualquer coisa de fora, um iframe ou uma janela filha herdariam o
 * preload e passariam a falar pelos mesmos canais. Confiar na origem do pedido
 * e mais barato agora do que depois.
 */
const trusted = new Set<number>();

export function trustWindow(window: BrowserWindow): void {
  const id = window.webContents.id;
  trusted.add(id);
  window.on("closed", () => trusted.delete(id));
}

function assertTrusted(sender: WebContents, channel: BridgeChannel): void {
  if (!trusted.has(sender.id)) {
    throw new Error(`pedido em ${channel} veio de uma janela que nao e do Locum`);
  }
}

/**
 * O que cada canal faz do lado de ca: encaminhar para o servico, e mais nada.
 *
 * Nenhuma regra mora aqui de proposito. Se um dia aparecer um `if` neste mapa,
 * e sinal de que a regra escapou do servico, e a linha de comando e o servidor
 * MCP vao deixar de enxerga-la.
 */
/**
 * Quem pediu e quem recebe o fluxo do chat.
 *
 * Guardado por chamada em vez de vir do `BridgeHandlers`, porque o destino do
 * fluxo e sempre a janela que mandou a mensagem, e nao uma janela fixa
 * escolhida na subida.
 */
let remetente: WebContents | null = null;

/**
 * O idioma resolvido, com a etiqueta que o sistema devolve.
 *
 * `app.getLocale()` só responde depois do `ready`, e por isso a chamada fica
 * aqui dentro e não numa constante de módulo: a ponte só atende pedido de
 * janela, que por definição já subiu.
 */
async function idiomaDaJanela(): Promise<WindowLanguage> {
  const estado = await i18nService.resolve(app.getLocale());
  return { ...estado, strict: !app.isPackaged };
}

function buildHandlers(bridgeHandlers: BridgeHandlers): LocumApi {
  return {
    "agents.list": () => agentService.list(),
    "agents.get": (agentId) => agentService.get(agentId),
    "agents.versions": (agentId) => agentService.listVersions(agentId),
    "agents.overview": () => agentService.overview(),
    "agents.saveEdited": (agentId, spec, note) => agentService.saveEdited(agentId, spec, note),
    "actions.describe": async () => buildGate().describe(),
    "agents.duplicate": (fromId, newId, newName) => agentService.duplicate(fromId, newId, newName),
    "agents.importFile": async () => {
      const janela = BrowserWindow.getFocusedWindow();
      const opcoes = {
        title: t("agents.io.importTitle"),
        filters: [{ name: "Agent", extensions: ["json"] }],
        properties: ["openFile" as const],
      };
      const escolha = janela ? await dialog.showOpenDialog(janela, opcoes) : await dialog.showOpenDialog(opcoes);
      const caminho = escolha.filePaths[0];
      if (escolha.canceled || caminho === undefined) return null;
      const { version, created } = await agentService.importSpec(await readFile(caminho, "utf8"), basename(caminho));
      return { agentId: version.agentId, version: version.version, created };
    },
    "agents.exportFile": async (agentId) => {
      const texto = await agentService.exportSpec(agentId);
      const janela = BrowserWindow.getFocusedWindow();
      const opcoes = { title: t("agents.io.exportTitle"), defaultPath: join(app.getPath("documents"), `${agentId}.json`) };
      const escolha = janela ? await dialog.showSaveDialog(janela, opcoes) : await dialog.showSaveDialog(opcoes);
      if (escolha.canceled || escolha.filePath === undefined) return null;
      await writeFile(escolha.filePath, texto);
      return escolha.filePath;
    },
    "agents.installReply": async (service) => {
      const { REPLY_SPECS } = await import("../src/examples/agents.js");
      const spec = REPLY_SPECS[service];
      if (spec === undefined) throw new Error(`não há resposta pronta para ${String(service)}`);
      if ((await agentService.get(spec.id)) !== undefined) return { agentId: spec.id, created: false };
      await agentService.upsert(spec, "resposta pronta", "human");
      return { agentId: spec.id, created: true };
    },
    "agents.aiStatus": () => criadorDisponivel(),
    "agents.aiDraft": (descricao) => agentBuilder.criar(descricao),
    "agents.aiSave": (spec, descricao) => agentService.saveDraft(spec, descricao),
    "agents.budgets": () => agentService.budgets(),

    "initiatives.list": () => initiativeService.list(),
    "initiatives.detail": (slug) => initiativeService.detail(slug),
    "initiatives.context": (slug, file) => initiativeService.readContext(slug, file),
    "initiatives.deliveries": (slug) => initiativeService.deliveries(slug),
    "initiatives.overview": () => initiativeService.overview(),
    "initiatives.staleDays": () => initiativeService.staleDays(),
    "initiatives.setStaleDays": (value) => initiativeService.setStaleDays(value),
    "initiatives.root": () => initiativeService.rootFolder(),
    "initiatives.setRoot": (path) => initiativeService.setRootFolder(path),
    "initiatives.upsert": (input) => initiativeService.upsert(input),
    "initiatives.setStatus": (slug, status) => initiativeService.setStatus(slug, status),
    "initiatives.setServers": (slug, names) => initiativeService.setServers(slug, names),
    "initiatives.linkAgent": (agentId, slug) => initiativeService.linkAgent(agentId, slug),
    "initiatives.setWorkspaces": (slug, workspaces) => initiativeService.setWorkspaces(slug, workspaces),
    "initiatives.addLink": (slug, link) => initiativeService.addLink(slug, link),
    "initiatives.removeLink": (slug, linkId) => initiativeService.removeLink(slug, linkId),

    "sessions.open": (slug, options) => sessionService.open(slug, options),
    "sessions.readHandoff": (slug) => sessionService.readHandoff(slug),
    "sessions.terminal": () => sessionService.terminal(),
    "sessions.setTerminal": (value) => sessionService.setTerminal(value),
    "claudeSessions.list": () => claudeSessionsService.list(),
    "claudeSessions.markDone": (id, lastActivityAt) => claudeSessionsService.markDone(id, lastActivityAt),
    "claudeSessions.reopen": (id) => claudeSessionsService.reopen(id),
    "claudeSessions.resume": (id) => claudeSessionsService.resume(id),
    "prompts.list": (initiativeId) => promptService.list(initiativeId),

    "runs.list": (filter) => runService.list(filter),
    "runs.get": (runId) => runService.get(runId),
    "runs.findings": (runId) => runService.findings(runId),
    "runs.findingsByRun": (runIds) => runService.findingsByRun(runIds),
    "runs.rerunStep": (runId, stepKey, options) => runService.rerunStep(runId, stepKey, options),
    "runs.start": (input) => executionService.start(input),

    "approvals.listPending": () => approvalService.listPending(),
    "approvals.listStuck": () => approvalService.listStuck(),
    "approvals.get": (approvalId) => approvalService.get(approvalId),
    "approvals.update": (approvalId, findings, verdict) =>
      approvalService.updateFindings(approvalId, findings, verdict),
    "approvals.updateText": (approvalId, text) => approvalService.updateText(approvalId, text),

    "approvals.decide": async (approvalId, decision) => {
      if (decision !== "approved" && decision !== "rejected") {
        throw new Error(`decisao "${String(decision)}" nao existe`);
      }
      // A gate recusa pendencia inexistente ou ja resolvida, publica com o
      // externalId que ja estava gravado, e e a unica que fala com o handler de
      // publicacao. A ponte nao repete nada disso: ela leva o clique e volta.
      // É o executor quem chama a gate, para o run seguir depois da decisão.
      const { status } = await (await buildExecutor()).decide(approvalId, decision);
      await refreshTray();
      return { approvalId, decision, status };
    },
    "approvals.settleStuck": async (approvalId, outcome) => {
      if (outcome !== "published" && outcome !== "retry") {
        throw new Error(`desfecho "${String(outcome)}" nao existe`);
      }
      const { status } = await (await buildExecutor()).settleStuck(approvalId, outcome);
      await refreshTray();
      return { approvalId, status };
    },

    // O assistente responde por fluxo, entao `send` volta assim que a conversa
    // comeca. O que chega de volta vai pelo canal de evento.
    "chat.status": () => chatSession.status(),
    "chat.setModel": (modelo) => chatSession.escolher(modelo),
    "chat.send": async (texto, context) => {
      if (!remetente) throw new Error("sem janela para receber o fluxo");
      await chatSession.enviar(texto, remetente, context);
    },
    "chat.cancel": async () => chatSession.interromper(),

    "mcp.list": () => mcpService.list(),
    "mcp.test": (name) => mcpService.testConnection(name),
    "mcp.tools": (name) => mcpService.listTools(name),
    "mcp.setEnabled": (name, enabled) => mcpService.setEnabled(name, enabled),

    "providers.list": async () => providerService.listProviders(),
    "providers.fallbacks": (machine) => providerService.getFallbacks(machine),
    "providers.preview": (models, machine) => providerService.resolvePreviews(models, machine),
    "providers.models": (nome) => providerService.listModels(nome),
    "providers.allModels": (opcoes) => providerService.listAllModels(opcoes),
    "providers.registered": () => providerService.listRegistered(),
    "providers.register": (cadastro) => providerService.register(cadastro),
    "providers.remove": (id, force) => providerService.remove(id, force),
    "providers.credentials": () => providerService.credentials(),
    "providers.saveSecret": (nome, chave) => providerService.setSecret(nome, chave),
    "providers.forgetSecret": (nome) => providerService.clearSecret(nome),
    "providers.checkSecret": (nome) => providerService.check(nome),
    "providers.prices": () => priceService.list(),
    "providers.setPrice": (preco) => priceService.set(preco),
    "providers.removePrice": (provedor, modelo) => priceService.remove(provedor, modelo),

    "credentials.overview": () => credentialService.overview(),

    "github.status": () => githubService.status(),
    "github.save": (token) => githubService.setToken(token),
    "github.forget": () => githubService.clearToken(),
    "github.check": () => githubService.check(),
    "claudeCode.status": () => claudeCodeService.status(),
    "claudeCode.connect": () => claudeCodeService.connect(),
    "connections.list": () => connectionService.list(),
    "connections.connect": (id) => connectionService.connect(id),
    "connections.disconnect": (id) => connectionService.disconnect(id),
    "connections.addCustom": (input) => connectionService.addCustom(input),
    "connections.slackApp": () => connectionService.slackApp(),
    "connections.connectSlack": (clientId) => connectionService.connectSlack(clientId),
    "connections.disconnectSlack": () => connectionService.disconnectSlack(),
    "connections.openSlackManifest": () => connectionService.openSlackManifest(),
    "connections.teamsApp": () => connectionService.teamsApp(),
    "connections.connectTeams": (tenantId, clientId) => connectionService.connectTeams(tenantId, clientId),
    "connections.disconnectTeams": () => connectionService.disconnectTeams(),
    "connections.teamsAdminConsent": (tenantId, clientId) => connectionService.teamsAdminConsent(tenantId, clientId),
    "connections.setTeamsChannels": (ligado) => connectionService.setTeamsChannels(ligado),
    "connections.teamsChannels": () => listTeamsChannels(),

    "trackers.list": () => trackerService.list(),
    "trackers.register": (cadastro) => trackerService.register(cadastro),
    "trackers.remove": (id) => trackerService.remove(id),
    "trackers.setEnabled": (id, enabled) => trackerService.setEnabled(id, enabled),
    "trackers.setProject": (id, projeto) => trackerService.setProject(id, projeto),
    "trackers.saveSecret": (id, credencial) => trackerService.setSecret(id, credencial),
    "trackers.forgetSecret": (id) => trackerService.clearSecret(id),
    "trackers.test": (id) => trackerService.testConnection(id),
    "trackers.projects": (id) => trackerService.listProjects(id),

    "slack.get": () => slackService.get(),
    "slack.setSource": (cadastro) => slackService.setSource(cadastro),
    "slack.addChannel": (canal) => slackService.addChannel(canal),
    "slack.removeChannel": (canal) => slackService.removeChannel(canal),

    "metrics.report": (options) => metricsService.report(options),
    "machine.profile": () => machineService.profile(),

    "triggers.list": (agentId) => triggerService.list(agentId),
    "triggers.set": (agentId, config, options) => triggerService.set(agentId, config, options),
    "triggers.remove": (id) => triggerService.remove(id),
    "triggers.setEnabled": (id, enabled) => triggerService.setEnabled(id, enabled),
    "triggers.schedule": (at) => scheduler.schedule(at),

    "app.version": async () => VERSAO,
    "startup.get": () => startupService.getPreference(),
    "startup.set": (enabled) => startupService.setPreference(enabled),

    // Import tardio: o verificador só entra quando a tela pergunta por ele.
    "updates.state": async () => (await import("./updater.js")).updaterState(),
    "updates.setEnabled": async (enabled) => {
      const updater = await import("./updater.js");
      await updateService.setEnabled(enabled);
      if (enabled) await updater.setupUpdater();
      else updater.teardownUpdater();
      return updater.updaterState();
    },
    "updates.check": async () => {
      const updater = await import("./updater.js");
      // A falha fica no estado, com a mensagem, e a tela mostra de lá.
      await updater.conferir().catch(() => undefined);
      return updater.updaterState();
    },
    "updates.apply": async () => (await import("./updater.js")).aplicarAgora(),

    "i18n.state": () => idiomaDaJanela(),
    "i18n.setPreference": async (language) => {
      await i18nService.setPreference(language);
      const estado = await idiomaDaJanela();
      // A janela troca de idioma sozinha com o que volta daqui, e o processo
      // principal não tem quem o avise: bandeja e notificação continuariam no
      // idioma da subida até alguém reiniciar o app. O menu é remontado na
      // sequência porque os rótulos dele já estão escritos na barra do sistema.
      await aplicarIdioma(estado.language);
      await refreshTray();
      (await import("./menu.js")).refreshAppMenu();
      return estado;
    },

    "window.inboxTarget": async () => bridgeHandlers.inboxTarget(),
  };
}

/** Registra os canais. Devolve quantos ficaram no ar. */
export function setupBridge(bridgeHandlers: BridgeHandlers): number {
  const handlers = buildHandlers(bridgeHandlers);
  const listed = new Set<string>(BRIDGE_CHANNELS);
  const faltando = Object.keys(handlers).filter((k) => !listed.has(k));
  if (faltando.length > 0) {
    throw new Error(`canais fora da lista do contrato: ${faltando.join(", ")}`);
  }

  for (const channel of BRIDGE_CHANNELS) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      assertTrusted(event.sender, channel);
      remetente = event.sender;
      // O cast e inevitavel: o `ipcMain` entrega `unknown[]`, e o tipo de cada
      // canal so existe no contrato. O que sustenta a assinatura e o mapa
      // acima, que compila contra os servicos.
      const call = handlers[channel] as (...a: unknown[]) => Promise<unknown>;
      return call(...args);
    });
  }

  return BRIDGE_CHANNELS.length;
}

export function teardownBridge(): void {
  for (const channel of BRIDGE_CHANNELS) ipcMain.removeHandler(channel);
  trusted.clear();
}

/** Canais no ar agora, para quem precisa conferir sem abrir janela. */
export function bridgeChannelCount(): number {
  return BRIDGE_CHANNELS.length;
}
