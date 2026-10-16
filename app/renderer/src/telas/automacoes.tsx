import { CabecalhoDaTela } from "@/components/cabecalho-da-tela";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { ListGroup, ListRow } from "@/components/ui/list-row";
import { StatusDot } from "@/components/ui/status-dot";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { pontoDoEstado } from "@/lib/estado-do-ponto";
import { MODELOS, rascunhoDoModelo, type ModeloId } from "@/lib/automacao";
import { call, invalidateReads, read, useRead, type ReadResult } from "@/lib/bridge";
import {
  apagarProvisoria,
  guardarProvisoria,
  idSemProvisoria,
  lerProvisoria,
  limparReservasOrfas,
  listarProvisorias,
} from "@/lib/rascunho-automacao";
import { semPrefixoDoIpc } from "@/lib/erro-da-ponte";
import { rotuloDeEstado, rotuloDoErroDeRun } from "@/lib/rotulos";
import { cn } from "@/lib/utils";
import { Loader2, Play, Plus, Upload } from "lucide-react";
import { useEffect, useState, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TriggerConfig } from "../../../src/config/types";
import { EditorDeAutomacao } from "../automacoes/editor";
import { useExecutarAgora } from "../automacoes/executar-com";
import { ImportarPacote } from "../automacoes/importar-pacote";
import { linhaDoGatilho } from "@/lib/titulo-do-gatilho";
import { appDoGatilho, resumoDoGatilho, Selo } from "../automacoes/visual";
import { InstalacaoDeTemplate } from "../instalar-template";
import { AutomacoesLegado } from "./automacoes-legado";
import { useToasts } from "../toasts";
import type { TelaProps } from "../rotas";
import { useAcaoDaTela } from "@/lib/acao-da-tela";

type Linha = ReadResult<"agents.overview">[number];
type Template = ReadResult<"agents.templates">[number];

/** As abas da tela de Automações, na ordem em que aparecem. */
const ABAS = ["agents", "marketplace"] as const;

/** O detalhe que abre as automações do modelo antigo, só leitura. */
export const LEGADO = "legacy";
type Aba = (typeof ABAS)[number];

/**
 * Automações: o que roda sozinho. Duas abas respondem o que tenho instalado e
 * o que posso trazer do marketplace. O agent que trabalha dentro de um passo
 * mora na tela Agents.
 *
 * O detalhe abre o canvas da automação. `legacy` e `legacy/<id>` abrem as
 * automações do modelo antigo, só leitura, que a tela de Agents deixou de
 * mostrar na rota `agents`.
 */
export function Automacoes({ detalhe, navegar }: TelaProps) {
  if (detalhe === LEGADO || detalhe?.startsWith(`${LEGADO}/`)) {
    // Por dentro a tela legada ainda chama `agents`; aqui vira o destino dela.
    const dentro: TelaProps["navegar"] = (id, resto) =>
      id === "agents" ? navegar("automations", resto === undefined ? LEGADO : `${LEGADO}/${resto}`) : navegar(id, resto);
    return <AutomacoesLegado detalhe={detalhe === LEGADO ? null : detalhe.slice(LEGADO.length + 1)} navegar={dentro} />;
  }
  if (detalhe !== null) {
    // `<agent>/gatilho/<id>` abre o editor com aquele gatilho escolhido, e
    // `<agent>/gatilho/novo` com um gatilho do GitHub novo no rascunho.
    const [agentId = detalhe, ...resto] = detalhe.split("/");
    const gatilho = resto[0] === "gatilho" ? resto[1] : undefined;
    return (
      <EditorDeAutomacao
        abrirGatilho={gatilho}
        agentId={agentId}
        key={detalhe}
        navegar={navegar}
        voltar={() => navegar("automations")}
      />
    );
  }
  return <TelaDeAgents navegar={navegar} />;
}

function TelaDeAgents({ navegar }: Pick<TelaProps, "navegar">) {
  const { t } = useTranslation();
  const [aba, setAba] = useState<Aba>("agents");

  return (
    <Tabs className="mx-auto w-full max-w-6xl gap-5" onValueChange={(v) => setAba(v as Aba)} value={aba}>
      <TabsList>
        {ABAS.map((candidata) => (
          <TabsTrigger data-locum-agents-aba={candidata} key={candidata} value={candidata}>
            {t(`agents.tabs.${candidata}`)}
          </TabsTrigger>
        ))}
        <button
          className="text-muted-foreground hover:text-foreground -mb-px ml-auto cursor-pointer px-2 text-xs transition-colors"
          data-locum-automacoes-legado=""
          onClick={() => navegar("automations", LEGADO)}
          type="button"
        >
          {t("automations.legacy.link")}
        </button>
      </TabsList>
      {aba === "agents" ? <ListaDeAutomacoes navegar={navegar} /> : null}
      {aba === "marketplace" ? <Marketplace navegar={navegar} /> : null}
    </Tabs>
  );
}

