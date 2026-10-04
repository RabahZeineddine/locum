import type { TeamsChannelOption } from "../src/teams/channels.js";
import type { AgentService } from "../src/services/agent-service.js";
import type { RascunhoDeAgent } from "../src/services/agent-builder.js";
import type { ApprovalService } from "../src/services/approval-service.js";
import type { AutomationService } from "../src/services/automation-service.js";
import type { LibraryService } from "../src/services/library-service.js";
import type { ClaudeCodeService } from "../src/services/claude-code-service.js";
import type { ConnectionService } from "../src/services/connection-service.js";
import type { CredentialService } from "../src/services/credential-service.js";
import type { ExecutionService } from "../src/services/execution-service.js";
import type { GithubService } from "../src/services/github-service.js";
import type { Language, LanguageState } from "../src/services/i18n-service.js";
import type { InitiativeService } from "../src/services/initiative-service.js";
import type { SessionService } from "../src/services/session-service.js";
import type { ClaudeSessionsService } from "../src/services/claude-sessions-service.js";
import type { MachineService } from "../src/services/machine-service.js";
import type { McpService } from "../src/services/mcp-service.js";
import type { MetricsService } from "../src/services/metrics-service.js";
import type { ClaudeImportService } from "../src/services/claude-import.js";
import type { ClaudeAccountService } from "../src/runtimes/claude-account.js";
import type { PriceService } from "../src/services/price-service.js";
import type { PromptService } from "../src/services/prompt-service.js";
import type { ProviderService } from "../src/services/provider-service.js";
import type { RunService } from "../src/services/run-service.js";
import type { SlackService } from "../src/services/slack-service.js";
import type { StartupService } from "../src/services/startup-service.js";
import type { UpdaterState } from "../src/update/state.js";
import type { TrackerService } from "../src/services/tracker-service.js";
import type { TriggerService } from "../src/services/trigger-service.js";
import type { Scheduler } from "../src/triggers/scheduler.js";

/**
 * Contrato da ponte entre a janela e a camada de servico.
 *
 * Este arquivo e o unico que os dois lados importam, e ele nao tem import de
 * valor: so tipo e a lista de canais. Isso importa porque o preload roda em
 * sandbox, onde nao existe nem banco nem `node_modules` para carregar, e um
 * import de valor vindo de `src/` arrastaria o nucleo inteiro para dentro dele.
 *
 * Cada canal e tipado pelo metodo do servico que ele encaminha. Mudar a
 * assinatura de um servico quebra a compilacao da ponte, que e o ponto: a
 * janela nao tem contrato proprio, ela consome o dos servicos.
 */

/** Todo canal atravessa IPC, entao o que era sincrono volta como promessa. */
type Asyncify<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : never;

export interface DecisionResult {
  approvalId: string;
  decision: "approved" | "rejected";
  /** O desfecho de verdade: rejeitado pode virar `conflict` quando o alvo mudou por fora. */
  status: "approved" | "rejected" | "conflict";
}

/**
 * O idioma resolvido, do jeito que a janela precisa dele.
 *
 * É o estado do serviço mais o `strict`, que não é assunto de idioma e sim de
 * empacotamento: o serviço não sabe se está rodando numa instalação ou numa
 * árvore de trabalho, e essa é justamente a pergunta que decide se chave de
 * tradução faltando estoura ou vira texto cru.
 */
export interface WindowLanguage extends LanguageState {
  /** Fora de app empacotado, chave ausente estoura em vez de chegar na tela. */
  strict: boolean;
}

