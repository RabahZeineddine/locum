import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Task,
  TaskContent,
  TaskItem,
  TaskItemFile,
  TaskTrigger,
} from "@/components/ai-elements/task";
import { Badge } from "@/components/ui/badge";
import { CabecalhoDaTela } from "@/components/cabecalho-da-tela";
import { Button } from "@/components/ui/button";
import { call, read, useRead, type ReadResult } from "@/lib/bridge";
import { useJanela } from "@/lib/janela";
import {
  rotuloDeEstado,
  rotuloDeSeveridade,
  rotuloDoModelo,
  rotuloDoMotivo,
  type Estado,
} from "@/lib/rotulos";
import { cn } from "@/lib/utils";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  CornerDownRight,
  FileCode,
  GitBranch,
  GitPullRequest,
  Info,
  Loader2,
  MessageSquareText,
  RotateCcw,
  Sparkles,
  User,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { Trans, useTranslation } from "react-i18next";
import { useCurrentInitiative } from "../current-initiative";
import { GrafoDaExecucao } from "../grafo";
import { LeituraDoDigest, lerDigest } from "../leitura-do-digest";
import type { TelaProps } from "../rotas";

export type Execucao = ReadResult<"runs.list">[number];
type Detalhe = NonNullable<ReadResult<"runs.get">>;
type Passo = Detalhe["steps"][number];

/** Altura de cada linha da lista. Fixa, porque a janela virtual conta com isso. */
const ALTURA_DA_LINHA = 76;

/**
 * A tela de execucoes: a lista, e o detalhe de uma delas.
 *
 * Qual das duas aparece sai do hash, e nao de estado local, porque recarregar
 * a janela no detalhe de um run precisa voltar para o mesmo run. O roteador
 * entrega o identificador em `detalhe`.
 */
export function Execucoes({ detalhe, navegar }: TelaProps) {
  return detalhe === null ? (
    <Lista navegar={navegar} />
  ) : (
    <Execucao navegar={navegar} runId={detalhe} />
  );
}

/* ------------------------------------------------------------------ lista */