/**
 * O marketplace: os agents prontos que o aplicativo traz, lidos do disco como
 * dado. Instalar é um clique e grava como o importar de arquivo faria; quem já
 * instalou vê "instalado" e o botão some.
 */
function Marketplace({ navegar }: Pick<TelaProps, "navegar">) {
  const { t } = useTranslation();
  const templates = useRead("agents.templates");
  const instalados = useRead("agents.list");
  const [erro, setErro] = useState<string | null>(null);
  const [recem, setRecem] = useState<string | null>(null);
  const idsInstalados = new Set((instalados.data ?? []).map((a) => a.id));

  const instalar = async (id: string, substituicoes: Record<number, string>): Promise<void> => {
    setErro(null);
    const r = await call("agents.importTemplate", id, substituicoes);
    setRecem(r.agentId);
    // Recarrega a lista de instalados para o selo aparecer sem sair da aba.
    read("agents.list").then(() => undefined, () => undefined);
  };

  return (
    <div className="flex flex-col gap-3" data-locum-probe="agents-marketplace">
      {erro === null ? null : <p className="text-destructive text-xs">{erro}</p>}
      {templates.status === "loading" ? (
        <p className="text-muted-foreground text-[13px]">{t("agents.marketplace.loading")}</p>
      ) : (templates.data ?? []).length === 0 ? (
        <EmptyState titulo={t("agents.marketplace.empty")} />
      ) : (
        <ListGroup>
          {(templates.data ?? []).map((template) => (
            <LinhaDeTemplate
              instalado={idsInstalados.has(template.id) || recem === template.id}
              aoFalhar={setErro}
              instalar={(substituicoes) => instalar(template.id, substituicoes)}
              key={template.id}
              template={template}
              ver={(id) => navegar("automations", id)}
            />
          ))}
        </ListGroup>
      )}
    </div>
  );
}

function LinhaDeTemplate({
  instalado,
  aoFalhar,
  instalar,
  template,
  ver,
}: {
  instalado: boolean;
  aoFalhar: (mensagem: string) => void;
  instalar: (substituicoes: Record<number, string>) => Promise<void>;
  template: Template;
  ver: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <ListRow className="min-h-11" data-locum-template={template.id}>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate font-medium">{template.name}</span>
        {instalado ? <Badge variant="secondary">{t("agents.marketplace.installed")}</Badge> : null}
      </span>
      <span className="text-muted-foreground num shrink-0 text-xs">{t("agents.marketplace.steps", { count: template.passos })}</span>
      <span className="text-muted-foreground hidden w-48 shrink-0 truncate font-mono text-xs md:block">{template.id}</span>
      <span className="flex w-24 shrink-0 justify-end">
        {instalado ? (
          <Button className="cursor-pointer" onClick={() => ver(template.id)} size="sm" variant="outline">
            {t("agents.marketplace.open")}
          </Button>
        ) : (
          <InstalacaoDeTemplate aoFalhar={aoFalhar} instalar={instalar} nome={template.name} passosDeModelo={template.passosDeModelo} />
        )}
      </span>
    </ListRow>
  );
}