interface ServiceApi {
  "agents.list": AgentService["list"];
  "agents.get": AgentService["get"];
  "agents.versions": AgentService["listVersions"];
  "agents.budgets": AgentService["budgets"];
  /** O que a lista mostra sem abrir agent nenhum: modelo, cadência, gasto. */
  "agents.overview": AgentService["overview"];
  /**
   * O que uma pessoa editou na tela, gravado como versão nova e como pessoa.
   *
   * Fica fora do catálogo que a janela expõe, pela mesma razão de
   * `approvals.decide`: gravar como pessoa pode subir o modo de um passo de
   * ação, e subir o modo e depois executar é publicar sem clique em dois
   * passos. Quem chama é o botão de salvar, e mais ninguém.
   */
  "agents.saveEdited": AgentService["saveEdited"];
  /** Os modos que cada ação aceita, perguntados ao handler. Só leitura. */
  "actions.describe": () => { kind: string; modes: readonly ("approve" | "draft" | "auto")[]; holdsByContent: boolean }[];
  "agents.duplicate": AgentService["duplicate"];
  /**
   * Importar e exportar pelo seletor de arquivo do sistema. Importar grava
   * agent como pessoa, então mora no mesmo acesso estreito do salvar. Os dois
   * devolvem `null` quando a pessoa cancela o seletor.
   */
  "agents.importFile": () => Promise<{ agentId: string; version: number; created: boolean } | null>;
  "agents.exportFile": (agentId: string) => Promise<string | null>;
  /**
   * Grava o agent de resposta pronto do Slack ou do Teams, como o importar
   * faria. Agent com o mesmo id que já existe fica como está: pode ter sido
   * editado, e o clique não é para desfazer isso.
   */
  "agents.installReply": (service: "slack" | "teams") => Promise<{ agentId: string; created: boolean }>;
  /**
   * "Criar com IA": se há modelo para escrever, o rascunho montado a partir
   * da descrição (sem gravar nada) e a gravação dele depois do clique.
   */
  "agents.aiStatus": () => Promise<{ disponivel: boolean; modelo: string | null }>;
  "agents.aiDraft": (descricao: string) => Promise<RascunhoDeAgent>;
  "agents.aiSave": AgentService["saveDraft"];

  /**
   * Leitura da tela de iniciativas: a lista crua, o detalhe composto (linha
   * mais servidores, workspaces, links e agents ligados) e um arquivo da pasta
   * de contexto com o hash. Nenhuma escrita: mudar `context.md` so passa por
   * `proposeContextUpdate`, que fica fora deste catalogo pela mesma razao de
   * `approvals.decide`.
   */
  "initiatives.list": InitiativeService["list"];
  "initiatives.detail": InitiativeService["detail"];
  "initiatives.context": InitiativeService["readContext"];
  "initiatives.deliveries": InitiativeService["deliveries"];
  /** Fato cru de cada iniciativa, para o painel do Inicio. */
  "initiatives.overview": InitiativeService["overview"];
  "initiatives.staleDays": InitiativeService["staleDays"];
  "initiatives.setStaleDays": InitiativeService["setStaleDays"];
  /** A pasta raiz onde a pasta de contexto de cada iniciativa mora. */
  "initiatives.root": InitiativeService["rootFolder"];
  "initiatives.setRoot": InitiativeService["setRootFolder"];
  /** Criar ou editar iniciativa: titulo, objetivo, criterio de pronto, prazo. */
  "initiatives.upsert": InitiativeService["upsert"];
  "initiatives.setStatus": InitiativeService["setStatus"];
  "initiatives.setServers": InitiativeService["setServers"];
  "initiatives.linkAgent": InitiativeService["linkAgent"];
  "initiatives.setWorkspaces": InitiativeService["setWorkspaces"];
  "initiatives.addLink": InitiativeService["addLink"];
  "initiatives.removeLink": InitiativeService["removeLink"];

  /**
   * Sessao do Claude no terminal com o contexto da iniciativa. Abrir e ler a
   * passagem sao cliques na aba de acoes ou na paleta, nunca leitura de tela, e
   * nenhum dos dois entra no catalogo do chat nem no servidor MCP. Ler a
   * passagem so cria a pendencia `context.update`: o contexto muda no clique
   * da revisao.
   */
  "sessions.open": SessionService["open"];
  "sessions.readHandoff": SessionService["readHandoff"];
  "sessions.list": SessionService["list"];
  "sessions.close": SessionService["close"];
  /** Terminal preferido, na secao geral da configuracao. */
  "sessions.terminal": SessionService["terminal"];
  "sessions.setTerminal": SessionService["setTerminal"];
  "sessions.installedTerminals": SessionService["installedTerminals"];
  /**
   * As sessões do Claude Code da máquina, lidas de `~/.claude`, para a tela que
   * mostra o que ficou pela metade. Marcar e retomar são cliques.
   */
  "claudeSessions.list": ClaudeSessionsService["list"];
  "claudeSessions.markDone": ClaudeSessionsService["markDone"];
  "claudeSessions.reopen": ClaudeSessionsService["reopen"];
  "claudeSessions.resume": ClaudeSessionsService["resume"];

