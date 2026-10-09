import { useEffect, useRef, useState } from "react";
import type {
  BridgeChannel,
  LocumApi,
  LocumBridge,
} from "../../electron/bridge-contract.js";

/**
 * O lado da janela da ponte.
 *
 * O import do contrato e so de tipo: nada de `electron/` vira codigo aqui. O
 * que existe em tempo de execucao e o `window.locum`, que o preload pendurou, e
 * este modulo e a unica porta do renderer para ele. Componente nenhum fala com
 * `window.locum` direto, porque entao cada tela inventaria o proprio tratamento
 * de erro e a propria forma de esperar.
 */

/**
 * O catalogo de leitura, escrito a mao, canal por canal.
 *
 * A emenda 5 do ADR 0003 existe por causa desta lista: derivar o catalogo
 * varrendo `BRIDGE_CHANNELS` seria mais curto e entregaria `approvals.decide`
 * a qualquer modelo que rode na janela, junto com todo canal de escrita que
 * aparecer depois. Acrescentar canal aqui e um ato, nao uma consequencia.
 *
 * Fora da lista de proposito: `approvals.decide`, que e o clique de uma pessoa
 * na inbox e passa pela gate; e `runs.rerunStep`, `triggers.set`,
 * `triggers.remove`, `triggers.setEnabled`, `startup.set`, `mcp.test` e
 * `mcp.tools`, que escrevem ou sobem processo e nao cabem num hook que dispara
 * sozinho ao montar a tela. O que dessas a janela ja pode pedir esta em
 * `ACTION_CHANNELS`, logo abaixo.
 *
 * `credentials.overview` esta aqui e nao la porque ela nao abre o cofre: ela
 * responde endereco e se ha valor guardado, que e o que a tela de configuracao
 * mostra. Valor de segredo nao tem canal, em lista nenhuma.
 */