function ListaDeAutomacoes({ navegar }: Pick<TelaProps, "navegar">) {
  const { t } = useTranslation();
  const inicial = useRead("agents.overview");
  const [criando, setCriando] = useState(false);
  useAcaoDaTela("nova-automacao", () => setCriando(true));
  const [pacote, setPacote] = useState<{ nome: string; texto: string } | null>(null);
  const [erroDoArquivo, setErroDoArquivo] = useState<string | null>(null);
  const lista = inicial.data ?? [];
  // As automações novas que ⌘Q ou uma queda deixaram sem gravar: nada as mostrava.
  const [provisorias, setProvisorias] = useState(() => listarProvisorias(globalThis.localStorage));
  // Reserva de automação apagada não tem mais a que voltar.
  useEffect(() => {
    if (inicial.data !== undefined) limparReservasOrfas(globalThis.localStorage, inicial.data.map((l) => l.id));
  }, [inicial.data]);
  const reler = (): void => {
    invalidateReads("agents.overview");
  };

  const escolherArquivo = (): void => {
    setErroDoArquivo(null);
    call("pacote.chooseFile").then(
      (r) => r !== null && setPacote(r),
      (e: unknown) => setErroDoArquivo(semPrefixoDoIpc(e instanceof Error ? e.message : String(e))),
    );
  };
  // Arrastar o arquivo para a janela: só texto, que vai pela mesma prévia.
  const soltar = (e: DragEvent<HTMLDivElement>): void => {
    const arquivo = e.dataTransfer.files[0];
    if (arquivo === undefined) return;
    e.preventDefault();
    setErroDoArquivo(null);
    if (!arquivo.name.endsWith(".json")) {
      setErroDoArquivo(t("pacote.import.notJson"));
      return;
    }
    arquivo.text().then((texto) => setPacote({ nome: arquivo.name, texto }), () => setErroDoArquivo(t("pacote.import.unreadable")));
  };

  return (
    <div
      className="flex flex-col gap-5"
      data-locum-probe="automacoes"
      data-total={lista.length}
      onDragOver={(e) => e.preventDefault()}
      onDrop={soltar}
    >
      <CabecalhoDaTela
        acoes={
          <>
            <Button className="cursor-pointer" data-locum-automacao-importar="" onClick={escolherArquivo} variant="outline">
              <Upload />
              {t("pacote.import.button")}
            </Button>
            <Button className="cursor-pointer" data-locum-automacao-nova="" onClick={() => setCriando(true)}>
              <Plus />
              {t("automations.list.new")}
            </Button>
          </>
        }
        descricao={t("automations.lead")}
        titulo={t("automations.title")}
      />

      {erroDoArquivo === null ? null : <p className="text-destructive text-xs">{erroDoArquivo}</p>}
      {pacote === null ? null : (
        <ImportarPacote
          arquivo={pacote}
          fechar={() => {
            setPacote(null);
            reler();
          }}
          navegar={navegar}
        />
      )}

      {criando ? (
        <NovaAutomacao
          aoCancelar={() => setCriando(false)}
          aoCriar={(id) => {
            setCriando(false);
            navegar("automations", id);
          }}
        />
      ) : null}

      {provisorias.length === 0 ? null : (
        <ListGroup>
          {provisorias.map(({ agentId, provisoria }) => (
            <ListRow
              className="min-h-11"
              data-locum-automacao-rascunho={agentId}
              key={agentId}
              onClick={() => navegar("automations", agentId)}
              rotulo={provisoria.rascunho.spec.name}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{provisoria.rascunho.spec.name}</span>
              </span>
              <Badge variant="outline">{t("automations.list.draft")}</Badge>
              <span className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <Button
                  className="cursor-pointer"
                  data-locum-automacao-rascunho-descartar={agentId}
                  onClick={() => {
                    apagarProvisoria(globalThis.localStorage, agentId);
                    setProvisorias(listarProvisorias(globalThis.localStorage));
                  }}
                  size="sm"
                  variant="ghost"
                >
                  {t("automations.list.draftDiscard")}
                </Button>
                <Button className="cursor-pointer" onClick={() => navegar("automations", agentId)} size="sm" variant="outline">
                  {t("automations.list.draftOpen")}
                </Button>
              </span>
            </ListRow>
          ))}
        </ListGroup>
      )}

      {inicial.status === "loading" ? (
        <p className="text-muted-foreground text-[13px]">{t("automations.editor.loading")}</p>
      ) : lista.length === 0 && provisorias.length === 0 && !criando ? (
        <EmptyState
          acao={
            <Button className="cursor-pointer" onClick={() => setCriando(true)} size="sm" variant="outline">
              {t("automations.list.new")}
            </Button>
          }
          titulo={t("automations.list.empty")}
        />
      ) : lista.length === 0 ? null : (
        <ListGroup>
          {lista.map((linha) => (
            <LinhaDaAutomacao key={linha.id} linha={linha} abrir={() => navegar("automations", linha.id)} aoMudar={reler} />
          ))}
        </ListGroup>
      )}
    </div>
  );
}