function Lista({ navegar }: { navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  const { slug } = useCurrentInitiative();
  // O chip so aparece quando ha iniciativa atual; filtrar a lista por ela e um
  // clique a mais, nunca o padrao, porque quem entra em execucoes sem escolher
  // iniciativa nenhuma espera ver todas.
  const [filtrando, setFiltrando] = useState(false);
  const iniciativas = useRead("initiatives.list");
  const iniciativaAtual = slug === null ? undefined : iniciativas.data?.find((i) => i.slug === slug);
  const aplicarFiltro = filtrando && iniciativaAtual !== undefined;

  // O limite e alto de proposito: a janela virtual abaixo e quem sustenta a
  // lista longa, e pedir de vinte em vinte traria paginacao para uma tela que
  // ninguem pagina, ela rola.
  const runs = useRead(
    "runs.list",
    aplicarFiltro ? { limit: 500, initiativeId: iniciativaAtual.id } : { limit: 500 },
  );
  const linhas = runs.data ?? [];
  const janela = useJanela(linhas.length, ALTURA_DA_LINHA);

  const metricas = useMemo(() => {
    if (linhas.length === 0) return null;
    const concluidas = linhas.filter((r) => r.status === "done").length;
    const falhadas = linhas.filter((r) => r.status === "failed").length;
    const taxaSucesso = Math.round((concluidas / (linhas.length || 1)) * 100);
    const custoTotal = linhas.reduce(
      (acc, r) => acc + (r.costUsd > 0 ? r.costUsd : r.estimateUsd || 0),
      0,
    );
    const tempos = linhas
      .filter((r) => r.endedAt && r.createdAt)
      .map((r) => r.endedAt! - r.createdAt);
    const tempoMedioS =
      tempos.length > 0 ? Math.round(tempos.reduce((a, b) => a + b, 0) / tempos.length) : 0;

    return {
      total: linhas.length,
      concluidas,
      falhadas,
      taxaSucesso,
      custoTotal,
      tempoMedioS,
    };
  }, [linhas]);

  return (
    <div className="flex h-full flex-col items-stretch gap-5">
      <CabecalhoDaTela descricao={t("runs.lead")} titulo={t("runs.title")} />

      {metricas && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="superficie flex flex-col gap-1 rounded-xl p-3.5">
            <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.06em]">
              {t("runs.metrics.total")}
            </span>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-2xl font-semibold text-foreground">
                {metricas.total}
              </span>
              <span className="text-muted-foreground text-xs">{t("runs.metrics.executions")}</span>
            </div>
          </div>

          <div className="superficie flex flex-col gap-1 rounded-xl p-3.5">
            <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.06em]">
              {t("runs.metrics.success_rate")}
            </span>
            <div className="flex items-baseline gap-2">
              <span
                className={cn(
                  "font-mono text-2xl font-semibold",
                  metricas.taxaSucesso >= 90
                    ? "text-emerald-500"
                    : metricas.taxaSucesso >= 70
                      ? "text-sev-medium"
                      : "text-sev-critical",
                )}
              >
                {metricas.taxaSucesso}%
              </span>
              {metricas.falhadas > 0 && (
                <span className="text-sev-critical text-xs">
                  ({metricas.falhadas} {t("runs.metrics.failed")})
                </span>
              )}
            </div>
          </div>

          <div className="superficie flex flex-col gap-1 rounded-xl p-3.5">
            <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.06em]">
              {t("runs.metrics.cost")}
            </span>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-2xl font-semibold text-foreground">
                ${metricas.custoTotal.toFixed(2)}
              </span>
              <span className="text-muted-foreground text-xs">{t("runs.metrics.currency")}</span>
            </div>
          </div>

          <div className="superficie flex flex-col gap-1 rounded-xl p-3.5">
            <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.06em]">
              {t("runs.metrics.avg_duration")}
            </span>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-2xl font-semibold text-foreground">
                {t("runs.metrics.seconds", { n: metricas.tempoMedioS })}
              </span>
              <span className="text-muted-foreground text-xs">{t("runs.metrics.per_run")}</span>
            </div>
          </div>
        </div>
      )}

      {iniciativaAtual !== undefined ? (
        <div className="mb-3 flex items-center gap-1.5">
          <button
            aria-pressed={aplicarFiltro}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors",
              aplicarFiltro
                ? "bg-primary text-primary-foreground"
                : "bg-accent text-accent-foreground hover:bg-accent/70",
            )}
            data-aplicado={aplicarFiltro}
            data-locum-probe="execucoes-initiative"
            data-slug={iniciativaAtual.slug}
            onClick={() => setFiltrando((v) => !v)}
            title={t("common.filterByInitiative")}
            type="button"
          >
            {iniciativaAtual.title}
            {aplicarFiltro ? <X className="size-3" /> : null}
          </button>
        </div>
      ) : null}

      <div
        className="text-muted-foreground -mb-2 text-xs"
        data-estado={runs.status}
        data-locum-probe="runs"
        data-runs={linhas.map((r) => r.id).join(",")}
        data-total={linhas.length}
      >
        {runs.status === "error"
          ? t("runs.refused", { message: runs.error.message })
          : runs.status === "loading"
            ? t("runs.loading")
            : t("runs.count", { count: linhas.length })}
      </div>

      {runs.status === "ready" && linhas.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {/*
            O comando fica dentro da frase traduzida, e nao colado de fora: a
            posicao dele muda com o idioma, e frase partida em dois pedacos
            perde a ordem no primeiro idioma que nao siga a do portugues.
          */}
          <Trans components={{ code: <code /> }} i18nKey="runs.empty" />
        </p>
      ) : (
        <div
          className="superficie max-h-full min-h-0 overflow-auto rounded-xl"
          ref={janela.ref}
        >
          {/*
            Os espacadores sustentam a barra de rolagem no tamanho da lista
            inteira enquanto so as linhas visiveis existem no DOM.
          */}
          <div style={{ height: janela.antes }} />
          {linhas.slice(janela.inicio, janela.fim).map((run) => (
            <LinhaDeExecucao key={run.id} navegar={navegar} run={run} />
          ))}
          <div style={{ height: janela.depois }} />
        </div>
      )}
    </div>
  );
}

/**
 * A linha diz sobre o que a execução foi, e não só quando ela aconteceu.
 *
 * Nome do agent com horário obriga a abrir cada uma para saber de que trabalho
 * se trata. O alvo vem do evento; o andamento vem da contagem de passos, que é
 * o que responde se ela terminou, parou esperando você, ou quebrou.
 */
export function LinhaDeExecucao({
  navegar,
  run,
}: {
  navegar: TelaProps["navegar"];
  run: Execucao;
}) {
  const { t } = useTranslation();
  const alvo = run.target;

  return (
    <button
      className="hover:bg-accent/40 focus-visible:ring-ring border-border relative w-full cursor-pointer border-b px-4 py-2.5 text-left transition-colors duration-200 last:border-b-0 focus-visible:ring-2 focus-visible:-outline-offset-2"
      data-locum-run={run.id}
      onClick={() => navegar("runs", run.id)}
      style={{ height: ALTURA_DA_LINHA }}
      type="button"
    >
      <div className="flex items-baseline gap-2.5">
        {alvo?.pull ? (
          <>
            <span className="shrink-0 font-mono text-[13px] font-medium">{t("common.pull", { number: alvo.pull })}</span>
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm">
              {alvo.title ?? alvo.repo}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm">
            {t("runs.no_target")}
          </span>
        )}
        <span className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums">
          {quando(t, run.createdAt)}
        </span>
        <span className="w-24 shrink-0 text-right font-mono text-xs tabular-nums">
          {dinheiro(t, run)}
        </span>
      </div>

      <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
        <Estado status={run.status} />
        <span className="font-mono">
          {run.agentId} {t("common.version", { version: run.agentVersion })}
        </span>
        <span className="tabular-nums">
          {t("runs.progress", { done: run.stepDone, total: run.stepTotal })}
        </span>
        {run.stepPending > 0 && (
          <span className="text-sev-medium">{t("runs.waiting_steps", { count: run.stepPending })}</span>
        )}
        {run.stepFailed > 0 && (
          <span className="text-sev-critical">{t("runs.failed_steps", { count: run.stepFailed })}</span>
        )}
        {run.findingCount > 0 && (
          <span>{t("runs.findings", { count: run.findingCount })}</span>
        )}
      </div>
    </button>
  );
}