export const READ_CHANNELS = [
  "agents.list",
  "agents.get",
  "agents.versions",
  "agents.budgets",
  "agents.overview",
  // Os templates do marketplace: leitura pura do disco, feita no processo
  // principal. Instalar vai por `agents.importTemplate`, entre as ações.
  "agents.templates",
  "actions.describe",
  // Lista, detalhe composto (servidores, workspaces, links, agents) e um
  // arquivo da pasta de contexto com hash. So leitura: mudar `context.md`
  // passa por `proposeContextUpdate`, fora de canal nenhum da janela.
  "initiatives.list",
  "initiatives.detail",
  "initiatives.context",
  // O que a iniciativa ja entregou, os `.md` de `entregas/`. So leitura.
  "initiatives.deliveries",
  // Fato cru de cada iniciativa, para o painel do Inicio: leitura pura, e a
  // tela dispara ao montar como as outras leituras do catalogo.
  "initiatives.overview",
  // O limite de dias parados, para a tela de configuracao mostrar o valor
  // gravado. Gravar vai por `initiatives.setStaleDays`, em ACTION_CHANNELS.
  "initiatives.staleDays",
  // Pasta raiz onde a pasta de contexto de cada iniciativa mora. Gravar vai
  // por `initiatives.setRoot`, em ACTION_CHANNELS.
  "initiatives.root",
  // O terminal preferido, so leitura. Gravar vai por `sessions.setTerminal`.
  "sessions.terminal",
  "sessions.installedTerminals",
  "sessions.list",
  // As sessões do Claude Code da máquina. Só lê `~/.claude`, nunca escreve.
  "claudeSessions.list",
  // Prompts salvos, para a aba de acoes da iniciativa copiar.
  "prompts.list",
  "runs.list",
  "runs.get",
  "runs.findings",
  "runs.findingsByRun",
  "approvals.listPending",
  // Paradas na publicação, para a fila mostrar. Resolver vai por
  // `approvals.settleStuck`, que mora em `lib/aprovar.ts` como `decide`.
  "approvals.listStuck",
  "approvals.get",
  "mcp.list",
  "mcp.usage",
  "mcp.toolsCached",
  "providers.list",
  "providers.fallbacks",
  "providers.preview",
  "credentials.overview",
  // Mesma razão de `credentials.overview`: endereço, sim ou não, e o que a
  // última conferência contou. Valor de chave não volta por canal nenhum.
  "providers.credentials",
  // O cadastro de gateway compatível: identificador, nome e endereço, que é
  // o que alguém escreveu. A chave dele não está aqui, e nem em canal nenhum.
  "providers.registered",
  // Preço por modelo, que é número digitado por alguém e nada de segredo.
  "providers.prices",
  // Mesma razão de `credentials.overview`: responde endereço, sim ou não e o
  // que a última conferência descobriu. O token não volta por canal nenhum.
  "github.status",
  // Se o Claude Code enxerga o Locum: lê o cadastro e procura o `claude`, sem
  // escrever nada. Ligar é o `claudeCode.connect`, que mora entre as ações.
  "claudeCode.status",
  "opencode.status",
  "grafana.list",
  "connections.list",
  // Só lê os arquivos do Claude Code, sem shell nem segredo.
  "claudeImport.origins",
  "connections.slackApp",
  "connections.teamsApp",
  // Mesma razão de `github.status`: endereço, sim ou não, e o que a última
  // conferência contou. A credencial do tracker não volta por canal nenhum, e
  // criar tarefa não tem canal em lista nenhuma.
  "trackers.list",
  // O que esta máquina observa no Slack: qual servidor MCP responde por ele e
  // quais canais entram na varredura. Não há credencial de Slack em canal
  // nenhum, porque quem tem a do Slack é o servidor MCP.
  "slack.get",
  "chat.status",
  // Se há quem escreva rascunho de agent, e qual modelo. Não chama modelo.
  "agents.aiStatus",
  "metrics.report",
  "machine.profile",
  "triggers.list",
  // A automação aberta no canvas: spec da última versão e gatilhos. Leitura
  // pura; gravar e ligar ficam entre as ações.
  "automations.get",
  "library.profiles",
  "library.profile",
  "library.profileVersions",
  "library.toolsets",
  // Cadastro e agenda, sem bater em gatilho nenhum: ler quando foi a última
  // varredura não dispara a próxima.
  "triggers.schedule",
  "scheduler.getWorkingHours",
  "startup.get",
  "app.version",
  // Versão instalada, a baixada e quando conferiu. Não pergunta ao GitHub.
  "updates.state",
  "i18n.state",
  "window.inboxTarget",
] as const satisfies readonly BridgeChannel[];

export type ReadChannel = (typeof READ_CHANNELS)[number];

/**
 * O catalogo de acao, tambem escrito a mao, e tambem canal por canal.
 *
 * Aqui mora o que a janela pode mandar fazer, e nao so perguntar. A lista e
 * separada da de leitura de proposito: quem le dispara sozinho ao montar a
 * tela, quem age precisa de alguem clicando, e misturar os dois num catalogo
 * so faria um hook de leitura alcancar escrita por descuido.
 *
 * Fora da lista, e pela mesma emenda 5 do ADR 0003 que rege a de leitura:
 * `approvals.decide`. Ela nao e uma acao da janela, e o clique de uma pessoa
 * na inbox, e chega ao processo principal por um caminho que a inbox monta,
 * nao por um catalogo que qualquer tela enxerga.
 *
 * `mcp.test` e `mcp.tools` estao aqui, e nao na lista de leitura, porque as
 * duas sobem o servidor que vao examinar. Numa tela que lista cadastros isso
 * significaria subir todo servidor registrado so de abrir o destino; atras de
 * um clique, sobe o que alguem pediu e so quando pediu.
 */