  /** Prompts salvos, para copiar na aba de acoes da iniciativa. */
  "prompts.list": PromptService["list"];

  "runs.list": RunService["list"];
  "runs.get": RunService["get"];
  "runs.findings": RunService["findings"];
  /** Os achados de várias execuções numa ida só, que é o que a inbox precisa. */
  "runs.findingsByRun": RunService["findingsByRun"];
  "runs.rerunStep": RunService["rerunStep"];
  /** Rodar um agent num pull request escolhido na tela, sem linha de comando. */
  "runs.start": ExecutionService["start"];

  "approvals.listPending": ApprovalService["listPending"];
  /** Pendências que começaram a publicar e não terminaram. Só leitura. */
  "approvals.listStuck": ApprovalService["listStuck"];
  "approvals.get": ApprovalService["get"];
  /**
   * O clique de uma pessoa na inbox, e nada alem disso.
   *
   * A janela manda um identificador de pendencia que o executor ja gravou e um
   * sim ou um nao. Ela nao monta o que vai ser publicado, nao escolhe o destino
   * e nao alcanca o handler de publicacao: quem publica continua sendo a
   * ApprovalGate, do outro lado da ponte, que e a porta unica do ADR 0002.
   */
  /**
   * O texto revisado, gravado antes de sair.
   *
   * Editar não publica: a pendência continua esperando o clique. Fica fora do
   * catálogo que a janela expõe a modelo, pela mesma razão de `decide`, porque
   * alterar o que vai sair e depois pedir aprovação é o mesmo caminho por dois
   * passos.
   */
  "approvals.update": ApprovalService["updateFindings"];
  /** O texto de uma resposta de Slack ou Teams, editado na revisão. */
  "approvals.updateText": ApprovalService["updateText"];

  "approvals.decide": (
    approvalId: string,
    decision: "approved" | "rejected",
  ) => Promise<DecisionResult>;
  /**
   * A pessoa conferiu a pendência parada na publicação e diz o que aconteceu:
   * saiu, e o run segue, ou não saiu, e ela volta para a fila. Fica fora dos
   * catálogos da janela pelo mesmo motivo de `decide`: fechar como publicada
   * faz o run seguir, e só quem olhou o destino sabe se é verdade.
   */
  "approvals.settleStuck": (
    approvalId: string,
    outcome: "published" | "retry",
  ) => Promise<{ approvalId: string; status: "approved" | "pending" }>;

  "mcp.list": McpService["list"];
  "mcp.test": McpService["testConnection"];
  "mcp.tools": McpService["listTools"];
  /** Ligar é da pessoa: o que entra pelo servidor MCP nasce desligado. */
  "mcp.setEnabled": McpService["setEnabled"];
  /**
   * Conectores do claude.ai e MCPs de plugin da conta Claude, só leitura.
   * `mcp.tools` com o nome `claude-conta` devolve a mesma lista.
   */
  "claudeAccount.list": ClaudeAccountService["listar"];

  "providers.list": ProviderService["listProviders"];
  "providers.fallbacks": ProviderService["getFallbacks"];
  /** Onde cada modelo do spec cai nesta maquina. So conta, nao dispara nada. */
  "providers.preview": ProviderService["resolvePreviews"];
  /**
   * O catalogo vem do provedor, nao de lista no codigo. Gateway publica o que a
   * organizacao dele decidiu, e id chutado quebra tarde, dentro de uma execucao.
   */
  "providers.models": ProviderService["listModels"];
  "providers.allModels": ProviderService["listAllModels"];

  /**
   * O cadastro de gateway compatível com OpenAI.
   *
   * `remove` responde em vez de perguntar: sem `force` ela devolve onde o
   * provedor aparece e não apaga nada, e a tela mostra a lista antes de
   * oferecer o segundo clique. A confirmação mora na janela porque é lá que
   * está quem decide, e a trava mora no serviço porque é ele que apaga.
   */
  "providers.registered": ProviderService["listRegistered"];
  "providers.register": ProviderService["register"];
  "providers.remove": ProviderService["remove"];

