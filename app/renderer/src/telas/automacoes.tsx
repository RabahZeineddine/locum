import { CabecalhoDaTela } from "@/components/cabecalho-da-tela";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MODELOS, rascunhoDoModelo, type ModeloId } from "@/lib/automacao";
import { call, read, useRead, type ReadResult } from "@/lib/bridge";
import { rotuloDeEstado, rotuloDoModelo } from "@/lib/rotulos";
import { cn } from "@/lib/utils";
import { Bot, Download, Loader2, Play, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TriggerConfig } from "../../../src/config/types";
import { EditorDeAutomacao } from "../automacoes/editor";
import { appDoGatilho, resumoDoGatilho, Selo, tituloDoGatilho } from "../automacoes/visual";
import { Biblioteca } from "./biblioteca";
import type { TelaProps } from "../rotas";

type Linha = ReadResult<"agents.overview">[number];
type Template = ReadResult<"agents.templates">[number];

/** As abas da tela unificada de Agents, na ordem em que aparecem. */
const ABAS = ["agents", "marketplace", "specialties"] as const;
type Aba = (typeof ABAS)[number];

/**
 * Agents: a tela unificada. Três abas respondem as três perguntas de quem usa:
 * o que tenho instalado, o que posso trazer do marketplace, e as especialidades
 * reutilizáveis que as automações acoplam.
 *
 * O detalhe continua abrindo o canvas da automação, como sempre abriu; e o
 * detalhe que veio com o prefixo "library/" abre o editor de especialidade,
 * para os atalhos antigos de dentro do canvas não quebrarem.
 */
export function Automacoes({ detalhe, navegar }: TelaProps) {
  if (detalhe?.startsWith("library/")) {
    const alvo = detalhe.slice("library/".length);
    return <Biblioteca detalhe={alvo} navegar={navegar} />;
  }
  if (detalhe !== null) {
    return <EditorDeAutomacao agentId={detalhe} voltar={() => navegar("automations")} navegar={navegar} />;
  }
  return <TelaDeAgents navegar={navegar} />;
}

