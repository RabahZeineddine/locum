import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import {
  ACOES_POR_PARAMETRO,
  anteriores,
  catalogoDoPasso,
  componenteDoPasso,
  ehGatilho,
  numerarPassos,
  dispensarPendencia,
  FORMATOS,
  formatoDe,
  passoComAgent,
  passoSemAgent,
  trocarPasso,
  type AgentDaBiblioteca,
  type Formato,
  type PassoDeAcao,
  type PassoDeIA,
  type Problema,
  type Rascunho,
} from "@/lib/automacao";
import { call, useRead, type ReadResult } from "@/lib/bridge";
import { camposDoSchema } from "@/lib/formulario-de-schema";
import { humanizar, modoParaFerramenta } from "@/lib/paleta-conexoes";
import { ehLeituraNaAcao } from "../../../src/config/leitura";
import { chaveDaListaDoSlack, chaveDaListaDoTeams } from "@/lib/cache-de-lista";
import { organizarCanais } from "@/lib/canais-do-teams";
import { canalDoSlackDigitado, opcoesDeCanaisDoSlack, rotuloDoChipDoSlack } from "@/lib/canais-do-slack";
import { organizarChats } from "@/lib/chats-do-teams";
import { cn } from "@/lib/utils";
import { Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LogicCompare, type LogicStep, type TriggerConfig } from "../../../src/config/types";
import { codigoDoErroDeCanais } from "../../../src/slack/channels-erro";
import { parseCron, proximaOcorrencia } from "../../../src/triggers/cron";
import { PROVEDORES_FORA_DO_FILTRO } from "../../../src/config/filtro-ia";
import { descreverCron } from "@/lib/descricao-do-cron";
import { resumoDoAgent } from "@/lib/resumo-do-agent";
import { SeletorDeFerramentas, SeletorDeModelo, useCatalogo } from "../editor-agent";
import type { RotaId } from "../rotas";
import { Ajuda, Alternador, Campo, CAMPO, Minutos } from "./campos";
import { CampoComVariaveis, VariaveisDoNo } from "./campo-com-variaveis";
import { esquemasDeSaidaDasConexoes, type FerramentasDasConexoes } from "./ferramentas-das-conexoes";
import { DestinoDoNo } from "./destino-do-no";
import { ACOES_DE_CONVERSA_REGISTRO } from "../../../src/acao/destino";
import { FormularioDaChamada } from "./formulario-da-chamada";
import { OQueFazer } from "./o-que-fazer";
import { TrocaDeOperacao } from "./troca-de-operacao";
import { passoDaOperacao, reconhecerPasso, temTrocaDeOperacao } from "@/lib/apps-da-paleta";
import { ComboboxComChips, useListaEmCache, type OpcaoDoCombobox } from "./combobox";
import { GatilhoDoGithub, ListaDeDescartes } from "./gatilho-github";
import { escopoDoGatilho } from "@/lib/titulo-do-gatilho";
import { appDoGatilho, appDoPasso, NumeroDoPasso, Selo, tituloDoGatilho, tituloDoPasso } from "./visual";

type Tracker = ReadResult<"trackers.list">[number];

const PRESETS_DE_CRON = [
  ["weekdays9", "0 9 * * 1-5"],
  ["daily8", "0 8 * * *"],
  ["hourly", "0 * * * *"],
  ["monday9", "0 9 * * 1"],
] as const;

/**
 * O painel do nó selecionado. Mexe só no rascunho: nada grava até o Salvar do
 * cabeçalho, e por isso fechar o painel não perde o que foi escrito.
 */