  /**
   * A chave de cada provedor, no mesmo desenho da do GitHub.
   *
   * O segredo atravessa numa direção só: `saveSecret` leva o que alguém
   * digitou até o keychain, e nenhum canal o traz de volta. `credentials`
   * responde endereço, se há valor guardado e o que a última conferência
   * descobriu, que é tudo que a tela mostra.
   *
   * `checkSecret` é o que fala com a rede daqui, e não publica nada: pergunta
   * ao provedor o catálogo de modelos e conta quantos vieram. Sem credencial
   * ela responde de dentro da máquina, sem sair.
   */
  "providers.credentials": ProviderService["credentials"];
  "providers.saveSecret": ProviderService["setSecret"];
  "providers.forgetSecret": ProviderService["clearSecret"];
  "providers.checkSecret": ProviderService["check"];

  /**
   * O preço por modelo, editado junto do provedor. É o que o runtime nativo
   * multiplica pelos tokens, e sem ele o teto em dólar nunca é alcançado.
   */
  "providers.prices": PriceService["list"];
  "providers.setPrice": PriceService["set"];
  "providers.removePrice": PriceService["remove"];

  /**
   * Onde cada credencial mora e se ha valor guardado nela. Nunca o valor: o
   * cofre so se abre no caminho de quem vai conectar, e a janela nao e esse.
   */
  "credentials.overview": CredentialService["overview"];

  /**
   * A credencial do GitHub, que é a única que a janela grava.
   *
   * O segredo atravessa a ponte numa direção só: `save` leva o que alguém
   * digitou até o keychain, e nenhum canal o traz de volta. `status` responde
   * endereço, se há valor guardado e o que a última conferência descobriu, que
   * é tudo que a tela mostra.
   *
   * `check` é a única coisa daqui que fala com a rede, e ela não publica nada:
   * pergunta ao GitHub de quem é o token e quais permissões ele tem. Sem token
   * guardado ela responde de dentro da máquina, sem sair.
   */
  "github.status": GithubService["status"];
  "github.save": GithubService["setToken"];
  "github.forget": GithubService["clearToken"];
  "github.check": GithubService["check"];
  /** Se o Claude Code desta máquina enxerga o Locum, e o clique que o liga. */
  "claudeCode.status": ClaudeCodeService["status"];
  "claudeCode.connect": ClaudeCodeService["connect"];

  /**
   * A vitrine de conexões: catálogo e estado de cada uma nesta máquina.
   *
   * `connect` de servidor remoto abre o navegador para a pessoa autorizar no
   * próprio serviço; o token volta pelo loopback e vai direto ao keychain,
   * sem atravessar a ponte. `addCustom` cadastra um servidor MCP pelo
   * endereço, e só conecta se ele pedir OAuth com registro automático.
   */
  "connections.list": ConnectionService["list"];
  "connections.connect": ConnectionService["connect"];
  "connections.disconnect": ConnectionService["disconnect"];
  "connections.addCustom": ConnectionService["addCustom"];
  /** Servidores MCP do Claude Code (usuário e plugins ligados) que dá para trazer. */
  "claudeImport.list": ClaudeImportService["listar"];
  /** Cadastra os escolhidos desligados, com o segredo no cofre. */
  "claudeImport.apply": ClaudeImportService["importar"];
  /** Slack pelo servidor oficial, com o app que a pessoa criou no workspace. */
  "connections.slackApp": ConnectionService["slackApp"];
  "connections.connectSlack": ConnectionService["connectSlack"];
  "connections.disconnectSlack": ConnectionService["disconnectSlack"];
  "connections.openSlackManifest": ConnectionService["openSlackManifest"];
  /** Teams pelo Graph, com o app que a organização registrou no Entra. */
  "connections.teamsApp": ConnectionService["teamsApp"];
  "connections.connectTeams": ConnectionService["connectTeams"];
  "connections.disconnectTeams": ConnectionService["disconnectTeams"];
  "connections.teamsAdminConsent": ConnectionService["teamsAdminConsent"];
  "connections.setTeamsChannels": ConnectionService["setTeamsChannels"];
  "connections.teamsChannels": () => Promise<TeamsChannelOption[]>;