export const ACTION_CHANNELS = [
  "runs.rerunStep",
  // Rodar um agent num pull request digitado na tela. O run anda até o passo
  // de ação e para na fila de aprovação, como qualquer outro.
  "runs.start",
  // O token do GitHub indo para o keychain, e o único segredo que a janela
  // manda. Está aqui e não na leitura porque é escrita, e porque exige alguém
  // digitando: um hook que dispara ao montar a tela não tem o que gravar. A
  // viagem é de mão única, e a prova disso está no catálogo de leitura, onde
  // não existe canal que devolva valor de segredo.
  "github.save",
  "github.forget",
  // Conferir sai para a rede e responde quem é a conta, então fica atrás de um
  // clique pelo mesmo motivo de `mcp.test`: abrir a tela não é pedir exame.
  "github.check",
  // Cadastrar o Locum no Claude Code roda o `claude mcp add`: processo e
  // escrita no cadastro de outro programa, atrás de um clique.
  "claudeCode.connect",
  "opencode.connect",
  // Cadastrar e remover instância do Grafana: escrita no cadastro de
  // servidores e token no cofre, cada uma atrás de um clique.
  "grafana.save",
  "grafana.remove",
  "connections.connect",
  "connections.disconnect",
  "connections.addCustom",
  "claudeImport.list",
  "claudeImport.apply",
  "connections.connectSlack",
  "connections.disconnectSlack",
  "connections.openSlackManifest",
  "connections.connectTeams",
  "connections.disconnectTeams",
  "connections.teamsAdminConsent",
  // Ligar canais muda o que o próximo conectar pede, e listar canais vai ao
  // Graph: os dois atrás de um clique.
  "connections.setTeamsChannels",
  "connections.teamsChannels",
  // A chave de provedor indo para o keychain, e o exame que pergunta o
  // catálogo àquele provedor. Escrita e rede, os dois atrás de um clique, pelo
  // mesmo motivo dos canais do GitHub logo acima.
  "providers.saveSecret",
  "providers.forgetSecret",
  "providers.checkSecret",
  "mcp.test",
  "mcp.setCredential",
  "mcp.tools",
  "claudeAccount.list",
  "mcp.setEnabled",
  // O tracker de tarefa: cadastrar, apontar destino, guardar a credencial e
  // testar. Escrita e rede, as duas atrás de um clique, pelo mesmo motivo dos
  // canais do GitHub. Abrir tarefa não está aqui e não está em lugar nenhum:
  // o único caminho é o passo de ação, que para na fila de aprovação.
  "trackers.register",
  "trackers.remove",
  "trackers.setEnabled",
  "trackers.setProject",
  "trackers.saveSecret",
  "trackers.forgetSecret",
  "trackers.test",
  "trackers.projects",
  // O cadastro do Slack: escrita, e cada uma é um clique. Publicar no Slack não
  // está aqui e não está em lugar nenhum: responder em thread é passo de ação, e
  // ele para na fila de aprovação.
  "slack.setSource",
  "slack.addChannel",
  "slack.removeChannel",
  // Cadastrar e remover gateway compatível. Escrita, e cada uma é um clique:
  // remover ainda pede o segundo, porque sem `force` o serviço devolve onde o
  // provedor aparece em vez de apagar.
  "providers.register",
  "providers.remove",
  // Ligar e desligar provedor. Escrita, um clique, e desfaz no mesmo botão.
  "providers.setEnabled",
  // Gravar e apagar preço de modelo. Escrita, e cada uma é um clique.
  "providers.setPrice",
  "providers.removePrice",
  // Buscar catálogo bate na rede de cada provedor, então fica atrás de um
  // clique e não do carregamento da tela.
  "providers.models",
  "providers.allModels",
  "chat.setModel",
  "chat.send",
  "chat.cancel",
  "chat.history",
  "chat.reset",
  "terminal.list",
  "terminal.available",
  "terminal.openSession",
  "terminal.resume",
  "terminal.buffer",
  "terminal.write",
  "terminal.resize",
  "terminal.close",
  // Escolher o que observar, e ligar ou desligar a varredura. Cada um é um
  // clique de quem está usando, e o gatilho gravado nasce parado: ligar é o
  // segundo clique, e não uma consequência de ter cadastrado.
  "triggers.set",
  "triggers.remove",
  "triggers.setEnabled",
  "triggers.tick",
  "scheduler.setWorkingHours",
  // Instalar um template do marketplace é clique de quem está usando, e
  // grava um agent como o importar de arquivo faria.
  "agents.importTemplate",
  // O canvas grava spec e gatilhos juntos, e o gatilho novo nasce parado.
  // Ligar a automação e executar agora são cliques; executar agora para na
  // fila de aprovação no primeiro passo de ação, como qualquer run.
  "automations.save",
  "automations.setEnabled",
  "automations.runNow",
  "automations.suggestId",
  "library.saveProfile",
  "library.removeProfile",
  "library.saveToolset",
  "library.removeToolset",
  "library.suggestId",
  // Escolher idioma é um clique de quem está usando, e a escrita em `settings`
  // vale para a próxima subida também. Não é leitura de tela.
  "i18n.setPreference",
  // Conferir sai para o GitHub e aplicar fecha o aplicativo: os dois pedem
  // alguém clicando, e o interruptor é preferência de quem usa a máquina.
  "updates.setEnabled",
  "updates.check",
  "updates.apply",
  // Gravar o limite de dias parados e um clique na secao geral da
  // configuracao, nao uma leitura que dispara ao montar a tela.
  "initiatives.setStaleDays",
  "initiatives.setRoot",
  // Criar, editar e ligar iniciativa: cada um e um clique de um formulario,
  // nunca uma leitura que dispara ao montar a tela.
  "initiatives.upsert",
  "initiatives.setStatus",
  "initiatives.setServers",
  "initiatives.linkAgent",
  "initiatives.setWorkspaces",
  "initiatives.addLink",
  "initiatives.removeLink",
  // Abrir sessao sobe um terminal e ler a passagem cria pendencia: os dois sao
  // clique de quem usa, e o terminal preferido e preferencia gravada.
  "sessions.open",
  "sessions.readHandoff",
  "sessions.close",
  "sessions.setTerminal",
  // Marcar sessão do Claude Code como terminada, desfazer a marca e retomar
  // no terminal: preferência gravada e processo subindo, atrás de um clique.
  "claudeSessions.markDone",
  "claudeSessions.reopen",
  "claudeSessions.resume",
  // Rascunho de agent pela descrição: chama modelo e custa, então é clique. O
  // rascunho volta para a tela, e salvar é outro clique.
  "agents.aiDraft",
  "agents.aiSave",
] as const satisfies readonly BridgeChannel[];