export function LinhaDaAutomacao({
  linha,
  abrir,
  aoMudar,
  extra,
}: {
  linha: Linha;
  abrir: () => void;
  aoMudar: () => void;
  /** Ação a mais no fim da linha, para quem a mostra em outro contexto. */
  extra?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const [agindo, setAgindo] = useState<"ligar" | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const executar = useExecutarAgora();
  const { abrirRun } = useToasts();
  const gatilhos = linha.triggers.map((g) => ({ ...g, config: g.config as TriggerConfig }));
  const ligada = gatilhos.some((g) => g.enabled);
  const temRelogio = gatilhos.some((g) => g.config.kind !== "manual" && g.config.kind !== "webhook");

  const alternar = (): void => {
    setAgindo("ligar");
    call("automations.setEnabled", linha.id, !ligada).then(
      () => {
        setAgindo(null);
        aoMudar();
      },
      (e: unknown) => {
        setAgindo(null);
        setAviso(e instanceof Error ? e.message : String(e));
      },
    );
  };

  return (
    <ListRow
      className="min-h-11"
      data-locum-automacao={linha.id}
      data-locum-ligada={ligada ? "sim" : "nao"}
      onClick={abrir}
      rotulo={linha.name}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{linha.name}</span>
        {aviso === null ? null : <span className="text-muted-foreground truncate text-xs">{aviso}</span>}
        {linha.lastRun?.status === "failed" && linha.lastRun.error !== null ? (
          <button
            className="text-destructive w-fit max-w-full cursor-pointer truncate text-left text-xs hover:underline"
            data-locum-ultimo-erro={linha.lastRun.id}
            onClick={(e) => {
              e.stopPropagation();
              abrirRun(linha.lastRun!.id);
            }}
            title={rotuloDoErroDeRun(t, linha.lastRun.error)}
            type="button"
          >
            {rotuloDoErroDeRun(t, linha.lastRun.error)}
          </button>
        ) : null}
      </span>

      <span className="flex w-72 shrink-0 flex-col gap-0.5 overflow-hidden">
        {gatilhos.length === 0 ? (
          <span className="text-muted-foreground text-xs">{t("automations.list.noTrigger")}</span>
        ) : (
          gatilhos.map((g, i) => (
            <span
              className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs"
              data-locum-gatilho-ligado={g.enabled ? "sim" : "nao"}
              key={`${g.kind}-${i}`}
            >
              <Selo app={appDoGatilho(g.config.kind)} id={g.config.kind} tamanho="sm" />
              <StatusDot estado={g.enabled ? "ok" : "ocioso"} />
              <span className="truncate" title={linhaDoGatilho(t, g.config, resumoDoGatilho(t, g.config, i18n.language))}>
                {linhaDoGatilho(t, g.config, resumoDoGatilho(t, g.config, i18n.language))}
              </span>
            </span>
          ))
        )}
      </span>

      <span className="text-muted-foreground num w-20 shrink-0 text-xs">{t("automations.list.steps", { count: linha.stepCount })}</span>

      <span className="text-muted-foreground flex w-32 shrink-0 items-center gap-1.5 text-xs">
        {linha.lastRun === null ? (
          <>
            <StatusDot estado="ocioso" />
            {t("automations.list.never")}
          </>
        ) : (
          <>
            <StatusDot estado={pontoDoEstado(linha.lastRun.status)} />
            {rotuloDeEstado(t, linha.lastRun.status)}
          </>
        )}
      </span>

      <span className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
        {temRelogio ? (
          <button
            aria-label={t("automations.list.toggle")}
            aria-pressed={ligada}
            className="text-muted-foreground hover:text-foreground hover:bg-accent flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs transition-colors disabled:opacity-50"
            data-locum-automacao-interruptor={linha.id}
            disabled={agindo !== null}
            onClick={alternar}
            type="button"
          >
            <StatusDot estado={ligada ? "ok" : "ocioso"} />
            {t(ligada ? "automations.list.on" : "automations.list.off")}
          </button>
        ) : null}
        <Button
          className="cursor-pointer"
          data-locum-executar-agora={linha.id}
          disabled={agindo !== null || executar.pedindo}
          onClick={() => void executar.pedir(linha.id, linha.name, { aoIniciar: () => aoMudar(), aoTerminar: () => aoMudar() })}
          size="sm"
          title={t("automations.list.runNow")}
          variant="ghost"
        >
          {executar.pedindo ? <Loader2 className="animate-spin" /> : <Play />}
          {t("automations.list.runNow")}
        </Button>
        {executar.dialogo}
        <Button className="cursor-pointer" onClick={abrir} size="sm" variant="outline">
          {t("automations.list.open")}
        </Button>
        {extra}
      </span>
    </ListRow>
  );
}

/**
 * Criar por modelo. A automação nasce gravada, com o gatilho desligado, e
 * abre no canvas: é lá que se diz o canal, o tracker e o texto. Criada de
 * dentro de uma iniciativa, nasce ligada a ela.
 */
export function NovaAutomacao({
  aoCancelar,
  aoCriar,
  iniciativa,
}: {
  aoCancelar: () => void;
  aoCriar: (id: string) => void;
  iniciativa?: string;
}) {
  const { t } = useTranslation();
  const [modelo, setModelo] = useState<ModeloId>("slackReply");
  const [nome, setNome] = useState("");
  const [tracker, setTracker] = useState<string>("");
  const [criando, setCriando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const trackers = useRead("trackers.list");
  const listaDeTrackers = (trackers.data ?? []).filter((tr) => tr.enabled);
  const agentes = useRead("library.profiles");

  const criar = async (): Promise<void> => {
    setCriando(true);
    setErro(null);
    try {
      const titulo = nome.trim() || t(`automations.templates.${modelo}.title`);
      const sugerido = await call("automations.suggestId", titulo);
      // Uma automação nova ainda não gravada também ocupa o nome: não sobrescreve a provisória de outra.
      const id = idSemProvisoria(globalThis.localStorage, sugerido);
      const r = rascunhoDoModelo(modelo, id, titulo, tracker === "" ? (listaDeTrackers[0]?.id ?? null) : tracker, (agentes.data ?? []).map((a) => ({ id: a.id, name: a.name })));
      // Nada é gravado agora: o modelo espera no editor até o primeiro Salvar, e abandonar sem editar não deixa automação na lista.
      guardarProvisoria(globalThis.localStorage, id, {
        rascunho: r,
        nota: t(`automations.templates.${modelo}.title`),
        ...(iniciativa === undefined ? {} : { iniciativa }),
      });
      if (lerProvisoria(globalThis.localStorage, id) === null) throw new Error(t("automations.new.noStorage"));
      aoCriar(id);
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
      setCriando(false);
    }
  };

  return (
    <section className="border-border bg-card flex flex-col gap-4 rounded-lg border p-4" data-locum-probe="automacao-nova">
      <h2 className="text-[13px] font-medium">{t("automations.new.title")}</h2>

      <label className="flex max-w-md flex-col gap-1.5 text-xs">
        <span className="text-muted-foreground">{t("automations.new.name")}</span>
        <Input autoFocus onChange={(e) => setNome(e.target.value)} placeholder={t("automations.new.namePlaceholder")} value={nome} />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs">{t("automations.new.template")}</span>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-1.5">
          {MODELOS.map((m) => (
            <button
              aria-pressed={modelo === m}
              className={cn(
                "border-border flex min-h-14 cursor-pointer flex-col gap-0.5 rounded-md border px-3 py-2 text-left transition-colors",
                modelo === m ? "border-primary bg-primary/5" : "hover:bg-accent",
              )}
              data-locum-modelo={m}
              key={m}
              onClick={() => setModelo(m)}
              type="button"
            >
              <span className="text-[13px] font-medium">{t(`automations.templates.${m}.title`)}</span>
              <span className="text-muted-foreground line-clamp-2 text-xs">{t(`automations.templates.${m}.description`)}</span>
            </button>
          ))}
        </div>
      </div>

      {modelo === "slackJira" ? (
        <label className="flex max-w-md flex-col gap-1.5 text-xs">
          <span className="text-muted-foreground">{t("automations.new.tracker")}</span>
          {listaDeTrackers.length === 0 ? (
            <span className="text-muted-foreground">{t("automations.new.trackerNone")}</span>
          ) : (
            <select
              className="border-input h-8 rounded-md border bg-transparent px-2 text-[13px] outline-none"
              onChange={(e) => setTracker(e.target.value)}
              value={tracker === "" ? (listaDeTrackers[0]?.id ?? "") : tracker}
            >
              {listaDeTrackers.map((tr) => (
                <option key={tr.id} value={tr.id}>
                  {tr.label}
                </option>
              ))}
            </select>
          )}
        </label>
      ) : null}

      <div className="flex items-center gap-2">
        <Button className="cursor-pointer" data-locum-automacao-criar="" disabled={criando} onClick={() => void criar()}>
          {t(criando ? "automations.new.creating" : "automations.new.create")}
        </Button>
        <Button className="cursor-pointer" onClick={aoCancelar} variant="ghost">
          {t("automations.new.cancel")}
        </Button>
        {erro === null ? null : <span className="text-destructive text-xs">{erro}</span>}
      </div>
    </section>
  );
}