  /**
   * O tracker de tarefa: cadastrar, apontar destino e testar.
   *
   * O segredo atravessa numa direção só, como no GitHub e nos provedores:
   * `saveSecret` leva o que alguém digitou até o keychain, e nenhum canal o
   * traz de volta. `list` responde endereço, se há valor guardado e o que a
   * última conferência contou.
   *
   * `test` e `projects` falam com o tracker daqui, e nenhum dos dois publica:
   * os dois perguntam quais destinos a credencial enxerga. Criar tarefa não
   * tem canal, e a guarda logo abaixo impede que ganhe um por descuido: pela
   * regra do marco, abrir tarefa nunca é automático, então o único caminho até
   * o `createIssue` do serviço é o passo de ação, que para na fila de
   * aprovação até alguém clicar.
   */
  "trackers.list": TrackerService["list"];
  "trackers.register": TrackerService["register"];
  "trackers.remove": TrackerService["remove"];
  "trackers.setEnabled": TrackerService["setEnabled"];
  "trackers.setProject": TrackerService["setProject"];
  "trackers.saveSecret": TrackerService["setSecret"];
  "trackers.forgetSecret": TrackerService["clearSecret"];
  "trackers.test": TrackerService["testConnection"];
  "trackers.projects": TrackerService["listProjects"];

  /**
   * O que esta máquina observa no Slack: qual servidor MCP responde por ele e
   * quais canais entram na varredura.
   *
   * Não há credencial de Slack nestes canais, e não é esquecimento: quem fala
   * com o Slack é o servidor MCP que alguém já autorizou. Não há canal de
   * publicar tampouco, e a guarda lá embaixo impede que ganhe um por descuido:
   * responder em thread é escrita externa, e escrita externa passa pela fila de
   * aprovação, nunca por um canal que a janela alcança.
   */
  "slack.get": SlackService["get"];
  "slack.setSource": SlackService["setSource"];
  "slack.addChannel": SlackService["addChannel"];
  "slack.removeChannel": SlackService["removeChannel"];

  "metrics.report": MetricsService["report"];
  "machine.profile": MachineService["profile"];

  "triggers.list": TriggerService["list"];
  /**
   * Cadastrar o que observar, e desfazer.
   *
   * A tela grava sem dizer nada sobre habilitar, e o padrão do serviço é o
   * estado parado: ligar é o segundo clique, em `setEnabled`. Quem sustenta
   * essa ordem é o `TriggerService`, não a ponte, e é por isso que `set` chega
   * aqui com a assinatura inteira: quem já pode habilitar num segundo canal
   * não ganha nada sendo impedido de fazê-lo num só.
   *
   * Nada disso publica: o gatilho habilitado varre e cria execução, e o passo
   * de ação continua parando na fila de aprovação.
   */
  "triggers.set": TriggerService["set"];
  "triggers.remove": TriggerService["remove"];
  "triggers.setEnabled": TriggerService["setEnabled"];
  /**
   * Cadastro e agenda na mesma linha: quando cada gatilho bateu e quando o
   * agendador vai acordá-lo. A última batida é cursor do agendador, e não do
   * cadastro, então quem responde é ele.
   */
  "triggers.schedule": Scheduler["schedule"];

  /**
   * A automação: agent e gatilhos editados juntos pelo canvas. Gravar não
   * liga nada; ligar é o `setEnabled`, que é clique de pessoa. "Executar
   * agora" dispara um run sem evento, e o passo de ação continua parando na
   * fila de aprovação.
   */
  "automations.get": AutomationService["get"];
  "automations.save": AutomationService["save"];
  "automations.setEnabled": AutomationService["setEnabled"];
  "automations.runNow": AutomationService["runNow"];
  "automations.suggestId": AutomationService["suggestId"];
  "library.profiles": LibraryService["listProfiles"];
  "library.profile": LibraryService["getProfile"];
  "library.profileVersions": LibraryService["listProfileVersions"];
  "library.toolsets": LibraryService["listToolsets"];
  "library.saveProfile": LibraryService["saveProfile"];
  "library.removeProfile": LibraryService["removeProfile"];
  "library.saveToolset": LibraryService["saveToolset"];
  "library.removeToolset": LibraryService["removeToolset"];
  "library.suggestId": LibraryService["suggestId"];

  /** A versão instalada, para o rodapé da barra lateral. */
  "app.version": () => Promise<string>;

  "startup.get": StartupService["getPreference"];
  "startup.set": StartupService["setPreference"];

  /**
   * A atualização do próprio Locum. Ler o estado não sai para a rede; quem
   * pergunta ao GitHub é o `updates.check`, atrás de um clique, e o relógio do
   * verificador.
   */
  "updates.state": () => Promise<UpdaterState>;
  "updates.setEnabled": (enabled: boolean) => Promise<UpdaterState>;
  "updates.check": () => Promise<UpdaterState>;
  /** Fecha, troca e reabre. Devolve `false` quando não há versão baixada. */
  "updates.apply": () => Promise<boolean>;