function TelaDeAgents({ navegar }: Pick<TelaProps, "navegar">) {
  const { t } = useTranslation();
  const [aba, setAba] = useState<Aba>("agents");

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div className="border-border flex gap-1 border-b">
        {ABAS.map((candidata) => (
          <button
            aria-pressed={aba === candidata}
            className={cn(
              "-mb-px cursor-pointer border-b-2 px-3 py-2 text-sm transition-colors",
              aba === candidata
                ? "border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground border-transparent",
            )}
            data-locum-agents-aba={candidata}
            key={candidata}
            onClick={() => setAba(candidata)}
            type="button"
          >
            {t(`agents.tabs.${candidata}`)}
          </button>
        ))}
      </div>
      {aba === "agents" ? <ListaDeAutomacoes navegar={navegar} /> : null}
      {aba === "marketplace" ? <Marketplace navegar={navegar} /> : null}
      {aba === "specialties" ? <Biblioteca detalhe={null} navegar={navegar} /> : null}
    </div>
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
  const [instalando, setInstalando] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [recem, setRecem] = useState<string | null>(null);
  const idsInstalados = new Set((instalados.data ?? []).map((a) => a.id));

  const instalar = (id: string): void => {
    setInstalando(id);
    setErro(null);
    call("agents.importTemplate", id)
      .then((r) => {
        setRecem(r.agentId);
        // Recarrega a lista de instalados para o selo aparecer sem sair da aba.
        read("agents.list").then(() => undefined, () => undefined);
      })
      .catch((e: unknown) => setErro(e instanceof Error ? e.message : String(e)))
      .finally(() => setInstalando(null));
  };

  return (
    <div className="flex flex-col gap-4" data-locum-probe="agents-marketplace">
      {erro === null ? null : <p className="text-destructive text-xs">{erro}</p>}
      {templates.status === "loading" ? (
        <p className="text-muted-foreground text-sm">{t("agents.marketplace.loading")}</p>
      ) : (templates.data ?? []).length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("agents.marketplace.empty")}</p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
          {(templates.data ?? []).map((template) => (
            <CartaoDeTemplate
              instalado={idsInstalados.has(template.id) || recem === template.id}
              instalando={instalando === template.id}
              instalar={() => instalar(template.id)}
              key={template.id}
              template={template}
              ver={(id) => navegar("automations", id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function CartaoDeTemplate({
  instalado,
  instalando,
  instalar,
  template,
  ver,
}: {
  instalado: boolean;
  instalando: boolean;
  instalar: () => void;
  template: Template;
  ver: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="border-border superficie flex flex-col gap-2 rounded-lg border p-4">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="ia-gradiente text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
          <Bot className="size-4" />
        </span>
        <span className="truncate font-medium text-sm">{template.name}</span>
        {instalado ? (
          <Badge className="ml-auto shrink-0" variant="outline">
            {t("agents.marketplace.installed")}
          </Badge>
        ) : null}
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {template.modelo !== null ? <span>{rotuloDoModelo(template.modelo)}</span> : null}
        <span>{t("agents.marketplace.steps", { count: template.passos })}</span>
        <span className="font-mono">{template.id}</span>
      </div>
      <div className="mt-auto flex items-center gap-2 pt-1">
        {instalado ? (
          <Button className="cursor-pointer" onClick={() => ver(template.id)} size="sm" variant="outline">
            {t("agents.marketplace.open")}
          </Button>
        ) : (
          <Button className="cursor-pointer" disabled={instalando} onClick={instalar} size="sm">
            {instalando ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            {t("agents.marketplace.install")}
          </Button>
        )}
      </div>
    </li>
  );
}

function ListaDeAutomacoes({ navegar }: Pick<TelaProps, "navegar">) {
  const { t } = useTranslation();
  const inicial = useRead("agents.overview");
  const [relida, setRelida] = useState<Linha[] | null>(null);
  const [criando, setCriando] = useState(false);
  const lista = relida ?? inicial.data ?? [];
  const reler = (): void => {
    read("agents.overview").then(setRelida, () => undefined);
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6" data-locum-probe="automacoes" data-total={lista.length}>
      <CabecalhoDaTela
        acoes={
          <Button className="cursor-pointer" data-locum-automacao-nova="" onClick={() => setCriando(true)}>
            <Plus className="size-4" />
            {t("automations.list.new")}
          </Button>
        }
        descricao={t("automations.lead")}
        titulo={t("automations.title")}
      />

      {criando ? (
        <NovaAutomacao
          aoCancelar={() => setCriando(false)}
          aoCriar={(id) => {
            setCriando(false);
            navegar("automations", id);
          }}
        />
      ) : null}

      {inicial.status === "loading" && relida === null ? (
        <p className="text-muted-foreground text-sm">{t("automations.editor.loading")}</p>
      ) : lista.length === 0 && !criando ? (
        <div className="border-border text-muted-foreground flex flex-col items-start gap-3 rounded-lg border border-dashed p-6 text-sm">
          {t("automations.list.empty")}
          <Button className="cursor-pointer" onClick={() => setCriando(true)} size="sm" variant="outline">
            {t("automations.list.new")}
          </Button>
        </div>
      ) : (
        <ul className="divide-border border-border superficie divide-y overflow-hidden rounded-lg border">
          {lista.map((linha) => (
            <LinhaDaAutomacao key={linha.id} linha={linha} abrir={() => navegar("automations", linha.id)} aoMudar={reler} />
          ))}
        </ul>
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
  const [agindo, setAgindo] = useState<"ligar" | "rodar" | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
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

  const rodar = (): void => {
    setAgindo("rodar");
    call("automations.runNow", linha.id).then(
      () => {
        setAgindo(null);
        setAviso(t("automations.list.started"));
        aoMudar();
      },
      (e: unknown) => {
        setAgindo(null);
        setAviso(e instanceof Error ? e.message : String(e));
      },
    );
  };

  return (
    <li className="flex flex-col gap-2 px-4 py-3" data-locum-automacao={linha.id} data-locum-ligada={ligada ? "sim" : "nao"}>
      <div className="flex items-center gap-3">
        <button className="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-1 text-left" onClick={abrir} type="button">
          <span className="truncate font-medium text-sm">{linha.name}</span>
          <span className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {gatilhos.length === 0 ? (
              <span>{t("automations.list.noTrigger")}</span>
            ) : (
              gatilhos.map((g, i) => (
                <span className="flex items-center gap-1.5" key={`${g.kind}-${i}`}>
                  <Selo app={appDoGatilho(g.config.kind)} id={g.config.kind} tamanho="sm" />
                  {tituloDoGatilho(t, g.config)} · {resumoDoGatilho(t, g.config, i18n.language)}
                </span>
              ))
            )}
            <span>{t("automations.list.steps", { count: linha.stepCount })}</span>
            <span>
              {linha.lastRun === null
                ? t("automations.list.never")
                : t("automations.list.lastRun", { status: rotuloDeEstado(t, linha.lastRun.status) })}
            </span>
          </span>
        </button>

        <Button
          className="cursor-pointer"
          disabled={agindo !== null}
          onClick={rodar}
          size="sm"
          title={t("automations.list.runNow")}
          variant="ghost"
        >
          {agindo === "rodar" ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          {t("automations.list.runNow")}
        </Button>
        {temRelogio ? (
          <button
            aria-label={t("automations.list.toggle")}
            aria-pressed={ligada}
            className={cn(
              "cursor-pointer rounded-full px-3 py-1 text-xs transition-colors",
              ligada ? "bg-emerald-500/15 text-emerald-400" : "bg-muted text-muted-foreground",
            )}
            data-locum-automacao-interruptor={linha.id}
            disabled={agindo !== null}
            onClick={alternar}
            type="button"
          >
            {t(ligada ? "automations.list.on" : "automations.list.off")}
          </button>
        ) : null}
        <Button className="cursor-pointer" onClick={abrir} size="sm" variant="outline">
          {t("automations.list.open")}
        </Button>
        {extra}
      </div>
      {aviso === null ? null : <p className="text-muted-foreground text-xs">{aviso}</p>}
    </li>
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

  const criar = async (): Promise<void> => {
    setCriando(true);
    setErro(null);
    try {
      const titulo = nome.trim() || t(`automations.templates.${modelo}.title`);
      const id = await call("automations.suggestId", titulo);
      const r = rascunhoDoModelo(modelo, id, titulo, tracker === "" ? (listaDeTrackers[0]?.id ?? null) : tracker);
      await call("automations.save", {
        spec: r.spec,
        triggers: r.gatilhos.map((g) => ({ config: g.config })),
        note: t(`automations.templates.${modelo}.title`),
        create: true,
      });
      if (iniciativa !== undefined) await call("initiatives.linkAgent", id, iniciativa);
      aoCriar(id);
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
      setCriando(false);
    }
  };

  return (
    <section className="border-border superficie flex flex-col gap-4 rounded-lg border p-5" data-locum-probe="automacao-nova">
      <h2 className="font-medium text-[15px]">{t("automations.new.title")}</h2>

      <label className="flex max-w-md flex-col gap-1.5 text-xs">
        <span className="text-muted-foreground">{t("automations.new.name")}</span>
        <input
          autoFocus
          className="border-border bg-background focus-visible:ring-ring rounded-md border px-3 py-1.5 text-sm outline-none focus-visible:ring-1"
          onChange={(e) => setNome(e.target.value)}
          placeholder={t("automations.new.namePlaceholder")}
          value={nome}
        />
      </label>

      <div className="flex flex-col gap-2">
        <span className="text-muted-foreground text-xs">{t("automations.new.template")}</span>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
          {MODELOS.map((m) => (
            <button
              aria-pressed={modelo === m}
              className={cn(
                "border-border flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
                modelo === m ? "border-primary bg-primary/5" : "hover:border-foreground/30",
              )}
              data-locum-modelo={m}
              key={m}
              onClick={() => setModelo(m)}
              type="button"
            >
              <span className="font-medium text-sm">{t(`automations.templates.${m}.title`)}</span>
              <span className="text-muted-foreground text-xs">{t(`automations.templates.${m}.description`)}</span>
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
              className="border-border bg-background rounded-md border px-2 py-1.5 text-sm"
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
        {erro === null ? null : <Badge variant="destructive">{erro}</Badge>}
      </div>
    </section>
  );
}