/* ----------------------------------------------------------------- detalhe */

function Execucao({ navegar, runId }: { navegar: TelaProps["navegar"]; runId: string }) {
  const { t } = useTranslation();
  const run = useRead("runs.get", runId);
  const achados = useRead("runs.findings", runId);
  const [relido, setRelido] = useState<ReadResult<"runs.get">>(undefined);
  const andando = (relido ?? run.data)?.status;

  // Enquanto o run anda, a tela relê a cada segundo e meio: o passo grava o que
  // vai fazendo, e é isso que aparece na linha do tempo de cada passo.
  useEffect(() => {
    if (andando !== "running" && andando !== "pending") return;
    const id = window.setInterval(() => {
      read("runs.get", runId).then(setRelido, () => undefined);
    }, 1500);
    return () => window.clearInterval(id);
  }, [andando, runId]);

  if (run.status === "error") {
    return <Aviso probe="execucao">{t("runs.refused", { message: run.error.message })}</Aviso>;
  }
  if (run.status === "loading") {
    return <Aviso probe="execucao">{t("runs.detail.loading")}</Aviso>;
  }
  if (run.data === undefined) {
    return <Aviso probe="execucao">{t("runs.detail.missing", { runId })}</Aviso>;
  }

  const detalhe = relido ?? run.data;
  // O primeiro passo com saida carrega o marcador do bloco de codigo, que e
  // por onde o smoke confere que o destaque do shiki chegou: ele precisa de um
  // alvo estavel, e nao do primeiro `pre` que aparecer na tela.
  const comSaida = detalhe.steps.find((p) => p.output !== null)?.stepKey ?? null;

  const veredito = extrairVeredito(detalhe.steps);
  const achadosLista = achados.data ?? [];
  const target = detalhe.target;
  const ehPr = Boolean(target && (target.pull || target.repo));

  return (
    <div
      className="flex flex-col gap-5"
      data-achados={achados.data?.length ?? -1}
      data-chaves={detalhe.steps.map((p) => p.stepKey).join(",")}
      data-locum-probe="execucao"
      data-passos={detalhe.steps.length}
      data-run={detalhe.id}
    >
      <div className="flex items-center gap-3">
        <Button onClick={() => navegar("runs")} size="sm" variant="ghost">
          <ArrowLeft className="size-4" />
          {t("runs.title")}
        </Button>
        <Estado status={detalhe.status} />
        <span className="font-medium text-sm">
          {detalhe.agentId}{" "}
          <span className="text-muted-foreground">
            {t("common.version", { version: detalhe.agentVersion })}
          </span>
        </span>
        <span className="text-muted-foreground text-xs">{quando(t, detalhe.createdAt)}</span>
        <span className="ml-auto text-sm tabular-nums">{dinheiro(t, detalhe)}</span>
      </div>

      {detalhe.error !== null ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          {detalhe.error}
        </p>
      ) : null}

      {/* Resumo Executivo: PR, Veredito e Achados em destaque */}
      {ehPr && target && <CardResumoPr target={target} />}
      {veredito && <BannerVeredito veredito={veredito} />}
      <DestaqueAchados achados={achadosLista} />

      {/* Grafo e Passos sempre visíveis no DOM para o React Flow medir as caixas e desenhar as arestas */}
      <GrafoDaExecucao detalhe={detalhe} />

      <ol className="flex flex-col gap-3">
        {detalhe.steps.map((passo) => (
          <li key={passo.id}>
            <PassoDaExecucao
              marcado={passo.stepKey === comSaida}
              passo={passo}
              runId={detalhe.id}
            />
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Extrai veredito (APPROVE, COMMENT, REQUEST_CHANGES) e sumário se algum step produziu. */
function extrairVeredito(steps: Passo[]): { tipo: "APPROVE" | "COMMENT" | "REQUEST_CHANGES"; resumo?: string } | null {
  for (const step of steps) {
    if (!step.output || typeof step.output !== "object") continue;
    const out = step.output as Record<string, unknown>;
    const v = out.verdict ?? (out.review as Record<string, unknown> | undefined)?.verdict;
    if (v === "APPROVE" || v === "COMMENT" || v === "REQUEST_CHANGES") {
      const resumo =
        typeof out.summary === "string"
          ? out.summary
          : typeof out.body === "string"
            ? out.body
            : typeof (out.review as Record<string, unknown> | undefined)?.body === "string"
              ? String((out.review as Record<string, unknown>).body)
              : undefined;
      return { tipo: v, resumo };
    }
  }
  return null;
}

/** Card de Resumo Executivo do PR no topo */
function CardResumoPr({ target }: { target: NonNullable<Detalhe["target"]> }) {
  const { t } = useTranslation();

  return (
    <div className="superficie flex flex-col gap-3 rounded-xl border border-border p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {target.repo && (
            <span className="bg-muted text-muted-foreground inline-flex items-center rounded-md px-2.5 py-1 font-mono text-xs font-medium">
              {target.repo}
            </span>
          )}
          {target.pull && (
            <span className="text-primary inline-flex items-center gap-1 font-mono text-sm font-semibold">
              <GitPullRequest aria-hidden className="size-4" />
              #{target.pull}
            </span>
          )}
          {target.author && (
            <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
              <User aria-hidden className="size-3.5 text-muted-foreground/70" />
              <span className="font-medium text-foreground">{target.author}</span>
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs">
          {target.headBranch && target.baseBranch && (
            <span className="inline-flex items-center gap-1.5 font-mono">
              <GitBranch aria-hidden className="size-3.5 text-muted-foreground" />
              <span className="text-foreground font-medium">{target.headBranch}</span>
              <span className="text-muted-foreground">→</span>
              <span className="text-muted-foreground">{target.baseBranch}</span>
            </span>
          )}
          {(target.additions !== undefined || target.deletions !== undefined) && (
            <span className="inline-flex items-center gap-1 font-mono tabular-nums">
              {target.fileCount !== undefined && (
                <span className="text-muted-foreground mr-1">
                  {target.fileCount} {target.fileCount === 1 ? "arq" : "arqs"} ·
                </span>
              )}
              {target.additions !== undefined && (
                <span className="text-emerald-500 font-medium">+{target.additions}</span>
              )}
              {target.deletions !== undefined && (
                <span className="text-rose-500 font-medium">−{target.deletions}</span>
              )}
            </span>
          )}
        </div>
      </div>

      {target.title && (
        <h2 className="text-base font-semibold tracking-tight text-foreground">
          {target.title}
        </h2>
      )}
    </div>
  );
}

/** Banner do Veredito da Auditoria */
function BannerVeredito({ veredito }: { veredito: { tipo: "APPROVE" | "COMMENT" | "REQUEST_CHANGES"; resumo?: string } }) {
  const { t } = useTranslation();

  const configs = {
    APPROVE: {
      bg: "bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400",
      icon: CheckCircle2,
      titulo: t("runs.verdict.APPROVE"),
    },
    REQUEST_CHANGES: {
      bg: "bg-destructive/10 border-destructive/30 text-destructive",
      icon: XCircle,
      titulo: t("runs.verdict.REQUEST_CHANGES"),
    },
    COMMENT: {
      bg: "bg-sky-500/10 border-sky-500/30 text-sky-600 dark:text-sky-400",
      icon: MessageSquareText,
      titulo: t("runs.verdict.COMMENT"),
    },
  }[veredito.tipo];

  const Icone = configs.icon;

  return (
    <div className={cn("flex flex-col gap-2 rounded-xl border p-4.5", configs.bg)}>
      <div className="flex items-center gap-2.5 font-semibold text-sm">
        <Icone aria-hidden className="size-5 shrink-0" />
        <span>{configs.titulo}</span>
      </div>
      {veredito.resumo && (
        <p className="text-foreground/90 text-sm leading-relaxed whitespace-pre-wrap pl-7.5">
          {veredito.resumo}
        </p>
      )}
    </div>
  );
}

/** Cards destacados de achados */
function DestaqueAchados({ achados }: { achados: ReadResult<"runs.findings"> }) {
  const { t } = useTranslation();

  if (achados.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm uppercase tracking-wider text-muted-foreground">
          {t("findings.count", { count: achados.length })}
        </h3>
      </div>
      <div className="grid grid-cols-1 gap-3">
        {achados.map((achado, i) => {
          const severidadeTinta =
            achado.severity === "critical"
              ? "border-sev-critical/40 bg-sev-critical/5"
              : achado.severity === "high"
                ? "border-sev-high/40 bg-sev-high/5"
                : achado.severity === "medium"
                  ? "border-sev-medium/40 bg-sev-medium/5"
                  : "border-border bg-card";

          const badgeVariant =
            achado.severity === "critical"
              ? "destructive"
              : achado.severity === "high"
                ? "destructive"
                : "secondary";

          return (
            <div
              className={cn("superficie flex flex-col gap-2.5 rounded-xl border p-4 transition-all", severidadeTinta)}
              key={`${achado.file ?? "sem-arquivo"}-${achado.line ?? i}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant={badgeVariant}>
                    {rotuloDeSeveridade(t, achado.severity)}
                  </Badge>
                  {achado.category && (
                    <span className="text-muted-foreground text-xs uppercase tracking-wide">
                      {achado.category}
                    </span>
                  )}
                </div>
                {(achado.file || achado.line !== undefined) && (
                  <span className="text-muted-foreground inline-flex items-center gap-1 font-mono text-xs">
                    <FileCode aria-hidden className="size-3.5" />
                    <span className="font-medium text-foreground">{achado.file ?? t("findings.general")}</span>
                    {achado.line !== undefined && <span>:{achado.line}</span>}
                  </span>
                )}
              </div>

              <p className="text-foreground text-sm font-medium leading-relaxed">
                {achado.problem}
              </p>

              {achado.fix && (
                <div className="mt-1 flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/40 p-3 text-xs">
                  <span className="font-semibold text-muted-foreground uppercase tracking-wider text-[10px]">
                    {t("runs.fixSuggestion")}
                  </span>
                  <p className="font-mono text-foreground/90 leading-relaxed whitespace-pre-wrap">
                    {achado.fix}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Seção colapsável de Pipeline & Detalhes Técnicos */
function SecaoDetalhesTecnicos({
  comSaida,
  detalhe,
}: {
  comSaida: string | null;
  detalhe: Detalhe;
}) {
  const { t } = useTranslation();
  const [aberto, setAberto] = useState(false);

  return (
    <div className="mt-2 flex flex-col gap-3 rounded-xl border border-border/80 bg-background/50 p-4">
      <button
        className="flex w-full cursor-pointer items-center justify-between text-left transition-colors hover:text-foreground"
        onClick={() => setAberto((v) => !v)}
        type="button"
      >
        <div className="flex flex-col gap-0.5">
          <span className="font-semibold text-sm text-foreground">
            {t("runs.technicalDetails")}
          </span>
          <span className="text-muted-foreground text-xs">
            {t("runs.technicalDetailsHint")}
          </span>
        </div>
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <span>{aberto ? t("inbox.collapse") : t("common.open_github") ? "expandir" : "expand"}</span>
          <ChevronDown
            aria-hidden
            className={cn("size-4 transition-transform duration-200", aberto && "rotate-180")}
          />
        </div>
      </button>

      {/* O GrafoDaExecucao e os passos permanecem montados para manter probes estáveis */}
      <div className={cn("flex flex-col gap-4 pt-2", !aberto && "hidden")}>
        <GrafoDaExecucao detalhe={detalhe} />

        <ol className="flex flex-col gap-3">
          {detalhe.steps.map((passo) => (
            <li key={passo.id}>
              <PassoDaExecucao
                marcado={passo.stepKey === comSaida}
                passo={passo}
                runId={detalhe.id}
              />
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/**
 * Um passo na linha do tempo.
 *
 * O `Reasoning` guarda como o passo foi resolvido, que e a parte que some da
 * tela quando tudo da certo e e a primeira que se procura quando nao da: qual
 * modelo foi pedido, qual rodou, por que trocou, e quais skills entraram.
 */
function PassoDaExecucao({
  marcado,
  passo,
  runId,
}: {
  marcado: boolean;
  passo: Passo;
  runId: string;
}) {
  const { t } = useTranslation();
  const rodando = passo.status === "running";
  const segundos =
    passo.startedAt !== null && passo.endedAt !== null
      ? passo.endedAt - passo.startedAt
      : rodando && passo.startedAt !== null
        ? Math.max(0, Math.round(Date.now() / 1000) - passo.startedAt)
        : undefined;
  const atividade = lista(passo.activity) as Atividade[];
  const ferramentas = lista(passo.toolsUsed);
  const skills = lista(passo.skillsUsed).map((s) =>
    typeof s === "object" && s !== null && "name" in s ? String((s as { name: unknown }).name) : String(s),
  );

  return (
    <div className="rounded-lg border border-border px-4 py-3" data-locum-passo={passo.stepKey}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground tabular-nums">{passo.idx + 1}</span>
        <span className="font-medium">{passo.name}</span>
        <Estado status={passo.status} />
        <span className="text-muted-foreground text-xs" title={passo.modelUsed ?? undefined}>
          {passo.modelUsed !== null ? rotuloDoModelo(passo.modelUsed) : t("runs.step.action")}
          {passo.substitutionReason !== null ? ` ${t("runs.step.substituted")}` : ""}
        </span>
        <span className="ml-auto flex items-center gap-3 text-muted-foreground text-xs tabular-nums">
          <span>{segundos === undefined ? "-" : t("runs.step.seconds", { seconds: segundos })}</span>
          <span>
            {t("runs.step.tokens", { tokens: passo.promptTokens + passo.completionTokens })}
          </span>
          <span>{t("runs.step.cost", { cost: passo.costUsd.toFixed(3) })}</span>
          <Reexecutar runId={runId} stepKey={passo.stepKey} />
        </span>
      </div>

      {passo.error !== null ? (
        <p className="mt-2 text-destructive text-xs">{rotuloDoMotivo(t, passo.error)}</p>
      ) : null}

      {ferramentas.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {ferramentas.map((nome) => (
            <Badge key={String(nome)} variant="outline">
              {String(nome)}
            </Badge>
          ))}
        </div>
      ) : null}

      {atividade.length > 0 || (rodando && passo.modelRequested !== null) ? (
        <AtividadeDoPasso atividade={atividade} rodando={rodando} />
      ) : null}

      {passo.modelRequested !== null ? (
        <Reasoning className="mt-3" defaultOpen={false} duration={segundos}>
          <ReasoningTrigger>{t("runs.step.reasoning.trigger")}</ReasoningTrigger>
          <ReasoningContent>
            {[
              t("runs.step.reasoning.requested", { model: rotuloDoModelo(passo.modelRequested) }),
              t("runs.step.reasoning.used", {
                model: passo.modelUsed !== null ? rotuloDoModelo(passo.modelUsed) : t("runs.step.reasoning.none"),
              }),
              passo.substitutionReason !== null
                ? t("runs.step.reasoning.substitution", { reason: passo.substitutionReason })
                : t("runs.step.reasoning.noSubstitution"),
              skills.length > 0
                ? t("runs.step.reasoning.skills", { skills: skills.join(", ") })
                : t("runs.step.reasoning.noSkills"),
              t("runs.step.reasoning.attempt", {
                attempt: passo.attempt,
                count: passo.promptTokens,
                completion: passo.completionTokens,
              }),
            ].join("\n\n")}
          </ReasoningContent>
        </Reasoning>
      ) : null}

      {/*
        Entrada vazia não vira bloco. O primeiro passo de um pipeline não
        depende de ninguém, e mostrar `{"needs": []}` num bloco de código
        ocupa oito linhas para dizer nada.
      */}
      {temConteudo(passo.input) ? (
        <Json rotulo={t("runs.step.input")} valor={passo.input} />
      ) : null}
      {passo.output !== null ? (
        <Json marcado={marcado} rotulo={t("runs.step.output")} valor={passo.output} />
      ) : null}
    </div>
  );
}

type Atividade = {
  at: number;
  tipo: "ferramenta" | "resultado" | "texto";
  ferramenta?: string;
  detalhe?: string;
  erro?: boolean;
  ms?: number;
};

/**
 * O que o passo de modelo fez, em ordem: cada ferramenta chamada com os
 * argumentos, o que ela devolveu e quanto levou, e o que o modelo escreveu
 * entre uma e outra. Com o passo andando, a lista segue o fim sozinha.
 */
function AtividadeDoPasso({ atividade, rodando }: { atividade: Atividade[]; rodando: boolean }) {
  const { t } = useTranslation();
  const caixa = useRef<HTMLOListElement>(null);
  const chamadas = atividade.filter((a) => a.tipo === "ferramenta").length;
  const erros = atividade.filter((a) => a.erro === true).length;

  useEffect(() => {
    if (rodando && caixa.current !== null) caixa.current.scrollTop = caixa.current.scrollHeight;
  }, [atividade.length, rodando]);

  return (
    <div className="mt-3 flex flex-col gap-2" data-locum-atividade={atividade.length}>
      <span className="text-muted-foreground text-xs">
        {t("runs.step.activity.title", { count: chamadas })}
        {erros > 0 ? ` · ${t("runs.step.activity.errors", { count: erros })}` : ""}
      </span>
      <ol className="border-border superficie flex max-h-96 flex-col gap-1.5 overflow-y-auto rounded-md border p-3" ref={caixa}>
        {atividade.map((a, i) => (
          <li className="flex items-start gap-2 text-xs" key={`${a.at}-${i}`}>
            <span className="text-muted-foreground w-14 shrink-0 pt-0.5 font-mono tabular-nums">
              {new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
            {a.tipo === "ferramenta" ? (
              <>
                <Wrench aria-hidden className="text-primary mt-0.5 size-3.5 shrink-0" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-mono font-medium">{a.ferramenta}</span>
                  {a.detalhe !== undefined && a.detalhe !== "{}" ? (
                    <span className="text-muted-foreground font-mono break-all">{a.detalhe}</span>
                  ) : null}
                </span>
              </>
            ) : a.tipo === "resultado" ? (
              <>
                <CornerDownRight aria-hidden className="text-muted-foreground mt-0.5 ml-3 size-3.5 shrink-0" />
                {a.erro === true ? (
                  <X aria-hidden className="text-sev-critical mt-0.5 size-3.5 shrink-0" />
                ) : (
                  <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
                )}
                <span className={cn("min-w-0 flex-1 break-all font-mono", a.erro === true ? "text-sev-critical" : "text-muted-foreground")}>
                  {a.detalhe === undefined || a.detalhe === "" ? t("runs.step.activity.empty") : a.detalhe}
                </span>
                {a.ms === undefined ? null : (
                  <span className="text-muted-foreground shrink-0 font-mono tabular-nums">
                    {t("runs.step.activity.took", { seconds: (a.ms / 1000).toFixed(1) })}
                  </span>
                )}
              </>
            ) : (
              <>
                <MessageSquareText aria-hidden className="mt-0.5 size-3.5 shrink-0 text-violet-300" />
                <span className="min-w-0 flex-1">{a.detalhe}</span>
              </>
            )}
          </li>
        ))}
        {rodando ? (
          <li className="text-muted-foreground flex items-center gap-2 text-xs">
            <span className="w-14 shrink-0" />
            <Loader2 aria-hidden className="size-3.5 animate-spin" />
            {atividade.length === 0 ? t("runs.step.activity.starting") : t("runs.step.activity.working")}
          </li>
        ) : null}
      </ol>
    </div>
  );
}

/**
 * O botao de reexecutar.
 *
 * Ele manda `wait: false` porque o pipeline leva minutos: esperar o desfecho
 * deixaria a promessa do IPC pendurada e a tela travada com um botao que nao
 * volta. O servico zera o passo e os que dependem dele antes de soltar o
 * executor, entao o que a tela le depois ja e o estado novo.
 */
function Reexecutar({ runId, stepKey }: { runId: string; stepKey: string }) {
  const { t } = useTranslation();
  const [estado, setEstado] = useState<"parado" | "pedindo" | "erro">("parado");

  return (
    <Button
      data-locum-rerun={stepKey}
      disabled={estado === "pedindo"}
      onClick={() => {
        setEstado("pedindo");
        call("runs.rerunStep", runId, stepKey, { wait: false }).then(
          () => globalThis.location.reload(),
          () => setEstado("erro"),
        );
      }}
      size="sm"
      title={
        estado === "erro" ? t("runs.rerun.refused") : t("runs.rerun.title", { step: stepKey })
      }
      variant="ghost"
    >
      <RotateCcw className={cn("size-3.5", estado === "erro" && "text-destructive")} />
    </Button>
  );
}

function Achados({ achados }: { achados: ReadResult<"runs.findings"> }) {
  const { t } = useTranslation();

  if (achados.length === 0) return null;

  return (
    <Task defaultOpen>
      <TaskTrigger title={t("findings.count", { count: achados.length })} />
      <TaskContent>
        {achados.map((achado, i) => (
          <TaskItem key={`${achado.file ?? "sem-arquivo"}-${achado.line ?? i}`}>
            <Badge variant={achado.severity === "critical" ? "destructive" : "secondary"}>
              {rotuloDeSeveridade(t, achado.severity)}
            </Badge>{" "}
            <TaskItemFile>
              {achado.file ?? t("findings.general")}
              {achado.line === undefined ? "" : `:${achado.line}`}
            </TaskItemFile>{" "}
            {achado.problem}
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  );
}

/* ----------------------------------------------------------------- pedacos */

function Json({
  marcado = false,
  rotulo,
  valor,
}: {
  marcado?: boolean;
  rotulo: string;
  valor: unknown;
}) {
  const { t } = useTranslation();
  const legivel = valor !== null && typeof valor === "object";
  // Digest tem leitura própria: lido como campos genéricos, vira parede de texto.
  const digest = lerDigest(valor);

  return (
    <div className="mt-2" {...(marcado ? { "data-locum-probe": "code-block" } : {})}>
      <p className="mb-1 text-muted-foreground text-xs">{rotulo}</p>
      {/*
        O que o modelo devolveu é um objeto, e lido como lista de campos ele se
        entende sem saber JSON. O texto cru continua a um clique, para copiar
        ou conferir o que a ação recebeu.
      */}
      {digest !== null ? (
        <LeituraDoDigest digest={digest} />
      ) : legivel ? (
        <div className="rounded-md border border-border px-3 py-2">
          <Valor valor={valor} />
        </div>
      ) : null}
      <details className="mt-1" open={!legivel}>
        <summary className="cursor-pointer text-muted-foreground text-xs">{t("runs.step.raw")}</summary>
        <div className="mt-1">
          <CodeBlock code={JSON.stringify(valor, null, 2)} language="json">
            <CodeBlockCopyButton />
          </CodeBlock>
        </div>
      </details>
    </div>
  );
}

/** `risk_areas` e `riskAreas` viram "Risk areas". */
function rotuloDoCampo(chave: string): string {
  const palavras = chave
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return palavras.charAt(0).toUpperCase() + palavras.slice(1);
}

function simples(valor: unknown): boolean {
  return valor === null || typeof valor !== "object";
}

/**
 * Um valor qualquer da saída, desenhado pelo formato: texto vira parágrafo,
 * lista de textos vira lista, objeto vira campos com rótulo. Três níveis
 * bastam para o que um passo devolve; abaixo disso vai o JSON compacto.
 */
function Valor({ valor, nivel = 0 }: { valor: unknown; nivel?: number }) {
  if (simples(valor)) {
    return <span className="whitespace-pre-wrap text-sm">{valor === null ? "-" : String(valor)}</span>;
  }
  if (nivel >= 3) {
    return <code className="break-all font-mono text-xs">{JSON.stringify(valor)}</code>;
  }
  if (Array.isArray(valor)) {
    if (valor.length === 0) return <span className="text-muted-foreground text-sm">-</span>;
    return (
      <ul className={cn("flex flex-col gap-1", valor.every(simples) && "list-disc pl-5")}>
        {valor.map((item, i) => (
          <li
            className={simples(item) ? undefined : "rounded-md border border-border/60 px-2 py-1"}
            // A posição é a identidade: a saída não muda depois de gravada.
            key={i}
          >
            <Valor nivel={nivel + 1} valor={item} />
          </li>
        ))}
      </ul>
    );
  }
  const campos = Object.entries(valor as Record<string, unknown>);
  return (
    <dl className="flex flex-col gap-1.5">
      {campos.map(([chave, item]) => (
        <div className={simples(item) ? "flex flex-wrap items-baseline gap-x-2" : "flex flex-col gap-0.5"} key={chave}>
          <dt className="text-muted-foreground text-xs leading-5">{rotuloDoCampo(chave)}</dt>
          <dd>
            <Valor nivel={nivel + 1} valor={item} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** As cores dos estados, num lugar so, porque lista e detalhe mostram os mesmos. */
const CORES: Record<Estado, "default" | "secondary" | "destructive" | "outline"> = {
  done: "secondary",
  running: "default",
  queued: "outline",
  pending: "outline",
  paused: "default",
  awaiting_approval: "default",
  skipped: "outline",
  failed: "destructive",
  cancelled: "outline",
};

/**
 * O crachá de estado.
 *
 * O marcador guarda o estado cru, e não o traduzido: o smoke compara com o que
 * o serviço devolve, e comparar contra texto de tela faria a verificação
 * depender do idioma da máquina que roda o loop.
 */
/**
 * Cor de estado é vocabulário próprio, e não o azul de ação.
 *
 * Um selo azul em "pausado" compete com o botão que a pessoa deve clicar, e
 * pinta de importante um estado que só está esperando.
 */
const TINTA_DE_ESTADO: Record<string, string> = {
  done: "text-chart-2",
  running: "text-primary",
  queued: "text-muted-foreground",
  paused: "text-sev-medium",
  failed: "text-sev-critical",
  cancelled: "text-muted-foreground",
};

/** Vazio, objeto sem chave, ou objeto cujas chaves estão todas vazias. */
function temConteudo(valor: unknown): boolean {
  if (valor === null || valor === undefined) return false;
  if (Array.isArray(valor)) return valor.length > 0;
  if (typeof valor !== "object") return true;

  const entradas = Object.values(valor as Record<string, unknown>);
  return entradas.length > 0 && entradas.some((v) => temConteudo(v));
}

function Estado({ status }: { status: string }) {
  const { t } = useTranslation();

  return (
    <span
      className={cn("shrink-0 font-medium", TINTA_DE_ESTADO[status] ?? "text-muted-foreground")}
      data-locum-estado={status}
    >
      {rotuloDeEstado(t, status)}
    </span>
  );
}

function Aviso({ children, probe }: { children: React.ReactNode; probe: string }) {
  return (
    <p className="text-muted-foreground text-sm" data-locum-probe={probe} data-passos={-1}>
      {children}
    </p>
  );
}

/** O que sai de coluna JSON chega como `unknown`: so vira lista se for uma. */
function lista(valor: unknown): unknown[] {
  return Array.isArray(valor) ? valor : [];
}

/**
 * Tempo em palavra, e não carimbo de máquina.
 *
 * `2026-09-20 02:06` obriga a fazer a conta de cabeça para saber se foi hoje.
 * Perto do agora, a distância é o que importa; longe, a data.
 */
function quando(t: TFunction, segundos: number): string {
  const horas = Math.floor((Date.now() / 1000 - segundos) / 3600);
  if (horas < 1) return t("runs.when_now");
  if (horas < 24) return t("runs.when_hours", { hours: horas });
  if (horas < 24 * 7) return t("runs.when_days", { days: Math.floor(horas / 24) });
  return t("runs.when_date", {
    date: new Date(segundos * 1000).toLocaleDateString(undefined, {
      day: "2-digit",
      month: "2-digit",
    }),
  });
}

/**
 * O par cobrado e equivalente, sempre junto.
 *
 * Passo que roda na assinatura nao cobra dinheiro, e mostrar so o cobrado faria
 * toda execucao parecer gratuita.
 */
/**
 * Um número, não um par separado por barra.
 *
 * O que interessa de relance é quanto aquela execução custou. Quando o gasto
 * saiu da assinatura, ele não é dinheiro cobrado, e o til diz isso sem precisar
 * de uma segunda coluna que nunca cabe na linha.
 */
function dinheiro(t: TFunction, run: { costUsd: number; estimateUsd: number }): string {
  if (run.costUsd > 0) return t("runs.money_billed", { amount: run.costUsd.toFixed(2) });
  if (run.estimateUsd > 0) return t("runs.money_equivalent", { amount: run.estimateUsd.toFixed(2) });
  return t("runs.money_free");
}