  /**
   * Em que idioma a janela fala.
   *
   * A etiqueta do sistema só existe do lado do Electron, então a janela não
   * tem como resolver isso sozinha: ela pergunta, e quem responde já aplicou a
   * preferência guardada por cima do que a máquina disse. `setPreference`
   * devolve o estado novo para a janela trocar de idioma na hora, sem recarregar.
   */
  "i18n.state": () => Promise<WindowLanguage>;
  "i18n.setPreference": (language: Language | null) => Promise<WindowLanguage>;

  /** Run para onde o ultimo clique de notificacao mandou, ou nulo. */
  "window.inboxTarget": () => string | null;

  /**
   * O console em linguagem natural.
   *
   * `send` dispara e volta logo: a resposta chega em pedaco pelo canal de
   * evento, porque texto so aparecendo no fim vira silencio de meio minuto.
   * O catalogo de ferramentas do assistente e outro arquivo, escrito a mao, e
   * nao inclui aprovar: ele le diff e achado, que sao conteudo de terceiro.
   */
  "chat.status": () => Promise<{ disponivel: boolean; modelo: string | null; motivo?: string }>;
  "chat.setModel": (modelo: string) => Promise<void>;
  "chat.send": (texto: string, context?: { initiative?: string }) => Promise<void>;
  "chat.cancel": () => Promise<void>;
}

export type LocumApi = { [K in keyof ServiceApi]: Asyncify<ServiceApi[K]> };

/**
 * Os canais registrados, em ordem.
 *
 * A lista e escrita a mao porque o preload precisa dela em tempo de execucao e
 * tipo nao sobrevive ao build. O `setupBridge` confere que ela cobre a `LocumApi`
 * inteira e estoura na subida se alguem acrescentar um canal so de um lado.
 */
export const BRIDGE_CHANNELS = [
  "agents.list",
  "agents.get",
  "agents.versions",
  "agents.budgets",
  "agents.overview",
  "agents.saveEdited",
  "actions.describe",
  "agents.duplicate",
  "agents.importFile",
  "agents.exportFile",
  "agents.installReply",
  "agents.aiStatus",
  "agents.aiDraft",
  "agents.aiSave",
  "initiatives.list",
  "initiatives.detail",
  "initiatives.context",
  "initiatives.deliveries",
  "initiatives.overview",
  "initiatives.staleDays",
  "initiatives.setStaleDays",
  "initiatives.root",
  "initiatives.setRoot",
  "initiatives.upsert",
  "initiatives.setStatus",
  "initiatives.setServers",
  "initiatives.linkAgent",
  "initiatives.setWorkspaces",
  "initiatives.addLink",
  "initiatives.removeLink",
  "sessions.open",
  "sessions.readHandoff",
  "sessions.list",
  "sessions.close",
  "sessions.terminal",
  "sessions.setTerminal",
  "sessions.installedTerminals",
  "claudeSessions.list",
  "claudeSessions.markDone",
  "claudeSessions.reopen",
  "claudeSessions.resume",
  "prompts.list",
  "runs.list",
  "runs.get",
  "runs.findings",
  "runs.findingsByRun",
  "runs.rerunStep",
  "runs.start",
  "approvals.listPending",
  "approvals.listStuck",
  "approvals.get",
  "approvals.update",
  "approvals.updateText",
  "approvals.decide",
  "approvals.settleStuck",
  "mcp.list",
  "mcp.test",
  "mcp.tools",
  "mcp.setEnabled",
  "claudeAccount.list",
  "providers.list",
  "providers.fallbacks",
  "providers.preview",
  "providers.models",
  "providers.allModels",
  "providers.registered",
  "providers.register",
  "providers.remove",
  "providers.credentials",
  "providers.saveSecret",
  "providers.forgetSecret",
  "providers.checkSecret",
  "providers.prices",
  "providers.setPrice",
  "providers.removePrice",
  "credentials.overview",
  "github.status",
  "github.save",
  "github.forget",
  "github.check",
  "claudeCode.status",
  "claudeCode.connect",
  "connections.list",
  "connections.connect",
  "connections.disconnect",
  "connections.addCustom",
  "claudeImport.list",
  "claudeImport.apply",
  "connections.slackApp",
  "connections.connectSlack",
  "connections.disconnectSlack",
  "connections.openSlackManifest",
  "connections.teamsApp",
  "connections.connectTeams",
  "connections.disconnectTeams",
  "connections.teamsAdminConsent",
  "connections.setTeamsChannels",
  "connections.teamsChannels",
  "trackers.list",
  "trackers.register",
  "trackers.remove",
  "trackers.setEnabled",
  "trackers.setProject",
  "trackers.saveSecret",
  "trackers.forgetSecret",
  "trackers.test",
  "trackers.projects",
  "slack.get",
  "slack.setSource",
  "slack.addChannel",
  "slack.removeChannel",
  "metrics.report",
  "machine.profile",
  "triggers.list",
  "triggers.set",
  "triggers.remove",
  "triggers.setEnabled",
  "triggers.schedule",
  "automations.get",
  "automations.save",
  "automations.setEnabled",
  "automations.runNow",
  "automations.suggestId",
  "library.profiles",
  "library.profile",
  "library.profileVersions",
  "library.toolsets",
  "library.saveProfile",
  "library.removeProfile",
  "library.saveToolset",
  "library.removeToolset",
  "library.suggestId",
  "app.version",
  "startup.get",
  "startup.set",
  "updates.state",
  "updates.setEnabled",
  "updates.check",
  "updates.apply",
  "i18n.state",
  "i18n.setPreference",
  "window.inboxTarget",
  "chat.status",
  "chat.setModel",
  "chat.send",
  "chat.cancel",
] as const satisfies readonly (keyof LocumApi)[];