export function PainelDoNo({
  chave,
  rascunho,
  setRascunho,
  trackers,
  agents,
  problemas,
  remover,
  fechar,
  navegar,
  abrirAgent,
  relerBiblioteca,
  conexoes,
  saidas,
  avisoDoApp,
}: {
  chave: string;
  conexoes: FerramentasDasConexoes;
  /** "conecte em Conexões" para um app do Locum desconectado, ou nada. */
  avisoDoApp: (app: string) => string | null;
  /** A saída de cada passo no último run, para o seletor de referências. */
  saidas: Readonly<Record<string, unknown>>;
  agents: readonly AgentDaBiblioteca[];
  navegar: (id: RotaId, detalhe?: string) => void;
  /** Abre o agent da biblioteca num modal, sem sair do editor. */
  abrirAgent: AbrirAgent;
  relerBiblioteca: () => Promise<void>;
  rascunho: Rascunho;
  setRascunho: (f: (r: Rascunho) => Rascunho) => void;
  trackers: readonly Tracker[];
  problemas: readonly Problema[];
  remover: () => void;
  fechar: () => void;
}) {
  const { t, i18n } = useTranslation();
  const gatilho = ehGatilho(chave) ? rascunho.gatilhos.find((g) => g.chave === chave) : undefined;
  const passo = ehGatilho(chave) ? undefined : rascunho.spec.steps.find((p) => p.key === chave);
  const acoes = useRead("actions.describe").data;
  const grupos = useMemo(
    () =>
      passo === undefined
        ? []
        : catalogoDoPasso(rascunho, chave, {
            saidas,
            esquemasDeSaida: esquemasDeSaidaDasConexoes(conexoes.porServidor),
            esquemasDeAcao: Object.fromEntries((acoes ?? []).map((a) => [a.kind, a.outputSchema])),
          }),
    // O catálogo só depende dos passos e dos gatilhos: nome do fluxo ou posição no canvas não o refazem.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rascunho.spec.steps, rascunho.gatilhos, chave, passo, saidas, conexoes.porServidor, acoes],
  );
  if (gatilho === undefined && passo === undefined) return null;

  // A descrição longa do componente vai no ⓘ do cabeçalho, e não num parágrafo acima dos campos.
  const chaveDaAjuda = gatilho !== undefined ? `automations.triggers.${gatilho.config.kind}.help` : `automations.steps.${componenteDoPasso(passo!)}.description`;
  const ajudaDoNo = i18n.exists(chaveDaAjuda) ? t(chaveDaAjuda) : null;

  const cabecalho =
    gatilho !== undefined
      ? { app: appDoGatilho(gatilho.config.kind), id: gatilho.config.kind, titulo: tituloDoGatilho(t, gatilho.config), escopo: escopoDoGatilho(t, gatilho.config) }
      : (() => {
          const id = componenteDoPasso(passo!);
          return { app: appDoPasso(id), id, titulo: tituloDoPasso(t, id), escopo: "" };
        })();

  const trocarGatilho = (config: TriggerConfig): void =>
    setRascunho((r) => ({ ...r, gatilhos: r.gatilhos.map((g) => (g.chave === chave ? { ...g, config } : g)) }));

  return (
    <VariaveisDoNo value={grupos}>
    <aside
      className={cn(
        "border-border bg-card flex shrink-0 flex-col gap-4 overflow-y-auto rounded-lg border p-3",
        gatilho?.config.kind === "poll" ? "w-[26rem]" : "w-80",
      )}
      data-locum-probe="automacao-painel"
      data-locum-painel={chave}
    >
      <div className="flex items-center gap-2">
        {passo === undefined ? null : <NumeroDoPasso numero={numerarPassos(rascunho.spec.steps).get(chave) ?? 0} t={t} />}
        {passo !== undefined && passo.type === "action" && temTrocaDeOperacao(passo) ? (
          <>
            <TrocaDeOperacao
            avisoDoApp={avisoDoApp}
            conexoes={conexoes}
            passo={passo}
            spec={rascunho.spec}
            trocar={(novo) => setRascunho((r) => ({ ...r, spec: trocarPasso(r.spec, passo.key, novo) }))}
          />
          {ajudaDoNo === null ? null : <Ajuda texto={ajudaDoNo} />}
        </>
        ) : (
          <>
        <Selo app={cabecalho.app} id={cabecalho.id} tamanho="sm" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5 text-[13px] font-medium">
            <span className="truncate" title={cabecalho.titulo}>
              {cabecalho.titulo}
            </span>
            {ajudaDoNo === null ? null : <Ajuda texto={ajudaDoNo} />}
          </span>
          {cabecalho.escopo === "" ? null : (
            <span className="text-muted-foreground truncate text-[11px]" title={cabecalho.escopo}>
              {cabecalho.escopo}
            </span>
          )}
        </span>
          </>
        )}
        <button
          aria-label={t("automations.panel.close")}
          className="text-muted-foreground hover:text-foreground cursor-pointer rounded p-1"
          onClick={fechar}
          type="button"
        >
          <X className="size-4" />
        </button>
      </div>

      {problemas.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs">
          {problemas.map((p, i) => (
            <li className="text-muted-foreground flex items-start gap-1.5" key={i}>
              <StatusDot className="mt-1.5" estado={p.bloqueia ? "erro" : "aviso"} />
              <span>{t(p.chave, p.valores)}</span>
              {p.atalho === undefined ? null : (
                <button className="ml-2 cursor-pointer underline" onClick={() => navegar(p.atalho!.rota, p.atalho!.detalhe)} type="button">
                  {t("automations.problems.openConnection")}
                </button>
              )}
              {p.pendencia === undefined ? null : (
                <button
                  className="ml-2 cursor-pointer underline"
                  onClick={() => setRascunho((r) => ({ ...r, spec: dispensarPendencia(r.spec, p.pendencia!.onde, p.pendencia!.campo) }))}
                  title={t("automations.problems.pending.dismissHint")}
                  type="button"
                >
                  {t("automations.problems.pending.dismiss")}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {gatilho !== undefined ? (
        <>
          <ConfigDoGatilho agentId={rascunho.spec.id} chave={chave} config={gatilho.config} key={chave} navegar={navegar} trocar={trocarGatilho} triggerId={gatilho.id} />
          <Alternador
            ligado={gatilho.enabled}
            rotulo={t("automations.panel.enabled")}
            trocar={(enabled) =>
              setRascunho((r) => ({ ...r, gatilhos: r.gatilhos.map((g) => (g.chave === chave ? { ...g, enabled } : g)) }))
            }
          />
        </>
      ) : passo!.type === "model" ? (
        <ConfigDoPassoDeIA
          abrirAgent={abrirAgent}
          agents={agents}
          chave={chave}
          key={chave}
          passo={passo as PassoDeIA}
          rascunho={rascunho}
          relerBiblioteca={relerBiblioteca}
          setRascunho={setRascunho}
        />
      ) : passo!.type === "logic" ? (
        <ConfigDaLogica passo={passo as LogicStep} setRascunho={setRascunho} />
      ) : (
        <ConfigDaAcao
          avisoDoApp={avisoDoApp}
          conexoes={conexoes}
          passo={passo as PassoDeAcao}
          rascunho={rascunho}
          setRascunho={setRascunho}
          trackers={trackers}
        />
      )}

      <Button className="mt-auto cursor-pointer self-start" data-locum-painel-remover="" onClick={remover} size="sm" variant="ghost">
        <Trash2 className="size-4" />
        {t("automations.panel.remove")}
      </Button>
    </aside>
    </VariaveisDoNo>
  );
}

/* ----------------------------------------------------------------- gatilho */

function ConfigDoGatilho({
  agentId,
  chave,
  config,
  trocar,
  triggerId,
  navegar,
}: {
  agentId: string;
  chave: string;
  config: TriggerConfig;
  trocar: (c: TriggerConfig) => void;
  triggerId?: string;
  navegar: (id: RotaId, detalhe?: string) => void;
}) {
  const { t } = useTranslation();
  switch (config.kind) {
    case "cron":
      return <ConfigDoCron expressao={config.expression} trocar={(expression) => trocar({ ...config, expression })} />;
    case "schedule":
      return (
        <Minutos rotulo={t("automations.panel.everyMinutes")} valor={config.everyMinutes} trocar={(everyMinutes) => trocar({ ...config, everyMinutes })} />
      );
    case "slack-channel":
      return (
        <>
          <CanaisDoSlack canais={config.channels} navegar={navegar} trocar={(channels) => trocar({ ...config, channels })} />
          <Minutos rotulo={t("automations.panel.everyMinutes")} valor={config.everyMinutes} trocar={(everyMinutes) => trocar({ ...config, everyMinutes })} />
        </>
      );
    case "slack-inbox":
    case "teams-inbox":
      return (
        <>
          <Alternador
            ligado={config.mentions}
            rotulo={t(`automations.triggers.${config.kind}.mentions`)}
            trocar={(mentions) => trocar({ ...config, mentions })}
          />
          <Alternador
            ligado={config.dms}
            rotulo={t(`automations.triggers.${config.kind}.dms`)}
            trocar={(dms) => trocar({ ...config, dms })}
          />
          {config.kind === "teams-inbox" ? (
            <>
              <Alternador
                ligado={config.prLinks}
                rotulo={t("automations.triggers.teams-inbox.prLinks")}
                trocar={(prLinks) => trocar({ ...config, prLinks })}
              />
              {config.prLinks ? (
                <>
                  <Alternador
                    ligado={config.agruparPrs}
                    rotulo={t("automations.triggers.teams-inbox.groupPrs")}
                    trocar={(agruparPrs) => trocar({ ...config, agruparPrs })}
                  />
                  <p className="text-muted-foreground -mt-1 text-xs">{t("automations.triggers.teams-inbox.groupPrsHint")}</p>
                  <Campo ajuda={t("automations.triggers.teams-inbox.maxPrsHint")} rotulo={t("automations.triggers.teams-inbox.maxPrs")}>
                    <input
                      className={cn(CAMPO, "w-28")}
                      data-locum-max-prs=""
                      max={20}
                      min={1}
                      onChange={(e) => {
                        const n = Number.parseInt(e.target.value, 10);
                        if (Number.isFinite(n) && n >= 1 && n <= 20) trocar({ ...config, maxPrs: n });
                      }}
                      type="number"
                      value={config.maxPrs}
                    />
                  </Campo>
                </>
              ) : null}
              <FiltroComIa filtro={config.filtroIa} trocar={(filtroIa) => trocar(comFiltro(config, filtroIa))} />
              <ChatsDoTeams
                chats={config.chats}
                pendentes={config.chatsPendentes > 0}
                trocar={(chats) => trocar({ ...config, chats })}
                escopo={{ agentId, chave, ...(triggerId === undefined ? {} : { id: triggerId }) }}
                triggerId={triggerId}
                valeParaTodos={() => trocar({ ...config, chatsPendentes: 0 })}
              />
              <CanaisDoTeams canais={config.channels} trocar={(channels) => trocar({ ...config, channels })} />
              {triggerId === undefined ? null : (
                <Campo rotulo={t("automations.triggers.teams-inbox.discards")}>
                  <ListaDeDescartes triggerId={triggerId} />
                </Campo>
              )}
            </>
          ) : null}
          <Minutos rotulo={t("automations.panel.everyMinutes")} valor={config.everyMinutes} trocar={(everyMinutes) => trocar({ ...config, everyMinutes })} />
        </>
      );
    case "poll":
      return <GatilhoDoGithub config={config} key={triggerId ?? "novo"} trocar={trocar} triggerId={triggerId} />;
    default:
      return null;
  }
}

function ConfigDoCron({ expressao, trocar }: { expressao: string; trocar: (e: string) => void }) {
  const { t, i18n } = useTranslation();
  let erro: string | null = null;
  let proxima: number | null = null;
  try {
    proxima = proximaOcorrencia(parseCron(expressao), Date.now());
  } catch (e) {
    erro = e instanceof Error ? e.message : String(e);
  }
  const frase = descreverCron(expressao, t, i18n.language);
  return (
    <>
      <Campo rotulo={t("automations.triggers.cron.expression")}>
        <input
          className={cn(CAMPO, "font-mono", erro !== null && "border-destructive")}
          data-locum-cron=""
          onChange={(e) => trocar(e.target.value)}
          value={expressao}
        />
      </Campo>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS_DE_CRON.map(([id, valor]) => (
          <button
            className={cn(
              "border-border cursor-pointer rounded-full border px-2.5 py-0.5 text-xs transition-colors",
              valor === expressao ? "border-primary bg-primary/10" : "hover:border-foreground/30",
            )}
            key={id}
            onClick={() => trocar(valor)}
            type="button"
          >
            {t(`automations.triggers.cron.presets.${id}`)}
          </button>
        ))}
      </div>
      {erro === null && frase !== null && (
        <p className="text-[13px] font-medium" data-locum-cron-frase="">
          {frase}
        </p>
      )}
      <p className={cn("text-xs", erro === null ? "text-muted-foreground" : "text-destructive")}>
        {erro !== null
          ? t("automations.triggers.cron.invalid", { message: erro })
          : proxima === null
            ? t("automations.triggers.cron.never")
            : t("automations.triggers.cron.next", {
                when: new Date(proxima).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" }),
              })}
      </p>
    </>
  );
}

/**
 * Canais do Slack, escolhidos numa lista com busca, como os do Teams. A lista
 * vem da API do Slack com a conexão oficial e só carrega quando a pessoa abre o
 * campo. Um id digitado à mão continua valendo: o canal que a lista não traz
 * (ou a lista que não carregou) aparece como opção "usar este id".
 */
function CanaisDoSlack({
  canais,
  trocar,
  navegar,
}: {
  canais: readonly string[];
  trocar: (c: string[]) => void;
  navegar: (id: RotaId, detalhe?: string) => void;
}) {
  const { t } = useTranslation();
  const app = useRead("connections.slackApp").data;
  // A resposta inteira fica como único item da lista em cache: ela traz também o que é arquivado e o que não existe.
  const lista = useListaEmCache(chaveDaListaDoSlack(app), async () => [await call("connections.slackChannels", [...canais])]);
  const resposta = lista.dados?.[0] ?? null;
  const rotulosDoChip = { arquivado: t("automations.triggers.slack-channel.archived"), naoEncontrado: t("automations.triggers.slack-channel.notFound") };
  const rotulos = { privado: t("automations.triggers.slack-channel.private") };
  // Com a lista recusada ainda dá para digitar o id: o combobox abre vazio em vez de "carregando".
  const opcoes: OpcaoDoCombobox[] | null = resposta === null && lista.erro === null ? null : opcoesDeCanaisDoSlack(resposta?.canais ?? [], new Set(canais), "", rotulos);
  const codigo = lista.erro === null ? null : codigoDoErroDeCanais(lista.erro);

  return (
    <Campo ajuda={t("automations.triggers.slack-channel.hint")} rotulo={t("automations.triggers.slack-channel.channels")}>
      <ComboboxComChips
        aoAbrir={() => lista.pedir()}
        aoAlternar={(o) => trocar(canais.includes(o.id) ? canais.filter((c) => c !== o.id) : [...canais, o.id])}
        aoAtualizar={() => lista.pedir(true)}
        aoRemover={(id) => trocar(canais.filter((c) => c !== id))}
        carregando={lista.lendo}
        filtrar={(busca) => {
          const marcados = new Set(canais);
          const achadas = opcoesDeCanaisDoSlack(resposta?.canais ?? [], marcados, busca, rotulos);
          const digitado = canalDoSlackDigitado(busca, resposta?.canais ?? [], marcados);
          return digitado === null
            ? achadas
            : [...achadas, { id: digitado, rotulo: t("automations.triggers.slack-channel.useId", { id: digitado }) }];
        }}
        opcoes={opcoes}
        rotuloDaBusca={t("automations.triggers.slack-channel.search")}
        selecionados={canais.map((c) => ({ id: c, rotulo: rotuloDoChipDoSlack(c, resposta, rotulosDoChip) }))}
        sonda="slack-canais"
      />
      {resposta?.truncado === true ? (
        <p className="text-muted-foreground text-xs" data-locum-slack-truncado="">
          {t("automations.triggers.slack-channel.truncated", { count: resposta.total })}
        </p>
      ) : null}
      {lista.erro === null ? null : (
        <div className="text-destructive flex flex-col gap-1 text-xs">
          <p>{codigo === null ? lista.erro : t(`automations.triggers.slack-channel.error.${codigo}`)}</p>
          {codigo === "sem-conexao" || codigo === "sem-escopo" ? (
            <span className="flex gap-3">
              <button className="cursor-pointer underline" onClick={() => navegar("connections", "slack")} type="button">
                {t("automations.triggers.slack-channel.openConnections")}
              </button>
              {codigo === "sem-escopo" ? (
                <button className="cursor-pointer underline" onClick={() => void call("connections.openSlackManifest")} type="button">
                  {t("automations.triggers.slack-channel.openManifest")}
                </button>
              ) : null}
            </span>
          ) : null}
        </div>
      )}
    </Campo>
  );
}

type CanalDoTeams = Extract<TriggerConfig, { kind: "teams-inbox" }>["channels"][number];

/**
 * Canais de equipe do Teams. A lista vem do Graph, pede os escopos de canal que
 * a conexão pode não ter, e por isso só carrega quando a pessoa abre o campo.
 * Fica guardada por alguns minutos.
 */
function CanaisDoTeams({ canais, trocar }: { canais: readonly CanalDoTeams[]; trocar: (c: CanalDoTeams[]) => void }) {
  const { t } = useTranslation();
  // Pelo servidor MCP (ms365) os canais já vêm: a conexão nativa e os escopos dela não entram.
  const conexao = useRead("connections.list").data?.find((c) => c.id === "teams");
  const viaDoTeams = conexao?.via;
  const lista = useListaEmCache(chaveDaListaDoTeams("canais", conexao), () => call("connections.teamsChannels"));
  const idDe = (teamId: string, channelId: string): string => `${teamId}/${channelId}`;
  const opcoes: OpcaoDoCombobox[] | null =
    lista.dados === null
      ? null
      : lista.dados.map((o) => ({ id: idDe(o.teamId, o.channelId), rotulo: o.channelName, grupo: o.teamName }));
  const porId = new Map((lista.dados ?? []).map((o) => [idDe(o.teamId, o.channelId), o]));

  return (
    <Campo
      ajuda={
        viaDoTeams === undefined
          ? t("automations.triggers.teams-inbox.channelsHint")
          : t("automations.triggers.teams-inbox.channelsHintVia", { server: viaDoTeams })
      }
      rotulo={t("automations.triggers.teams-inbox.channels")}
    >
      <ComboboxComChips
        aoAbrir={() => lista.pedir()}
        aoAlternar={(o) => {
          const canal = porId.get(o.id);
          if (canal === undefined) return;
          const ja = canais.some((c) => idDe(c.teamId, c.channelId) === o.id);
          trocar(
            ja
              ? canais.filter((c) => idDe(c.teamId, c.channelId) !== o.id)
              : [...canais, { teamId: canal.teamId, channelId: canal.channelId, label: `${canal.teamName} / ${canal.channelName}` }],
          );
        }}
        aoAtualizar={() => lista.pedir(true)}
        aoRemover={(id) => trocar(canais.filter((c) => idDe(c.teamId, c.channelId) !== id))}
        carregando={lista.lendo}
        filtrar={(busca) => {
          const grupos = organizarCanais(lista.dados ?? [], new Set(canais.map((c) => idDe(c.teamId, c.channelId))), busca);
          return grupos.flatMap((g) => g.canais.map((o) => ({ id: idDe(o.teamId, o.channelId), rotulo: o.channelName, grupo: `${g.teamName} · ${t("automations.triggers.teams-inbox.countOf", { marked: g.marcados, total: g.canais.length })}` })));
        }}
        opcoes={opcoes}
        rotuloDaBusca={t("automations.triggers.teams-inbox.search")}
        selecionados={canais.map((c) => ({ id: idDe(c.teamId, c.channelId), rotulo: c.label ?? c.channelId }))}
        sonda="teams-canais"
      />
      {lista.erro === null ? null : <p className="text-destructive text-xs">{lista.erro}</p>}
    </Campo>
  );
}

/** O teto de `chats` no gatilho, o mesmo do esquema. */
const MAX_CHATS = 20;

type ChatDoTeams = Extract<TriggerConfig, { kind: "teams-inbox" }>["chats"][number];

/**
 * "Só nestes chats": restringe o gatilho a chats em grupo e diretos. Vazio é
 * todos. A lista vem do Graph e só chega por clique, como a de canais.
 */
type FiltroIaConfig = NonNullable<Extract<TriggerConfig, { kind: "teams-inbox" }>["filtroIa"]>;

/** O gatilho com o filtro trocado. Pergunta vazia tira o filtro: o campo some do cadastro em vez de gravar texto em branco. */
function comFiltro(
  config: Extract<TriggerConfig, { kind: "teams-inbox" }>,
  filtro: { pergunta: string; modelo?: string },
): TriggerConfig {
  const { filtroIa: _antes, ...resto } = config;
  return filtro.pergunta.trim() === "" ? resto : { ...resto, filtroIa: filtro };
}

/**
 * Pergunta que um modelo barato responde sobre cada mensagem que passou nos
 * filtros acima. Pergunta vazia é sem filtro. O modelo vazio é o Haiku que a
 * máquina tiver.
 */
function FiltroComIa({ filtro, trocar }: { filtro: FiltroIaConfig | undefined; trocar: (f: { pergunta: string; modelo?: string }) => void }) {
  const { t } = useTranslation();
  const catalogo = useCatalogo();
  const pergunta = filtro?.pergunta ?? "";
  // O modelo escolhido sobrevive a apagar a pergunta: sem pergunta o filtro sai do cadastro, e a pessoa volta a escrevê-la.
  const [modelo, setModelo] = useState(filtro?.modelo);
  return (
    <Campo ajuda={t("automations.triggers.teams-inbox.filtroIaHint")} rotulo={t("automations.triggers.teams-inbox.filtroIa")}>
      <textarea
        className={cn(CAMPO, "min-h-16 resize-y")}
        data-locum-filtro-ia=""
        maxLength={1000}
        onChange={(e) => trocar({ pergunta: e.target.value, ...(modelo === undefined ? {} : { modelo }) })}
        placeholder={t("automations.triggers.teams-inbox.filtroIaPlaceholder")}
        value={pergunta}
      />
      {pergunta.trim() === "" ? null : (
        <SeletorDeModelo
          automatico={t("automations.triggers.teams-inbox.filtroIaModeloAuto")}
          catalogo={catalogo}
          excluir={PROVEDORES_FORA_DO_FILTRO}
          trocar={(m) => {
            setModelo(m === "" ? undefined : m);
            trocar({ pergunta, ...(m === "" ? {} : { modelo: m }) });
          }}
          valor={modelo ?? ""}
        />
      )}
    </Campo>
  );
}

function ChatsDoTeams({
  chats,
  trocar,
  triggerId,
  escopo,
  pendentes,
  valeParaTodos,
}: {
  chats: readonly ChatDoTeams[];
  trocar: (c: ChatDoTeams[]) => void;
  triggerId?: string;
  escopo: { id?: string; agentId: string; chave: string };
  pendentes: boolean;
  valeParaTodos: () => void;
}) {
  const { t } = useTranslation();
  // A lista sai pela conta que o gatilho gravou, então cada gatilho tem a sua.
  const conexao = useRead("connections.list").data?.find((c) => c.id === "teams");
  const lista = useListaEmCache(chaveDaListaDoTeams("chats", conexao, escopo), () => call("connections.teamsChats", triggerId));
  const opcoes: OpcaoDoCombobox[] | null =
    lista.dados === null
      ? null
      : lista.dados.map((o) => ({ id: o.chatId, rotulo: o.label, detalhe: t(`automations.triggers.teams-inbox.chatType.${o.chatType}`) }));

  return (
    <Campo ajuda={t("automations.triggers.teams-inbox.chatsHint")} rotulo={t("automations.triggers.teams-inbox.chats")}>
      {pendentes && chats.length === 0 ? (
        <div className="flex flex-col items-start gap-1.5">
          <p className="text-xs text-amber-600 dark:text-amber-400">{t("automations.triggers.teams-inbox.chatsPending")}</p>
          <Button className="cursor-pointer" onClick={valeParaTodos} size="sm" variant="outline">
            {t("automations.triggers.teams-inbox.chatsAll")}
          </Button>
        </div>
      ) : null}
      <ComboboxComChips
        aoAbrir={() => lista.pedir()}
        aoAlternar={(o) =>
          trocar(chats.some((c) => c.chatId === o.id) ? chats.filter((c) => c.chatId !== o.id) : [...chats, { chatId: o.id, label: o.rotulo }])
        }
        aoAtualizar={() => lista.pedir(true)}
        aoRemover={(id) => trocar(chats.filter((c) => c.chatId !== id))}
        carregando={lista.lendo}
        filtrar={(busca) =>
          organizarChats(lista.dados ?? [], new Set(chats.map((c) => c.chatId)), busca).map((o) => ({
            id: o.chatId,
            rotulo: o.label,
            detalhe: t(`automations.triggers.teams-inbox.chatType.${o.chatType}`),
          }))
        }
        limite={MAX_CHATS}
        opcoes={opcoes}
        rotuloDaBusca={t("automations.triggers.teams-inbox.searchChats")}
        selecionados={chats.map((c) => ({ id: c.chatId, rotulo: c.label ?? c.chatId }))}
        sonda="teams-chats"
      />
      {lista.erro === null ? null : <p className="text-destructive text-xs">{lista.erro}</p>}
    </Campo>
  );
}

/* ------------------------------------------------------------------- passo */

/** Instrução com sugestão de variáveis ao digitar `{{` e o formato da saída: igual no agent e na IA avulsa. */
function TarefaEFormato({
  passo,
  trocar,
  rotulo,
  dica,
}: {
  passo: PassoDeIA;
  trocar: (novo: PassoDeIA) => void;
  rotulo: string;
  dica?: string;
}) {
  const { t } = useTranslation();
  const formato = formatoDe(passo);

  return (
    <>
      <Campo ajuda={dica} rotulo={rotulo}>
        <CampoComVariaveis
          className={cn(CAMPO, "min-h-40 resize-y font-mono text-xs leading-relaxed")}
          data-locum-prompt=""
          mudar={(prompt) => trocar({ ...passo, prompt })}
          tipo="textarea"
          valor={passo.prompt}
        />
      </Campo>
      <Campo rotulo={t("automations.steps.ai.format")}>
        <select
          className={CAMPO}
          onChange={(e) => {
            const f = e.target.value as Formato | "livre";
            const { outputSchema: _antigo, ...resto } = passo;
            trocar(f === "livre" ? resto : { ...resto, outputSchema: FORMATOS[f] });
          }}
          value={formato}
        >
          <option value="livre">{t("automations.steps.ai.formats.livre")}</option>
          {(Object.keys(FORMATOS) as Formato[]).map((f) => (
            <option key={f} value={f}>
              {t(`automations.steps.ai.formats.${f}`)}
            </option>
          ))}
          {formato === "outro" ? (
            <option disabled value="outro">
              {t("automations.steps.ai.formats.outro")}
            </option>
          ) : null}
        </select>
      </Campo>
    </>
  );
}

type AbrirAgent = (detalhe: string, aoFechar?: (id: string | null, lista: ReadResult<"library.profiles">) => void) => void;

/**
 * Passo de IA. O padrão é chamar um agent da biblioteca, que traz modelo,
 * instruções e ferramentas, e o texto do passo vira só a tarefa. A instrução
 * embutida continua como alternativa. Um passo que já tem texto ou ferramentas
 * próprias abre na instrução embutida, para o painel não esconder o que existe.
 */
function ConfigDoPassoDeIA({
  chave,
  passo,
  rascunho,
  setRascunho,
  agents,
  abrirAgent,
  relerBiblioteca,
}: {
  chave: string;
  passo: PassoDeIA;
  rascunho: Rascunho;
  setRascunho: (f: (r: Rascunho) => Rascunho) => void;
  agents: readonly AgentDaBiblioteca[];
  abrirAgent: AbrirAgent;
  relerBiblioteca: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [modo, setModo] = useState<"agent" | "inline">(
    passo.profile !== undefined || (passo.prompt.trim() === "" && passo.tools === undefined) ? "agent" : "inline",
  );
  const trocar = (novo: PassoDeIA): void => setRascunho((r) => ({ ...r, spec: trocarPasso(r.spec, passo.key, novo) }));
  const paraEmbutida = (): void => {
    setModo("inline");
    if (passo.profile === undefined) return;
    trocar(passoSemAgent(passo));
  };

  return (
    <>
      <div className="bg-muted flex gap-0.5 rounded-md p-0.5" data-locum-passo-modos="" role="tablist">
        {(["agent", "inline"] as const).map((m) => (
          <button
            aria-selected={modo === m}
            className={cn(
              "flex-1 cursor-pointer rounded px-2 py-1 text-xs transition-colors",
              modo === m ? "bg-card text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
            )}
            data-locum-passo-modo={m}
            key={m}
            onClick={() => (m === "inline" ? paraEmbutida() : setModo("agent"))}
            role="tab"
            type="button"
          >
            {t(`automations.steps.agent.modes.${m}`)}
          </button>
        ))}
      </div>
      {modo === "agent" ? (
        <ConfigDoAgent abrirAgent={abrirAgent} agents={agents} chave={chave} passo={passo} rascunho={rascunho} setRascunho={setRascunho} />
      ) : (
        <ConfigDaIA chave={chave} passo={passo} rascunho={rascunho} relerBiblioteca={relerBiblioteca} setRascunho={setRascunho} />
      )}
    </>
  );
}

/** Passo com agent da biblioteca: quem trabalha vem de lá, a tarefa é daqui. */
function ConfigDoAgent({
  chave,
  passo,
  rascunho,
  setRascunho,
  agents,
  abrirAgent,
}: {
  chave: string;
  passo: PassoDeIA;
  rascunho: Rascunho;
  setRascunho: (f: (r: Rascunho) => Rascunho) => void;
  agents: readonly AgentDaBiblioteca[];
  abrirAgent: AbrirAgent;
}) {
  const { t } = useTranslation();
  const trocar = (novo: PassoDeIA): void => setRascunho((r) => ({ ...r, spec: trocarPasso(r.spec, passo.key, novo) }));
  const atual = agents.find((a) => a.id === passo.profile);
  const escolher = (escolhido: AgentDaBiblioteca): void => {
    trocar(passoComAgent(passo, escolhido, atual?.name ?? ""));
  };

  return (
    <>
      <Campo rotulo={t("automations.steps.agent.choose")}>
        {agents.length === 0 ? null : (
          <select
            className={CAMPO}
            data-locum-passo-agent=""
            onChange={(e) => {
              const escolhido = agents.find((a) => a.id === e.target.value);
              if (escolhido !== undefined) escolher(escolhido);
            }}
            value={passo.profile ?? ""}
          >
            {passo.profile === undefined ? (
              <option disabled value="">
                {t("automations.steps.agent.pick")}
              </option>
            ) : atual === undefined ? (
              <option value={passo.profile}>{passo.profile}</option>
            ) : null}
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        {agents.length === 0 ? <p className="text-muted-foreground text-xs">{t("automations.steps.agent.none")}</p> : null}
        {passo.profile === undefined ? (
          <p className="text-muted-foreground text-xs" data-locum-passo-ainda-embutido="">
            {t("automations.steps.agent.stillInline")}
          </p>
        ) : null}
        <div className="flex gap-1.5">
          <Button
            className="cursor-pointer"
            data-locum-passo-criar-agent=""
            onClick={() =>
              abrirAgent("novo", (id, lista) => {
                const criado = lista.find((a) => a.id === id);
                if (criado !== undefined) escolher(criado);
              })
            }
            size="sm"
            variant="outline"
          >
            {t("automations.steps.agent.create")}
          </Button>
          {atual === undefined ? null : (
            <Button className="cursor-pointer" data-locum-passo-abrir-agent="" onClick={() => abrirAgent(atual.id)} size="sm" variant="outline">
              {t("automations.steps.agent.open")}
            </Button>
          )}
        </div>
      </Campo>
      {atual === undefined ? null : <ResumoDoAgent abrirAgent={abrirAgent} id={atual.id} />}
      <Campo rotulo={t("automations.panel.name")}>
        <input className={CAMPO} onChange={(e) => trocar({ ...passo, name: e.target.value })} value={passo.name} />
      </Campo>
      <TarefaEFormato
        dica={t("automations.steps.agent.taskHint")}
        passo={passo}
        rotulo={t("automations.steps.agent.task")}
        trocar={trocar}
      />
    </>
  );
}

/** Modelo, ferramentas e um trecho das instruções do agent escolhido, só leitura. */
function ResumoDoAgent({ id, abrirAgent }: { id: string; abrirAgent: AbrirAgent }) {
  const { t } = useTranslation();
  const lido = useRead("library.profile", id);
  if (lido.data === undefined || lido.data === null) return null;
  const r = resumoDoAgent(lido.data.spec);
  const ferramentas = r.conexoes.length + r.avulsas + r.toolsets;
  return (
    <div className="border-border bg-background/40 flex flex-col gap-2 rounded-md border p-2.5 text-xs" data-locum-agent-resumo={id}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">{t("automations.steps.agent.summary.model")}</dt>
        <dd className="truncate font-mono" title={lido.data.spec.model}>
          {r.modelo}
        </dd>
        <dt className="text-muted-foreground">{t("automations.steps.agent.summary.tools")}</dt>
        <dd className="flex min-w-0 flex-wrap gap-1">
          {ferramentas === 0 ? (
            <span className="text-muted-foreground">{t("automations.steps.agent.summary.noTools")}</span>
          ) : (
            <>
              {r.conexoes.map((c) => (
                <span className="bg-muted rounded px-1.5 py-0.5 font-mono text-[11px]" key={c.id}>
                  {c.ferramentas > 0 ? `${c.id} · ${c.ferramentas}` : c.id}
                </span>
              ))}
              {r.avulsas > 0 ? <span className="bg-muted rounded px-1.5 py-0.5 text-[11px]">{t("automations.steps.agent.summary.single", { count: r.avulsas })}</span> : null}
              {r.toolsets > 0 ? <span className="bg-muted rounded px-1.5 py-0.5 text-[11px]">{t("automations.steps.agent.summary.toolsets", { count: r.toolsets })}</span> : null}
            </>
          )}
        </dd>
      </dl>
      {r.trecho === "" ? null : (
        <p className="text-muted-foreground line-clamp-6 whitespace-pre-wrap" data-locum-agent-instrucoes="">
          {r.trecho}
        </p>
      )}
      <button className="text-primary w-fit cursor-pointer hover:underline" onClick={() => abrirAgent(id)} type="button">
        {t("automations.steps.agent.summary.edit")}
      </button>
    </div>
  );
}

function ConfigDaIA({
  chave,
  passo,
  rascunho,
  setRascunho,
  relerBiblioteca,
}: {
  chave: string;
  passo: PassoDeIA;
  rascunho: Rascunho;
  setRascunho: (f: (r: Rascunho) => Rascunho) => void;
  relerBiblioteca: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const catalogo = useCatalogo();
  const [levando, setLevando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const trocar = (novo: PassoDeIA): void => setRascunho((r) => ({ ...r, spec: trocarPasso(r.spec, passo.key, novo) }));

  // O agent nasce com o que é de quem trabalha (modelo, ferramentas, limite de
  // passos); a instrução fica no passo como tarefa, porque cita o evento e os
  // passos anteriores deste fluxo e não faria sentido em outro.
  const levarParaBiblioteca = async (): Promise<void> => {
    setLevando(true);
    setErro(null);
    try {
      const id = await call("library.suggestId", passo.name, "profile");
      await call("library.saveProfile", {
        spec: {
          id,
          name: passo.name,
          model: passo.model,
          tools: passo.tools ?? rascunho.spec.defaultTools,
          maxSteps: passo.maxSteps,
        },
        create: true,
      });
      await relerBiblioteca();
      const { tools: _tools, ...resto } = passo;
      trocar({ ...resto, profile: id });
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setLevando(false);
    }
  };

  return (
    <>
      <Campo rotulo={t("automations.panel.name")}>
        <input className={CAMPO} onChange={(e) => trocar({ ...passo, name: e.target.value })} value={passo.name} />
      </Campo>
      <Campo rotulo={t("automations.steps.ai.model")}>
        <SeletorDeModelo catalogo={catalogo} trocar={(model) => trocar({ ...passo, model })} valor={passo.model} />
      </Campo>
      <TarefaEFormato passo={passo} rotulo={t("automations.steps.ai.prompt")} trocar={trocar} />
      <Campo rotulo={t("automations.steps.ai.tools")}>
        <SeletorDeFerramentas
          defaultTools={rascunho.spec.defaultTools}
          trocar={(tools) => {
            const { tools: _antigas, ...resto } = passo;
            trocar(tools === undefined ? resto : { ...resto, tools });
          }}
          valor={passo.tools}
        />
      </Campo>
      <div className="border-border flex flex-col gap-1.5 border-t pt-3">
        <div className="flex items-center gap-1.5">
        <Button
          className="cursor-pointer self-start"
          data-locum-levar-para-biblioteca=""
          disabled={levando || passo.name.trim() === ""}
          onClick={() => void levarParaBiblioteca()}
          size="sm"
          variant="outline"
        >
          {t("automations.steps.agent.toLibrary")}
        </Button>
        <Ajuda texto={t("automations.steps.agent.toLibraryHint")} />
        </div>
        {erro === null ? null : <p className="text-destructive text-xs">{erro}</p>}
      </div>
    </>
  );
}

function ConfigDaAcao({
  passo,
  rascunho,
  setRascunho,
  trackers,
  conexoes,
  avisoDoApp,
}: {
  passo: PassoDeAcao;
  avisoDoApp: (app: string) => string | null;
  rascunho: Rascunho;
  setRascunho: (f: (r: Rascunho) => Rascunho) => void;
  trackers: readonly Tracker[];
  conexoes: FerramentasDasConexoes;
}) {
  const { t } = useTranslation();
  const trocar = (novo: PassoDeAcao): void => setRascunho((r) => ({ ...r, spec: trocarPasso(r.spec, passo.key, novo) }));
  const antes = anteriores(rascunho.spec, passo.key);
  const doModelo = antes.filter((k) => rascunho.spec.steps.find((p) => p.key === k)?.type === "model");

  return (
    <>
      <Campo rotulo={t("automations.panel.name")}>
        <input className={CAMPO} onChange={(e) => trocar({ ...passo, name: e.target.value })} value={passo.name} />
      </Campo>
      {ACOES_POR_PARAMETRO.has(passo.action) ? null : (
        <Campo rotulo={t("automations.panel.input")}>
          <select
            className={CAMPO}
            onChange={(e) => {
              const { input: _antigo, ...resto } = passo;
              trocar(e.target.value === "" ? resto : { ...resto, input: e.target.value });
            }}
            value={passo.input ?? ""}
          >
            <option value="">{t("automations.panel.inputNone")}</option>
            {doModelo.map((k) => (
              <option key={k} value={k}>
                {rascunho.spec.steps.find((p) => p.key === k)?.name ?? k}
              </option>
            ))}
          </select>
        </Campo>
      )}
      {passo.action === "mcp.call" && reconhecerPasso(passo).operacao.tipo === "vazia" && reconhecerPasso(passo).app !== "mcp" ? (
        <OQueFazer
          app={reconhecerPasso(passo).app}
          avisoDoApp={avisoDoApp}
          conexoes={conexoes}
          aoEscolher={(operacao) => trocar(passoDaOperacao(rascunho.spec, operacao, passo) as PassoDeAcao)}
        />
      ) : null}
      {passo.action === "mcp.call" && (reconhecerPasso(passo).operacao.tipo !== "vazia" || reconhecerPasso(passo).app === "mcp") ? <ConfigDaChamada conexoes={conexoes} passo={passo} trocar={trocar} /> : null}
      {passo.action === "http.request" ? <ConfigDoHttp passo={passo} trocar={trocar} /> : null}
      {ACOES_DE_CONVERSA_REGISTRO[passo.action] !== undefined ? (
        <DestinoDoNo
          acao={passo.action}
          agentId={rascunho.spec.id}
          aoMudar={(params) => trocar({ ...passo, params })}
          chave={passo.key}
          gatilhos={rascunho.gatilhos.map((g) => g.config.kind)}
          params={passo.params}
        />
      ) : null}
      {passo.action === "teams.react" || passo.action === "slack.react" ? (
        <ConfigDaReacao passo={passo} rascunho={rascunho} trocar={trocar} />
      ) : null}
      {passo.action === "tracker.create_issue" ? (
        <Campo rotulo={t("automations.steps.tracker.create_issue.tracker")}>
          {trackers.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t("automations.steps.tracker.create_issue.none")}</p>
          ) : (
            <select
              className={CAMPO}
              onChange={(e) => {
                const { target: _antigo, ...resto } = passo;
                trocar(e.target.value === "" ? resto : { ...resto, target: e.target.value });
              }}
              value={passo.target ?? ""}
            >
              <option value="">{t("automations.steps.tracker.create_issue.choose")}</option>
              {trackers.map((tr) => (
                <option key={tr.id} value={tr.id}>
                  {tr.label}
                </option>
              ))}
            </select>
          )}
        </Campo>
      ) : null}
      <ModoDaAcao passo={passo} trocar={trocar} />
    </>
  );
}

/**
 * Aprovar ou automático. Os modos vêm do próprio handler: ação que só aceita
 * aprovação (abrir tarefa, por exemplo) mostra o aviso e não oferece troca.
 */
function ModoDaAcao({ passo, trocar }: { passo: PassoDeAcao; trocar: (novo: PassoDeAcao) => void }) {
  const { t } = useTranslation();
  const descricao = useRead("actions.describe");
  const modos = descricao.data?.find((d) => d.kind === passo.action)?.modes ?? ["approve"];
  const oferecidos = modos.filter((m) => m !== "draft" || passo.action === "github.review_comment");
  return (
    <Campo rotulo={t("automations.panel.mode")}>
      {oferecidos.length > 1 ? (
        <div className="flex gap-1.5">
          {oferecidos.map((m) => (
            <button
              aria-pressed={passo.mode === m}
              className={cn(
                "border-border cursor-pointer rounded-full border px-3 py-1 text-xs transition-colors",
                passo.mode === m ? "border-primary bg-primary/10" : "hover:border-foreground/30",
              )}
              data-locum-modo={m}
              key={m}
              onClick={() => trocar({ ...passo, mode: m })}
              type="button"
            >
              {t(`automations.panel.modes.${m}`)}
            </button>
          ))}
        </div>
      ) : null}
      {passo.mode === "auto" ? (
        <p className="text-destructive flex items-start gap-1.5 text-xs" data-locum-modo-auto="">
          <StatusDot className="mt-1" estado="erro" />
          {t("automations.panel.autoHint")}
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">
          {t(oferecidos.length > 1 ? "automations.panel.approval" : "automations.panel.approvalOnly")}
        </p>
      )}
    </Campo>
  );
}

/* ------------------------------------------------------------------ lógica */

/**
 * Decisão e transformação. O valor de entrada é sempre um texto com
 * marcadores; marcador sozinho chega como o valor cru (objeto, lista, número).
 */
function ConfigDaLogica({
  passo,
  setRascunho,
}: {
  passo: LogicStep;
  setRascunho: (f: (r: Rascunho) => Rascunho) => void;
}) {
  const { t } = useTranslation();
  const trocar = (novo: LogicStep): void => setRascunho((r) => ({ ...r, spec: trocarPasso(r.spec, passo.key, novo) }));
  const [novoCaso, setNovoCaso] = useState("");
  const comTitulo = passo.op === "slack.blocks" || passo.op === "teams.card";
  const semContra = passo.compare === "exists" || passo.compare === "empty";

  return (
    <>
      <Campo rotulo={t("automations.panel.name")}>
        <input className={CAMPO} onChange={(e) => trocar({ ...passo, name: e.target.value })} value={passo.name} />
      </Campo>
      {comTitulo ? (
        <Campo rotulo={t("automations.steps.logic.title")}>
          <CampoComVariaveis className={CAMPO} mudar={(title) => trocar({ ...passo, title })} valor={passo.title} />
        </Campo>
      ) : null}
      <Campo rotulo={t(`automations.steps.logic.${passo.op === "if" || passo.op === "switch" ? "look" : "input"}`)}>
        <CampoComVariaveis
          className={cn(CAMPO, "min-h-16 font-mono text-xs")}
          data-locum-logica-valor=""
          mudar={(value) => trocar({ ...passo, value })}
          tipo="textarea"
          valor={passo.value}
        />
      </Campo>
      {passo.op === "if" ? (
        <>
          <Campo ajuda={t("automations.steps.logic.ifHint")} rotulo={t("automations.steps.logic.compare")}>
            <select
              className={CAMPO}
              onChange={(e) => trocar({ ...passo, compare: e.target.value as LogicStep["compare"] })}
              value={passo.compare}
            >
              {LogicCompare.options.map((c) => (
                <option key={c} value={c}>
                  {t(`automations.steps.logic.compares.${c}`)}
                </option>
              ))}
            </select>
          </Campo>
          {semContra ? null : (
            <Campo rotulo={t("automations.steps.logic.against")}>
              <CampoComVariaveis className={cn(CAMPO, "font-mono text-xs")} mudar={(against) => trocar({ ...passo, against })} valor={passo.against} />
            </Campo>
          )}
        </>
      ) : null}
      {passo.op === "switch" ? (
        <Campo ajuda={t("automations.steps.logic.switchHint")} rotulo={t("automations.steps.logic.cases")}>
          <div className="flex flex-wrap gap-1.5">
            {passo.cases.map((c) => (
              <span className="bg-muted flex items-center gap-1 rounded-full py-0.5 pr-1 pl-2.5 text-xs" key={c}>
                {c}
                <button
                  aria-label={t("automations.steps.logic.removeCase", { value: c })}
                  className="hover:text-foreground text-muted-foreground cursor-pointer rounded-full p-0.5"
                  onClick={() => trocar({ ...passo, cases: passo.cases.filter((x) => x !== c) })}
                  type="button"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-1.5">
            <input
              className={CAMPO}
              onChange={(e) => setNovoCaso(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const v = novoCaso.trim();
                if (v === "" || v === "default" || passo.cases.includes(v)) return;
                trocar({ ...passo, cases: [...passo.cases, v] });
                setNovoCaso("");
              }}
              placeholder={t("automations.steps.logic.casePlaceholder")}
              value={novoCaso}
            />
            <Button
              className="cursor-pointer"
              disabled={novoCaso.trim() === "" || novoCaso.trim() === "default" || passo.cases.includes(novoCaso.trim())}
              onClick={() => {
                trocar({ ...passo, cases: [...passo.cases, novoCaso.trim()] });
                setNovoCaso("");
              }}
              size="sm"
              variant="outline"
            >
              {t("automations.steps.logic.addCase")}
            </Button>
          </div>
        </Campo>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------ ações por parâmetro */

function textoDoValor(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** Qualquer ferramenta de um app conectado, com o formulário gerado do schema dela. */
function ConfigDaChamada({
  passo,
  trocar,
  conexoes,
}: {
  passo: PassoDeAcao;
  trocar: (novo: PassoDeAcao) => void;
  conexoes: FerramentasDasConexoes;
}) {
  const { t } = useTranslation();
  const params = (passo.params ?? {}) as { server?: string; tool?: string; args?: Record<string, unknown>; autoEscrita?: boolean };
  const servidor = params.server ?? "";
  const estado = conexoes.porServidor[servidor];
  const lista = estado?.tools ?? null;
  const { carregar } = conexoes;

  // O cache guarda a lista da última leitura. Servidor que nunca foi lido sobe uma vez, ao ser escolhido.
  useEffect(() => {
    if (servidor !== "" && estado !== undefined && estado.tools === null && !estado.carregando && estado.erro === null) void carregar(servidor);
  }, [servidor, estado, carregar]);

  const mudar = (novo: Partial<typeof params>, nome?: string, modo?: PassoDeAcao["mode"]): void =>
    trocar({ ...passo, ...(nome === undefined ? {} : { name: nome }), ...(modo === undefined ? {} : { mode: modo }), params: { ...params, ...novo } });
  const escolhida = lista?.find((f) => f.name === params.tool);
  const campos = camposDoSchema(escolhida?.inputSchema);
  const args = params.args ?? {};
  const leitura = escolhida === undefined ? null : ehLeituraNaAcao(escolhida);

  return (
    <>
      <Campo rotulo={t("automations.steps.mcp.call.server")}>
        <select
          className={CAMPO}
          data-locum-acao-servidor=""
          onChange={(e) => mudar({ server: e.target.value, tool: "", args: {} })}
          value={servidor}
        >
          <option value="">{t("automations.steps.mcp.call.chooseServer")}</option>
          {(servidor !== "" && !conexoes.servidores.includes(servidor) ? [servidor, ...conexoes.servidores] : conexoes.servidores).map((nome) => (
            <option key={nome} value={nome}>
              {nome}
            </option>
          ))}
        </select>
      </Campo>
      {servidor === "" ? null : (
        <Campo rotulo={t("automations.steps.mcp.call.tool")}>
          {estado?.erro != null ? (
            <p className="text-destructive text-xs">{estado.erro}</p>
          ) : lista === null ? (
            <p className="text-muted-foreground text-xs">{t("automations.steps.mcp.call.loading")}</p>
          ) : (
            <div className="flex items-center gap-1.5">
              <select
                className={CAMPO}
                data-locum-acao-ferramenta=""
                onChange={(e) => {
                  const nova = lista.find((f) => f.name === e.target.value);
                  const nomePadrao = passo.name === "" || passo.name === "Ação em app";
                  // Trocar a ferramenta recalcula o modo, e `autoEscrita` não passa para a nova: é escolha da pessoa para aquela ferramenta.
                  const { autoEscrita: _antigo, ...resto } = params;
                  trocar({
                    ...passo,
                    ...(nova !== undefined && nomePadrao ? { name: humanizar(nova.name) } : {}),
                    mode: modoParaFerramenta(passo.mode, false, nova),
                    params: { ...resto, tool: e.target.value, args: {} },
                  });
                }}
                value={params.tool ?? ""}
              >
                <option value="">{t("automations.steps.mcp.call.chooseTool")}</option>
                {lista.map((f) => (
                  <option key={f.name} title={f.description} value={f.name}>
                    {f.name}
                  </option>
                ))}
              </select>
              <Button
                data-locum-acao-atualizar=""
                disabled={estado?.carregando === true}
                onClick={() => void carregar(servidor)}
                size="sm"
                title={t("automations.steps.mcp.call.refreshHint")}
                variant="ghost"
              >
                {t(estado?.carregando === true ? "automations.steps.mcp.call.refreshing" : "automations.steps.mcp.call.refresh")}
              </Button>
            </div>
          )}
          {escolhida === undefined ? null : (
            <p className="text-muted-foreground line-clamp-3 text-[11px]">
              <span className={cn("mr-1 rounded px-1 py-0.5 text-[10px]", leitura ? "bg-muted" : "bg-amber-500/15")}>
                {t(leitura ? "automations.palette.read" : "automations.palette.write")}
              </span>
              {escolhida.description}
            </p>
          )}
        </Campo>
      )}
      {escolhida === undefined || leitura === true ? null : (
        <div className="flex flex-col gap-1" data-locum-auto-escrita="">
          <Alternador
            ligado={params.autoEscrita === true}
            rotulo={t("automations.steps.mcp.call.autoWrite")}
            trocar={(v) => {
              const { autoEscrita: _antigo, ...resto } = params;
              trocar({ ...passo, ...(v ? {} : { mode: modoParaFerramenta(passo.mode, false, escolhida) }), params: v ? { ...resto, autoEscrita: true } : resto });
            }}
          />
          <p className="text-muted-foreground text-[11px]">
            {t(params.autoEscrita === true ? "automations.steps.mcp.call.autoWriteWarning" : "automations.steps.mcp.call.autoWriteHint")}
          </p>
        </div>
      )}
      {escolhida === undefined ? null : (
        <>
          <FormularioDaChamada key={`${servidor}/${params.tool ?? ""}`} args={args} campos={campos} mudar={(novo) => mudar({ args: novo })} />
        </>
      )}
    </>
  );
}

type ParamsDeReacao = {
  emoji?: string;
  operacao?: "set" | "unset";
  tirar?: string;
  porValor?: { de?: string; mapa?: Record<string, string>; padrao?: string };
};

/**
 * Reação na mensagem do evento: operação, emoji (fixo ou escolhido pelo valor
 * de um passo, como o veredito da revisão) e a reação que sai antes.
 */
function ConfigDaReacao({
  passo,
  rascunho,
  trocar,
}: {
  passo: PassoDeAcao;
  rascunho: Rascunho;
  trocar: (novo: PassoDeAcao) => void;
}) {
  const { t } = useTranslation();
  const params = (passo.params ?? {}) as ParamsDeReacao;
  const mudar = (novo: ParamsDeReacao): void => {
    const juntos: Record<string, unknown> = { ...params, ...novo };
    for (const k of Object.keys(juntos)) if (juntos[k] === undefined) delete juntos[k];
    trocar({ ...passo, params: juntos });
  };
  const [novoValor, setNovoValor] = useState("");
  const porValor = params.porValor;
  const mapa = Object.entries(porValor?.mapa ?? {});
  const aplicarMapa = (m: Record<string, string>): void => mudar({ porValor: { ...porValor, mapa: m } });

  return (
    <>
      <Campo rotulo={t("automations.steps.react.operation")}>
        <select
          className={CAMPO}
          data-locum-reacao-operacao=""
          onChange={(e) => mudar({ operacao: e.target.value === "unset" ? "unset" : "set" })}
          value={params.operacao ?? "set"}
        >
          <option value="set">{t("automations.steps.react.set")}</option>
          <option value="unset">{t("automations.steps.react.unset")}</option>
        </select>
      </Campo>
      <Campo rotulo={t("automations.steps.react.source")}>
        <select
          className={CAMPO}
          data-locum-reacao-fonte=""
          onChange={(e) =>
            e.target.value === "valor"
              ? mudar({ emoji: undefined, porValor: { de: "", mapa: {}, padrao: params.emoji ?? "" } })
              : mudar({ porValor: undefined, emoji: porValor?.padrao ?? "👀" })
          }
          value={porValor === undefined ? "fixo" : "valor"}
        >
          <option value="fixo">{t("automations.steps.react.fixed")}</option>
          <option value="valor">{t("automations.steps.react.byValue")}</option>
        </select>
      </Campo>
      {porValor === undefined ? (
        <Campo rotulo={t("automations.steps.react.emoji")}>
          <CampoComVariaveis className={CAMPO} data-locum-reacao-emoji="" mudar={(emoji) => mudar({ emoji })} valor={params.emoji ?? ""} />
        </Campo>
      ) : (
        <>
          <Campo ajuda={t("automations.steps.react.fromHint")} rotulo={t("automations.steps.react.from")}>
            <CampoComVariaveis
              className={cn(CAMPO, "font-mono text-xs")}
              data-locum-reacao-de=""
              mudar={(de) => mudar({ porValor: { ...porValor, de } })}
              placeholder={"{{steps.revisar.verdict}}" as string}
              valor={porValor.de ?? ""}
            />
          </Campo>
          <Campo rotulo={t("automations.steps.react.map")}>
            {mapa.map(([valor, emoji]) => (
              <div className="flex items-center gap-1.5" key={valor}>
                <span className="w-32 shrink-0 truncate font-mono text-xs">{valor}</span>
                <CampoComVariaveis
                  aria-label={t("automations.steps.react.emojiFor", { value: valor })}
                  className={CAMPO}
                  mudar={(novo) => aplicarMapa({ ...porValor.mapa, [valor]: novo })}
                  valor={emoji}
                />
                <button
                  aria-label={t("automations.steps.react.removeValue", { value: valor })}
                  className="text-muted-foreground hover:text-foreground cursor-pointer rounded p-1"
                  onClick={() => {
                    const { [valor]: _fora, ...resto } = porValor.mapa ?? {};
                    aplicarMapa(resto);
                  }}
                  type="button"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
            <div className="flex gap-1.5">
              <input
                className={cn(CAMPO, "font-mono text-xs")}
                onChange={(e) => setNovoValor(e.target.value)}
                placeholder={t("automations.steps.react.valuePlaceholder")}
                value={novoValor}
              />
              <Button
                className="cursor-pointer"
                disabled={novoValor.trim() === "" || novoValor.trim() in (porValor.mapa ?? {})}
                onClick={() => {
                  aplicarMapa({ ...porValor.mapa, [novoValor.trim()]: "" });
                  setNovoValor("");
                }}
                size="sm"
                variant="outline"
              >
                {t("automations.steps.react.addValue")}
              </Button>
            </div>
          </Campo>
          <Campo rotulo={t("automations.steps.react.fallback")}>
            <CampoComVariaveis className={CAMPO} mudar={(padrao) => mudar({ porValor: { ...porValor, padrao } })} valor={porValor.padrao ?? ""} />
          </Campo>
        </>
      )}
      {(params.operacao ?? "set") === "set" ? (
        <Campo ajuda={t("automations.steps.react.removeFirstHint")} rotulo={t("automations.steps.react.removeFirst")}>
          <CampoComVariaveis
            className={CAMPO}
            data-locum-reacao-tirar=""
            mudar={(tirar) => mudar({ tirar: tirar === "" ? undefined : tirar })}
            valor={params.tirar ?? ""}
          />
        </Campo>
      ) : null}
    </>
  );
}

const METODOS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Qualquer API: método, endereço, cabeçalhos e corpo, todos com marcadores. */
function ConfigDoHttp({
  passo,
  trocar,
}: {
  passo: PassoDeAcao;
  trocar: (novo: PassoDeAcao) => void;
}) {
  const { t } = useTranslation();
  const params = (passo.params ?? {}) as { method?: string; url?: string; headers?: Record<string, string>; body?: unknown };
  const mudar = (novo: Partial<typeof params>): void => trocar({ ...passo, params: { ...params, ...novo } });
  const cabecalhos = Object.entries(params.headers ?? {});
  const [novoCabecalho, setNovoCabecalho] = useState("");

  return (
    <>
      <div className="flex gap-1.5">
        <select className={cn(CAMPO, "w-28")} onChange={(e) => mudar({ method: e.target.value })} value={params.method ?? "POST"}>
          {METODOS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <CampoComVariaveis
          aria-label={t("automations.steps.http.request.url")}
          className={cn(CAMPO, "font-mono text-xs")}
          data-locum-http-url=""
          mudar={(url) => mudar({ url })}
          placeholder={t("automations.steps.http.request.urlPlaceholder")}
          valor={params.url ?? ""}
        />
      </div>
      <Campo ajuda={t("automations.steps.http.request.headersHint")} rotulo={t("automations.steps.http.request.headers")}>
        {cabecalhos.map(([nome, valor]) => {
          const aplicar = (v: string): void => mudar({ headers: { ...params.headers, [nome]: v } });
          return (
            <div className="flex items-center gap-1.5" key={nome}>
              <span className="w-28 shrink-0 truncate font-mono text-xs">{nome}</span>
              <CampoComVariaveis className={cn(CAMPO, "font-mono text-xs")} mudar={aplicar} valor={valor} />
              <button
                aria-label={t("automations.steps.http.request.removeHeader", { name: nome })}
                className="text-muted-foreground hover:text-foreground cursor-pointer rounded p-1"
                onClick={() => {
                  const { [nome]: _fora, ...resto } = params.headers ?? {};
                  mudar({ headers: resto });
                }}
                type="button"
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
        <div className="flex gap-1.5">
          <input
            className={cn(CAMPO, "font-mono text-xs")}
            onChange={(e) => setNovoCabecalho(e.target.value)}
            placeholder={t("automations.steps.http.request.headerPlaceholder")}
            value={novoCabecalho}
          />
          <Button
            className="cursor-pointer"
            disabled={novoCabecalho.trim() === "" || novoCabecalho.trim() in (params.headers ?? {})}
            onClick={() => {
              mudar({ headers: { ...params.headers, [novoCabecalho.trim()]: "" } });
              setNovoCabecalho("");
            }}
            size="sm"
            variant="outline"
          >
            {t("automations.steps.http.request.addHeader")}
          </Button>
        </div>
      </Campo>
      {params.method === "GET" ? null : (
        <Campo ajuda={t("automations.steps.http.request.bodyHint")} rotulo={t("automations.steps.http.request.body")}>
          <CampoComVariaveis
            className={cn(CAMPO, "min-h-28 font-mono text-xs")}
            data-locum-http-corpo=""
            mudar={(body) => mudar({ body })}
            tipo="textarea"
            valor={textoDoValor(params.body)}
          />
        </Campo>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ campos */
