import { CabecalhoDaTela } from "@/components/cabecalho-da-tela";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MODELOS, rascunhoDoModelo, type ModeloId } from "@/lib/automacao";
import { call, read, useRead, type ReadResult } from "@/lib/bridge";
import { rotuloDeEstado } from "@/lib/rotulos";
import { cn } from "@/lib/utils";
import { Loader2, Play, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TriggerConfig } from "../../../src/config/types";
import { EditorDeAutomacao } from "../automacoes/editor";
import { appDoGatilho, resumoDoGatilho, Selo, tituloDoGatilho } from "../automacoes/visual";
import type { TelaProps } from "../rotas";

type Linha = ReadResult<"agents.overview">[number];

/**
 * Automações: a lista, e o canvas de cada uma no detalhe.
 *
 * A linha responde o que a pessoa pergunta olhando a lista: o que acorda esta
 * automação, se ela está ligada, e como foi a última vez. Ligar e executar
 * ficam na própria linha, porque são as duas coisas que se faz sem abrir.
 */
export function Automacoes({ detalhe, navegar }: TelaProps) {
  if (detalhe !== null) {
    return <EditorDeAutomacao agentId={detalhe} voltar={() => navegar("automations")} navegar={navegar} />;
  }
  return <ListaDeAutomacoes navegar={navegar} />;
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
    <div className="flex max-w-5xl flex-col gap-6" data-locum-probe="automacoes" data-total={lista.length}>
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

function LinhaDaAutomacao({ linha, abrir, aoMudar }: { linha: Linha; abrir: () => void; aoMudar: () => void }) {
  const { t } = useTranslation();
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
                  {tituloDoGatilho(t, g.config)} · {resumoDoGatilho(t, g.config)}
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
      </div>
      {aviso === null ? null : <p className="text-muted-foreground text-xs">{aviso}</p>}
    </li>
  );
}

/**
 * Criar por modelo. A automação nasce gravada, com o gatilho desligado, e
 * abre no canvas: é lá que se diz o canal, o tracker e o texto.
 */
function NovaAutomacao({ aoCancelar, aoCriar }: { aoCancelar: () => void; aoCriar: (id: string) => void }) {
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