export type ActionChannel = (typeof ACTION_CHANNELS)[number];

type AnyChannel = ReadChannel | ActionChannel;

export type ReadArgs<C extends AnyChannel> = Parameters<LocumApi[C]>;
export type ReadResult<C extends AnyChannel> = Awaited<ReturnType<LocumApi[C]>>;

/**
 * Guarda de compilacao contra o catalogo crescer para o lado errado.
 *
 * Revisao humana esquece; isto nao. Se `approvals.decide` entrar em
 * `READ_CHANNELS`, o `Extract` deixa de ser `never` e o `npm run build` para
 * antes de a janela enxergar o canal.
 */
type SemDecisao = [Extract<AnyChannel, "approvals.decide" | "approvals.settleStuck">] extends [never]
  ? true
  : never;
const _semDecisao: SemDecisao = true;
void _semDecisao;

/** O erro que este modulo devolve: sempre com mensagem legivel e o canal. */
export class BridgeError extends Error {
  constructor(
    readonly channel: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

function bridge(): LocumBridge {
  const exposta = globalThis.window?.locum;
  if (exposta === undefined) {
    throw new BridgeError("*", "a janela subiu sem a ponte, o preload nao rodou");
  }
  return exposta;
}

/**
 * Chama um canal de leitura e devolve o que o servico respondeu.
 *
 * O erro que vem do IPC chega como `Error` com a mensagem do lado de la
 * prefixada pelo Electron. Ele e reembalado com o nome do canal porque, sem
 * isso, uma tela com quatro leituras mostra "pendencia nao encontrada" sem
 * dizer de onde veio.
 */
async function invoke<C extends AnyChannel>(
  channel: C,
  ...args: ReadArgs<C>
): Promise<ReadResult<C>> {
  const [group, member] = channel.split(".") as [string, string];
  // O cast e a fronteira: o `window.locum` chega agrupado e indexar por string
  // perde o tipo. Quem sustenta a assinatura e o `ReadChannel` na entrada, que
  // so aceita canal do catalogo acima.
  const grupo = (bridge() as unknown as Record<string, Record<string, unknown>>)[group];
  const call = grupo?.[member] as ((...a: unknown[]) => Promise<ReadResult<C>>) | undefined;
  if (call === undefined) {
    throw new BridgeError(channel, `a ponte subiu sem o canal ${channel}`);
  }

  try {
    return await call(...args);
  } catch (erro) {
    throw new BridgeError(channel, erro instanceof Error ? erro.message : String(erro));
  }
}

export async function read<C extends ReadChannel>(
  channel: C,
  ...args: ReadArgs<C>
): Promise<ReadResult<C>> {
  return invoke(channel, ...args);
}

/**
 * Manda o processo principal fazer alguma coisa e espera o desfecho.
 *
 * E a mesma viagem de `read`, com outro catalogo na entrada. A funcao separada
 * nao e cerimonia: ela e o que impede um hook de leitura de aceitar canal de
 * escrita por engano, porque os dois tipos de canal nao se encontram em lugar
 * nenhum da assinatura.
 */
export async function call<C extends ActionChannel>(
  channel: C,
  ...args: ReadArgs<C>
): Promise<ReadResult<C>> {
  return invoke(channel, ...args);
}

export type ReadState<T> =
  | { status: "loading"; data: undefined; error: undefined }
  | { status: "ready"; data: T; error: undefined }
  | { status: "error"; data: undefined; error: BridgeError };

type InvalidationListener = (channel: string) => void;
const invalidationListeners = new Set<InvalidationListener>();

export function invalidateReads(channel?: string): void {
  for (const listener of invalidationListeners) {
    listener(channel ?? "*");
  }
}

/**
 * Le um canal ao montar e devolve o estado da leitura.
 *
 * Os argumentos entram na dependencia por JSON e nao por identidade: quem
 * chama passa objeto literal, que muda de referencia a cada render, e comparar
 * por identidade dispararia a leitura em laco.
 */
export function useRead<C extends ReadChannel>(
  channel: C,
  ...args: ReadArgs<C>
): ReadState<ReadResult<C>> {
  const [state, setState] = useState<ReadState<ReadResult<C>>>({
    status: "loading",
    data: undefined,
    error: undefined,
  });
  const [version, setVersion] = useState(0);

  const chave = JSON.stringify(args);
  // Sem a caixa, os argumentos entrariam na lista de dependencia do efeito e o
  // lint pediria o espalhamento, que traz a identidade de volta.
  const ultimos = useRef(args);
  ultimos.current = args;

  useEffect(() => {
    const onInvalidate: InvalidationListener = (invalidatedChannel) => {
      if (invalidatedChannel === "*" || invalidatedChannel === channel) {
        setVersion((v) => v + 1);
      }
    };
    invalidationListeners.add(onInvalidate);
    return () => {
      invalidationListeners.delete(onInvalidate);
    };
  }, [channel]);

  useEffect(() => {
    let vivo = true;
    setState({ status: "loading", data: undefined, error: undefined });

    read(channel, ...ultimos.current).then(
      (data) => {
        if (vivo) setState({ status: "ready", data, error: undefined });
      },
      (erro: unknown) => {
        if (!vivo) return;
        const embrulhado =
          erro instanceof BridgeError
            ? erro
            : new BridgeError(channel, erro instanceof Error ? erro.message : String(erro));
        setState({ status: "error", data: undefined, error: embrulhado });
      },
    );

    // O desmontar nao cancela o IPC, que nao tem cancelamento: ele so impede a
    // gravacao de estado em componente que ja saiu.
    return () => {
      vivo = false;
    };
  }, [channel, chave, version]);

  return state;
}