export type BridgeChannel = (typeof BRIDGE_CHANNELS)[number];

/**
 * Guarda de compilacao contra a ponte ganhar um canal que abre tarefa.
 *
 * Revisao humana esquece, e o `createIssue` do `TrackerService` esta a um
 * `"trackers.create"` de distancia de virar canal. Pela regra do marco, abrir
 * tarefa nunca e automatico: o unico caminho e o passo de acao, que nasce em
 * modo de aprovacao e para na fila. Se um canal desses entrar na lista acima, o
 * `Extract` deixa de ser `never` e o `npm run build` para antes de a janela
 * enxerga-lo.
 */
type SemAberturaDeTarefa = [
  Extract<BridgeChannel, `trackers.create${string}` | `trackers.issue${string}`>,
] extends [never]
  ? true
  : never;
const _semAberturaDeTarefa: SemAberturaDeTarefa = true;
void _semAberturaDeTarefa;

/**
 * A mesma guarda, para o Slack.
 *
 * Responder em thread e a acao do M8.4, e ela nasce parando na fila de
 * aprovacao. Um canal de janela que postasse seria um segundo caminho, sem fila
 * no meio, e a emenda 6 do ADR 0002 nao admite isso: nada sai sem uma pessoa
 * ter dito que sai. Se um canal desses entrar na lista acima, o `Extract` deixa
 * de ser `never` e o `npm run build` para antes de a janela enxerga-lo.
 */
type SemPublicacaoNoSlack = [
  Extract<BridgeChannel, `slack.post${string}` | `slack.send${string}` | `slack.reply${string}`>,
] extends [never]
  ? true
  : never;
const _semPublicacaoNoSlack: SemPublicacaoNoSlack = true;
void _semPublicacaoNoSlack;

type GroupOf<K extends string> = K extends `${infer G}.${string}` ? G : never;
type MemberOf<G extends string, K extends string> = K extends `${G}.${infer M}` ? M : never;

/** A mesma API, agrupada por prefixo, que e como a janela enxerga. */
export type LocumBridge = {
  [G in GroupOf<BridgeChannel>]: {
    [M in MemberOf<G, BridgeChannel>]: LocumApi[`${G}.${M}` & BridgeChannel];
  };
};

/**
 * Canal de mao unica, do processo principal para a janela.
 *
 * Fica fora de `BRIDGE_CHANNELS` porque nao e chamada com resposta: e fluxo.
 */
export const CHAT_EVENT_CHANNEL = "chat:event";

/** O nome sob o qual o preload pendura a ponte na janela. */
export const BRIDGE_GLOBAL = "locum";

declare global {
  interface Window {
    locum: LocumBridge;
  }
}
