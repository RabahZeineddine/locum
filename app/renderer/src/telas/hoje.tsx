import {
  Activity,
  CalendarClock,
  Check,
  CheckCheck,
  ChevronRight,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Inbox as InboxIcon,
  KeyRound,
  MessageSquare,
  RefreshCw,
  Sparkles,
  TerminalSquare,
  User,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { call, read, useRead, type ReadResult } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import type { TelaProps } from "../rotas";
import { alvoDaPendencia, idade } from "./inbox";

type Pendencia = ReadResult<"approvals.listPending">[number];
type Agenda = ReadResult<"triggers.schedule">[number];
type Execucao = ReadResult<"runs.list">[number];

/** Quantas linhas cada bloco mostra. A tela é de relance: o resto mora na fila e nas execuções. */
const LIMITE = 5;

/** "Terminou" olha dois dias para trás: o que acabou ontem à noite ainda é notícia de manhã. */
const JANELA_DO_TERMINOU_S = 48 * 3600;

/**
 * O último alvo de notificação que esta tela já encaminhou para a fila.
 *
 * A fila lia o alvo ao montar, e ela era a tela de abertura. Agora quem abre é
 * esta, então o clique na notificação passa por aqui e segue para a fila, que
 * continua sendo quem abre o item. O alvo fica guardado no processo principal
 * até o próximo clique, e sem esta lembrança toda volta à Hoje empurraria a
 * pessoa de novo para a fila pelo mesmo clique antigo.
 */
let alvoEncaminhado: string | null = null;

/**
 * A tela de abertura: o que espera a pessoa, o que roda a seguir e o que já
 * terminou.
 *
 * Ela só lê e aponta. Decidir continua na revisão, e nada aqui dispensa uma
 * pendência: aprovação não some porque alguém disse que já fez, ela fecha
 * quando a porta de saída decide.
 */
export function Hoje({ navegar }: TelaProps) {
  const { t, i18n } = useTranslation();
  const idioma = i18n.language;

  const pendentes = useRead("approvals.listPending");
  const agenda = useRead("triggers.schedule");
  const terminadas = useRead("runs.list", { status: "done", limit: 50 });
  const falhadas = useRead("runs.list", { status: "failed", limit: 20 });
  const todas24h = useRead("runs.list", { limit: 100 });
  const agents = useRead("agents.list");
  const iniciativas = useRead("initiatives.list");

  useEffect(() => {
    void read("window.inboxTarget")
      .then((alvo) => {
        if (alvo === null || alvo === alvoEncaminhado) return;
        alvoEncaminhado = alvo;
        navegar("inbox");
      })
      .catch(() => undefined);
  }, [navegar]);

  // A iniciativa sai do agent: pendência e gatilho não carregam a própria, e
  // as duas listas são pequenas o bastante para juntar aqui sem outra viagem.
  const iniciativaDoAgent = useMemo(() => {
    const titulos = new Map((iniciativas.data ?? []).map((i) => [i.id, i.title]));
    return new Map(
      (agents.data ?? []).map((a) => [a.id, a.initiativeId ? titulos.get(a.initiativeId) : undefined]),
    );
  }, [agents.data, iniciativas.data]);
  const tituloDaIniciativa = (id: string | null | undefined) =>
    id ? (iniciativas.data ?? []).find((i) => i.id === id)?.title : undefined;
  const nomeDoAgent = new Map((agents.data ?? []).map((a) => [a.id, a.name]));

  const fila = pendentes.data ?? [];
  const [verificando, setVerificando] = useState(false);

  const checarAgora = async () => {
    setVerificando(true);
    try {
      await call("triggers.tick");
    } catch {
      // Ignora erro de rede ou cancelamento para a UI não quebrar
    } finally {
      setTimeout(() => setVerificando(false), 800);
    }
  };

  const ativos = useMemo(
    () => (agenda.data ?? []).filter((g) => g.enabled),
    [agenda.data],
  );

  const mcp = useRead("mcp.list");

  /**
   * Saúde real de cada monitor: o servidor MCP de que o gatilho depende e a
   * última conexão dele. Grafana caindo deixa o card vermelho, não verde:
   * "ouvindo" só vale quando a última conexão foi boa ou nunca falhou.
   */
  const saudePorAgent = useMemo(() => {
    const mapa = new Map<string, { saude: "ok" | "falha" | "desconhecido"; quando: string; erro?: string }>();
    const servidores = mcp.data ?? [];
    for (const g of agenda.data ?? []) {
      const carga = (g.config ?? {}) as Record<string, unknown>;
      const deps = Array.isArray(carga.requiresServers) ? (carga.requiresServers as string[]) : [];
      if (deps.length === 0) {
        mapa.set(g.agentId, { saude: "ok", quando: "" });
        continue;
      }
      const nomeDoServidor = deps[0]!;
      const entrada = servidores.find((s) => s.config.name === nomeDoServidor);
      if (entrada === undefined) {
        mapa.set(g.agentId, { saude: "desconhecido", quando: "" });
        continue;
      }
      const saude = entrada.health;
      if (saude.lastOkAt !== null && (saude.lastFailureAt === null || saude.lastOkAt > saude.lastFailureAt)) {
        mapa.set(g.agentId, { saude: "ok", quando: tempoRelativoCurto(t, saude.lastOkAt / 1000) });
      } else if (saude.lastFailureAt !== null) {
        mapa.set(g.agentId, {
          saude: "falha",
          quando: tempoRelativoCurto(t, saude.lastFailureAt / 1000),
          erro: saude.lastError ?? undefined,
        });
      } else {
        mapa.set(g.agentId, { saude: "desconhecido", quando: "" });
      }
    }
    return mapa;
  }, [agenda.data, mcp.data, t]);

  const proximas = useMemo(
    () =>
      (agenda.data ?? [])
        .filter((g): g is Agenda & { nextDueAt: number } => g.enabled && g.nextDueAt !== null)
        .sort((a, b) => a.nextDueAt - b.nextDueAt)
        .slice(0, LIMITE),
    [agenda.data],
  );

  const recentes = useMemo(() => {
    const corte = Date.now() / 1000 - JANELA_DO_TERMINOU_S;
    return (terminadas.data ?? [])
      .filter((r) => (r.endedAt ?? r.createdAt) >= corte)
      .sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt))
      .slice(0, LIMITE);
  }, [terminadas.data]);

  const metricasExecutivas = useMemo(() => {
    const corte24h = Date.now() / 1000 - 24 * 3600;
    const lista24h = (todas24h.data ?? []).filter((r) => r.createdAt >= corte24h);
    const custoTotal = lista24h.reduce((acc, r) => acc + (r.costUsd > 0 ? r.costUsd : r.estimateUsd || 0), 0);
    const falhas24h = (falhadas.data ?? []).filter((r) => r.createdAt >= corte24h).length;
    return {
      total24h: lista24h.length,
      custoTotal,
      falhas24h,
    };
  }, [todas24h.data, falhadas.data]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 pt-2">
      <header className="flex flex-col gap-2 pt-4">
        <span className="text-muted-foreground font-medium text-xs uppercase tracking-[0.08em]">
          {dataDeHoje(idioma)}
        </span>
        <h1 className="font-semibold text-[32px] leading-tight tracking-[-0.02em]">
          <span className="ia-texto">{t("home.today.title")}</span>
        </h1>
        <p className="text-muted-foreground text-[15px]">{t("home.today.lead")}</p>
      </header>

      {/* Resumo Executivo Operacional */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div
          className="superficie flex cursor-pointer flex-col gap-1 rounded-xl p-3.5 transition-colors hover:border-foreground/20"
          onClick={() => navegar("inbox")}
        >
          <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.06em]">
            {t("home.today.kpi.waiting")}
          </span>
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                "font-mono text-2xl font-semibold",
                fila.length > 0 ? "text-sev-medium" : "text-foreground",
              )}
            >
              {fila.length}
            </span>
            <span className="text-muted-foreground text-xs">
              {fila.length === 1 ? t("home.today.kpi.item") : t("home.today.kpi.items")}
            </span>
          </div>
        </div>

        <div
          className="superficie flex cursor-pointer flex-col gap-1 rounded-xl p-3.5 transition-colors hover:border-foreground/20"
          onClick={() => navegar("agents")}
        >
          <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.06em]">
            {t("home.today.kpi.active_watch")}
          </span>
          <div className="flex items-baseline gap-2">
            <span className="text-emerald-500 font-mono text-2xl font-semibold">
              {ativos.length}
            </span>
            <span className="text-muted-foreground text-xs">{t("home.today.kpi.monitors")}</span>
          </div>
        </div>

        <div
          className="superficie flex cursor-pointer flex-col gap-1 rounded-xl p-3.5 transition-colors hover:border-foreground/20"
          onClick={() => navegar("runs")}
        >
          <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.06em]">
            {t("home.today.kpi.runs_today")}
          </span>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-semibold text-foreground">
              {metricasExecutivas.total24h}
            </span>
            {metricasExecutivas.falhas24h > 0 && (
              <span className="text-sev-critical text-xs font-medium">
                ({metricasExecutivas.falhas24h} {t("home.today.kpi.failures")})
              </span>
            )}
          </div>
        </div>

        <div
          className="superficie flex cursor-pointer flex-col gap-1 rounded-xl p-3.5 transition-colors hover:border-foreground/20"
          onClick={() => navegar("runs")}
        >
          <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.06em]">
            {t("home.today.kpi.cost_24h")}
          </span>
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-semibold text-foreground">
              ${metricasExecutivas.custoTotal.toFixed(2)}
            </span>
            <span className="text-muted-foreground text-xs">{t("home.today.kpi.currency")}</span>
          </div>
        </div>
      </div>

      <ComeceAqui agenda={agenda.data} navegar={navegar} />

      <section aria-labelledby="hoje-espera" className="flex flex-col gap-3">
        <h2
          className={cn(
            "font-semibold text-xs uppercase tracking-[0.06em]",
            fila.length > 0 ? "text-sev-medium" : "text-muted-foreground",
          )}
          data-estado={pendentes.status}
          data-locum-probe="today"
          data-pendencias={pendentes.status === "ready" ? fila.length : -1}
          id="hoje-espera"
        >
          {t("home.today.waiting.title", { count: fila.length })}
        </h2>

        {pendentes.status === "error" ? (
          <p className="text-muted-foreground text-sm">
            {t("home.today.refused", { message: pendentes.error.message })}
          </p>
        ) : pendentes.status === "ready" && fila.length === 0 ? (
          <Vazio icone={InboxIcon} texto={t("home.today.waiting.empty")} />
        ) : (
          <ul className="flex flex-col gap-3">
            {fila.slice(0, LIMITE).map((p) => (
              <CartaoDeEspera
                iniciativa={iniciativaDoAgent.get(p.agentId)}
                key={p.id}
                navegar={navegar}
                pendencia={p}
              />
            ))}
          </ul>
        )}

        {fila.length > LIMITE && (
          <button
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex cursor-pointer items-center gap-1 self-start rounded text-sm transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none"
            onClick={() => navegar("inbox")}
            type="button"
          >
            {t("home.today.waiting.more", { count: fila.length - LIMITE })}
            <ChevronRight aria-hidden className="size-4" />
          </button>
        )}
      </section>

      <ServidoresSemCredencial navegar={navegar} />

      <SessoesPelaMetade navegar={navegar} />

      {/* Painel Central de Vigilância Ativa - Cockpit Grid */}
      <section aria-labelledby="hoje-proximas" className="flex flex-col gap-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="relative flex size-2.5">
              {ativos.length > 0 ? (
                <>
                  <span className="bg-emerald-400 absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" />
                  <span className="bg-emerald-500 relative inline-flex size-2.5 rounded-full" />
                </>
              ) : (
                <span className="bg-muted-foreground/40 relative inline-flex size-2.5 rounded-full" />
              )}
            </span>
            <div className="flex items-baseline gap-2">
              <h2
                className="text-foreground font-semibold text-sm tracking-tight"
                id="hoje-proximas"
              >
                {t("home.today.next.watch_title", { defaultValue: "Monitores em Tempo Real" })}
              </h2>
              {ativos.length > 0 && (
                <span className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-mono text-[11px] font-semibold px-2 py-0.5 rounded-full border border-emerald-500/20">
                  {t("home.today.next.watch_badge", { count: ativos.length })}
                </span>
              )}
            </div>
          </div>

          <Button
            className="text-muted-foreground hover:text-foreground h-7 px-2.5 text-xs gap-1.5 font-medium cursor-pointer"
            disabled={verificando}
            onClick={checarAgora}
            size="sm"
            variant="outline"
          >
            <RefreshCw className={cn("size-3.5", verificando && "animate-spin text-primary")} />
            <span>{verificando ? t("home.today.next.checking") : t("home.today.next.check_now")}</span>
          </Button>
        </div>

        {proximas.length === 0 ? (
          <Vazio
            icone={CalendarClock}
            texto={agenda.status === "loading" ? t("home.today.loading") : t("home.today.next.empty")}
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {proximas.map((g) => {
              const ultima = g.lastFireAt ? tempoRelativoCurto(t, g.lastFireAt / 1000) : undefined;
              const nome = nomeDoAgent.get(g.agentId) ?? g.agentId;
              const iniciativa = iniciativaDoAgent.get(g.agentId);
              const saude = saudePorAgent.get(g.agentId);

              const falhou = saude?.saude === "falha";

              return (
                <div
                  className={cn(
                    "superficie flex cursor-pointer flex-col justify-between gap-3 rounded-xl border p-4 transition-all hover:shadow-sm",
                    falhou
                      ? "border-destructive/40 bg-destructive/[0.03] hover:border-destructive/60"
                      : "hover:border-foreground/30",
                  )}
                  key={g.triggerId}
                  onClick={() => navegar("runs", g.agentId)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="flex items-start justify-between gap-2.5">
                    <div className="flex flex-col gap-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-semibold text-sm tracking-tight text-foreground">
                          {nome}
                        </span>
                        {iniciativa && (
                          <span className="bg-muted text-muted-foreground truncate rounded px-1.5 py-0.5 text-[10px] font-medium">
                            {iniciativa}
                          </span>
                        )}
                      </div>
                      <span className="text-muted-foreground text-xs font-mono">
                        {g.kind} · {g.everyMinutes ? t("common.cadence", { minutes: g.everyMinutes, defaultValue: `cada ${g.everyMinutes}m` }) : "agendado"}
                      </span>
                    </div>

                    {falhou ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-2 py-0.5 font-mono text-[11px] font-medium text-destructive shrink-0">
                        <span className="size-1.5 rounded-full bg-destructive animate-pulse" />
                        {t("home.today.next.health_failed", { defaultValue: "conexão falhou" })}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 font-mono text-[11px] font-medium text-emerald-600 dark:text-emerald-400 shrink-0">
                        <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        {t("home.today.next.active_synced", { defaultValue: "ouvindo" })}
                      </span>
                    )}
                  </div>

                  {falhou && saude?.erro && (
                    <p className="text-destructive/90 line-clamp-2 text-[11px] leading-relaxed break-words" title={saude.erro}>
                      {saude.erro}
                    </p>
                  )}

                  <div className="flex items-baseline justify-between border-t border-border/60 pt-2.5 text-xs text-muted-foreground">
                    <span>
                      {ultima ? t("home.today.next.last_checked", { when: ultima }) : "aguardando primeira batida"}
                    </span>
                    <span className="font-mono text-primary font-medium">
                      próxima: {quandoRoda(t, idioma, g.nextDueAt)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section aria-labelledby="hoje-terminou" className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2
            className="text-foreground font-semibold text-sm tracking-tight"
            id="hoje-terminou"
          >
            {t("home.today.done.title", { defaultValue: "Auditorias & Execuções Recentes" })}
          </h2>
          <Button
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
            onClick={() => navegar("runs")}
            size="sm"
            variant="ghost"
          >
            ver todas
          </Button>
        </div>
        {recentes.length === 0 ? (
          <Vazio
            icone={CheckCheck}
            texto={terminadas.status === "loading" ? t("home.today.loading") : t("home.today.done.empty")}
          />
        ) : (
          <ul className="divide-border border-border superficie divide-y overflow-hidden rounded-xl border">
            {recentes.map((r) => (
              <LinhaTerminada
                iniciativa={tituloDaIniciativa(r.initiativeId) ?? iniciativaDoAgent.get(r.agentId)}
                idioma={idioma}
                key={r.id}
                navegar={navegar}
                run={r}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Uma pendência, dita do jeito que se decide: de onde veio, o que é, e o botão
 * que leva à revisão dela. O mesmo texto da fila, para a pessoa reconhecer o
 * item quando chegar lá.
 */
function CartaoDeEspera({
  iniciativa,
  navegar,
  pendencia,
}: {
  iniciativa: string | undefined;
  navegar: TelaProps["navegar"];
  pendencia: Pendencia;
}) {
  const { t } = useTranslation();
  const alvo = alvoDaPendencia(pendencia, t);
  const { texto: quando } = idade(t, pendencia.createdAt);
  const titulo = alvo.titulo ?? alvo.principal;
  const ehPr = Boolean(alvo.pull || alvo.repo);
  const ehMsg = Boolean(alvo.servico || pendencia.kind === "slack.post" || pendencia.kind === "teams.post");
  // Pendência sem pull request já traz o nome do agent no título; repetir em
  // cima só faz a linha dizer a mesma coisa duas vezes.
  const rotulo = iniciativa ?? (titulo.includes(pendencia.agentName) ? undefined : pendencia.agentName);

  return (
    <li className="ia-borda group flex items-center gap-4 rounded-xl px-5 py-4 shadow-[0_8px_30px_-16px_var(--ia-2)]">
      <span
        aria-hidden
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg",
          ehMsg ? "bg-amber-500/12 text-amber-500" : "bg-primary/12 text-primary",
        )}
      >
        {ehMsg ? <MessageSquare className="size-4" /> : <Sparkles className="size-4" />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {rotulo && <span className="text-muted-foreground truncate text-xs font-medium">{rotulo}</span>}
          {ehPr && (
            <div className="flex flex-wrap items-center gap-1.5">
              {alvo.repo && (
                <span className="bg-muted text-muted-foreground inline-flex items-center rounded px-1.5 py-0.5 font-mono text-xs">
                  {alvo.repo}
                </span>
              )}
              {alvo.pull && (
                <span className="text-primary inline-flex items-center gap-0.5 font-mono text-xs font-semibold">
                  <GitPullRequest aria-hidden className="size-3" />
                  #{alvo.pull}
                </span>
              )}
            </div>
          )}
          {ehMsg && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium inline-flex items-center rounded px-1.5 py-0.5 text-xs capitalize">
                {alvo.servico ?? (pendencia.kind.startsWith("slack") ? "slack" : "teams")}
              </span>
              {alvo.detalhe && (
                <span className="bg-muted text-muted-foreground inline-flex items-center rounded px-1.5 py-0.5 font-mono text-xs">
                  {alvo.detalhe}
                </span>
              )}
            </div>
          )}
        </div>

        <span className="truncate font-medium text-[15px] tracking-tight">{titulo}</span>

        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
          {alvo.autor && (
            <span className="inline-flex items-center gap-1">
              <User aria-hidden className="size-3 text-muted-foreground/70" />
              <span>{alvo.autor}</span>
            </span>
          )}
          {alvo.headBranch && alvo.baseBranch && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px]">
              <GitBranch aria-hidden className="size-3 text-muted-foreground/70" />
              <span className="text-foreground/80">{alvo.headBranch}</span>
              <span className="text-muted-foreground/60">→</span>
              <span>{alvo.baseBranch}</span>
            </span>
          )}
          {(alvo.additions !== undefined || alvo.deletions !== undefined) && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px] tabular-nums">
              {alvo.additions !== undefined && (
                <span className="text-emerald-500 font-medium">+{alvo.additions}</span>
              )}
              {alvo.deletions !== undefined && (
                <span className="text-rose-500 font-medium">−{alvo.deletions}</span>
              )}
            </span>
          )}
          {!ehPr && !ehMsg && alvo.detalhe && <span>{alvo.detalhe}</span>}
          {alvo.resumo && ehMsg && (
            <span className="line-clamp-1 italic text-muted-foreground/80">
              "{alvo.resumo}"
            </span>
          )}
          <span>·</span>
          <span>{quando}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {alvo.link && (
          <Button
            asChild
            className="shrink-0 cursor-pointer text-xs"
            size="sm"
            variant="outline"
          >
            <a href={alvo.link} rel="noreferrer" target="_blank">
              <ExternalLink aria-hidden className="mr-1 size-3.5" />
              {alvo.servico === "slack" ? "Slack" : "Teams"}
            </a>
          </Button>
        )}
        <Button className="shrink-0 cursor-pointer" onClick={() => navegar("inbox", pendencia.id)}>
          {alvo.somenteLeitura ? t("inbox.review") : t("home.today.waiting.open")}
        </Button>
      </div>
    </li>
  );
}

function LinhaTerminada({
  iniciativa,
  idioma,
  navegar,
  run,
}: {
  iniciativa: string | undefined;
  idioma: string;
  navegar: TelaProps["navegar"];
  run: Execucao;
}) {
  const { t } = useTranslation();
  const alvo = run.target;
  const ehPr = Boolean(alvo?.pull || alvo?.repo);
  // Execução sem evento de pull request não tem título próprio; o nome do
  // agent é o que diz de que trabalho se tratou.
  const titulo = alvo?.title
    ? alvo.title
    : alvo?.pull
      ? `${t("common.pull", { number: alvo.pull })}`
      : run.agentName;
  const quando = quandoTerminou(t, idioma, run.endedAt ?? run.createdAt);

  return (
    <li className="flex items-center gap-3.5 px-4 py-3">
      <Check aria-hidden className="text-chart-2 size-4 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {alvo?.repo && (
            <span className="bg-muted text-muted-foreground inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[11px]">
              {alvo.repo}
            </span>
          )}
          {alvo?.pull && (
            <span className="text-primary inline-flex items-center gap-0.5 font-mono text-xs font-semibold">
              <GitPullRequest aria-hidden className="size-3" />
              #{alvo.pull}
            </span>
          )}
          <span className="truncate text-sm font-medium">{titulo}</span>
        </div>

        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs">
          {iniciativa && <span className="text-foreground/75 font-medium">{iniciativa}</span>}
          {alvo?.author && (
            <span className="inline-flex items-center gap-1">
              <User aria-hidden className="size-3 text-muted-foreground/70" />
              <span>{alvo.author}</span>
            </span>
          )}
          {alvo?.headBranch && alvo?.baseBranch && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px]">
              <GitBranch aria-hidden className="size-3 text-muted-foreground/70" />
              <span className="text-foreground/80">{alvo.headBranch}</span>
              <span className="text-muted-foreground/60">→</span>
              <span>{alvo.baseBranch}</span>
            </span>
          )}
          {(alvo?.additions !== undefined || alvo?.deletions !== undefined) && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px] tabular-nums">
              {alvo.additions !== undefined && (
                <span className="text-emerald-500 font-medium">+{alvo.additions}</span>
              )}
              {alvo.deletions !== undefined && (
                <span className="text-rose-500 font-medium">−{alvo.deletions}</span>
              )}
            </span>
          )}
          <span>·</span>
          <span>{quando}</span>
        </div>
      </div>
      <button
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring shrink-0 cursor-pointer rounded px-1 text-sm transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none"
        data-locum-run={run.id}
        onClick={() => navegar("runs", run.id)}
        type="button"
      >
        {t("home.today.done.view")}
      </button>
    </li>
  );
}

/** Estado vazio de bloco: ícone apagado e uma frase, sem caixa pesada. */
function Vazio({ icone: Icone, texto }: { icone: typeof Check; texto: string }) {
  return (
    <div className="border-border text-muted-foreground flex items-center gap-3 rounded-xl border border-dashed px-4 py-4 text-sm">
      <Icone aria-hidden className="text-muted-foreground/60 size-4 shrink-0" />
      {texto}
    </div>
  );
}

/**
 * Lembrete das conversas do Claude Code esquecidas pela metade. Só aparece
 * quando há alguma: a Hoje não fala de sessão quando está tudo fechado.
 */
function SessoesPelaMetade({ navegar }: { navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  const sessoes = useRead("claudeSessions.list");
  if (sessoes.status !== "ready") return null;
  const pendentes = sessoes.data.filter((s) => s.state === "interrupted" || s.state === "unfinished");
  const esperando = sessoes.data.filter((s) => s.state === "waiting").length;
  if (pendentes.length === 0 && esperando === 0) return null;

  return (
    <button
      className="superficie hover:border-foreground/20 focus-visible:ring-ring group flex cursor-pointer items-center gap-4 rounded-xl px-5 py-4 text-left transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none"
      data-locum-probe="hoje-sessoes"
      onClick={() => navegar("sessions")}
      type="button"
    >
      <span aria-hidden className="bg-chart-5/12 text-chart-5 flex size-9 shrink-0 items-center justify-center rounded-lg">
        <TerminalSquare className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium text-[15px] tracking-tight">
          {t("home.today.sessions.title", { count: pendentes.length })}
        </span>
        <span className="text-muted-foreground truncate text-sm">
          {esperando > 0
            ? t("home.today.sessions.waiting", { count: esperando })
            : pendentes
                .slice(0, 3)
                .map((s) => s.title)
                .join(" · ")}
        </span>
      </div>
      <ChevronRight
        aria-hidden
        className="text-muted-foreground size-4 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5"
      />
    </button>
  );
}

/**
 * Servidor MCP cuja última conexão foi recusada por credencial. Aparece só
 * quando há algum: é o aviso que chega antes do achado que não veio.
 */
function ServidoresSemCredencial({ navegar }: { navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  const servidores = useRead("mcp.list");
  if (servidores.status !== "ready") return null;
  const recusados = servidores.data.filter((s) => s.enabled && s.health.needsAuth).map((s) => s.config.name);
  if (recusados.length === 0) return null;

  return (
    <button
      className="superficie hover:border-foreground/20 focus-visible:ring-ring group flex cursor-pointer items-center gap-4 rounded-xl px-5 py-4 text-left transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none"
      data-locum-probe="hoje-credencial"
      data-servidores={recusados.join(",")}
      onClick={() => navegar("settings")}
      type="button"
    >
      <span aria-hidden className="bg-destructive/12 text-destructive flex size-9 shrink-0 items-center justify-center rounded-lg">
        <KeyRound className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium text-[15px] tracking-tight">
          {t("home.today.auth.title", { count: recusados.length })}
        </span>
        <span className="text-muted-foreground truncate text-sm">
          {t("home.today.auth.detail", { names: recusados.slice(0, 3).join(", ") })}
        </span>
      </div>
      <ChevronRight
        aria-hidden
        className="text-muted-foreground size-4 shrink-0 transition-transform duration-200 group-hover:translate-x-0.5"
      />
    </button>
  );
}

/* ---------------------------------------------------------------- datas */

/** "Terça-feira, 29 de setembro". O Intl escreve o dia em minúscula no português. */
function dataDeHoje(idioma: string): string {
  const texto = new Intl.DateTimeFormat(idioma, { weekday: "long", day: "numeric", month: "long" }).format(
    new Date(),
  );
  return texto.charAt(0).toLocaleUpperCase(idioma) + texto.slice(1);
}

function tempoRelativoCurto(t: TFunction, segundos: number): string {
  const diffSegundos = Math.max(0, Math.floor(Date.now() / 1000 - segundos));
  if (diffSegundos < 60) return t("home.today.next.just_now");
  const minutos = Math.floor(diffSegundos / 60);
  if (minutos < 60) return t("home.today.next.minutes_ago", { count: minutos });
  return idade(t, segundos).texto;
}

function mesmoDia(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function hora(idioma: string, data: Date): string {
  return new Intl.DateTimeFormat(idioma, { hour: "2-digit", minute: "2-digit" }).format(data);
}

/**
 * Quando o gatilho acorda: só a hora se for hoje, dia curto e hora se não.
 *
 * Gatilho vencido tem `nextDueAt` no passado, e é a próxima batida que
 * acontecer. Mostrar a hora que já passou pareceria atraso; "agora" é o que
 * vai acontecer.
 */
function quandoRoda(t: TFunction, idioma: string, ms: number): string {
  if (ms <= Date.now()) return t("home.today.next.due");
  const data = new Date(ms);
  if (mesmoDia(data, new Date())) return hora(idioma, data);
  // O português abrevia com ponto ("qua."), que ao lado da hora só pesa.
  const dia = new Intl.DateTimeFormat(idioma, { weekday: "short" }).format(data).replace(/\.$/, "");
  return t("home.today.next.when", { day: dia, time: hora(idioma, data) });
}

/**
 * "Ontem, 21:20". Dia relativo pelo Intl, que já sabe dizer hoje, ontem e
 * anteontem em cada idioma, e a hora ao lado.
 */
function quandoTerminou(t: TFunction, idioma: string, segundos: number): string {
  const data = new Date(segundos * 1000);
  const meiaNoite = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dias = Math.round((meiaNoite(data) - meiaNoite(new Date())) / 86_400_000);
  const dia = new Intl.RelativeTimeFormat(idioma, { numeric: "auto" }).format(dias, "day");
  return t("home.today.done.when", { day: dia, time: hora(idioma, data) });
}

type Passo = { id: "model" | "connection" | "trigger"; feito: boolean; ir: () => void };

/**
 * O caminho até o primeiro agent rodar sozinho, enquanto falta alguma parte.
 *
 * São três coisas, nesta ordem: um modelo que responda, uma conexão de onde
 * vem o trabalho e um agent com gatilho ligado. Sem as três a Hoje fica vazia
 * e não diz por quê, então cada passo leva à tela que o resolve. O bloco some
 * quando tudo está feito, e não aparece enquanto alguma leitura não voltou,
 * para não piscar um passo pendente que já estava feito.
 */
const CHAVE_COMECE_OCULTO = "locum.hoje.comeceOculto";

function ComeceAqui({ agenda, navegar }: { agenda: Agenda[] | undefined; navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  const provedores = useRead("providers.list");
  const conexoes = useRead("connections.list");
  // Quem já usa o Locum e só não ligou gatilho ainda pode tirar o guia da frente.
  const [oculto, setOculto] = useState(() => {
    try {
      return window.localStorage.getItem(CHAVE_COMECE_OCULTO) === "1";
    } catch {
      return false;
    }
  });

  if (oculto || agenda === undefined || provedores.data === undefined || conexoes.data === undefined) return null;

  const passos: Passo[] = [
    {
      id: "model",
      feito: provedores.data.some((p) => p.available),
      ir: () => navegar("settings", "models"),
    },
    {
      id: "connection",
      feito: conexoes.data.some((c) => c.state === "connected" && c.id !== "claude-code"),
      ir: () => navegar("settings", "connections"),
    },
    {
      id: "trigger",
      feito: agenda.some((g) => g.enabled),
      ir: () => navegar("automations"),
    },
  ];
  if (passos.every((p) => p.feito)) return null;
  const proximo = passos.find((p) => !p.feito)!;

  const feitos = passos.filter((p) => p.feito).length;

  return (
    <section
      aria-labelledby="hoje-comece"
      className="superficie relative flex flex-col gap-5 overflow-hidden rounded-2xl p-6"
      data-locum-probe="hoje-comece"
    >
      <div className="flex items-end justify-between gap-6">
        <div className="flex flex-col gap-1">
          <h2 className="flex items-center gap-2 font-semibold text-[15px] tracking-tight" id="hoje-comece">
            <Sparkles aria-hidden className="text-primary size-4" />
            {t("home.today.start.title")}
          </h2>
          <p className="text-muted-foreground text-sm">{t("home.today.start.lead")}</p>
        </div>
        <span className="flex shrink-0 items-center gap-3">
          <span className="text-muted-foreground text-xs tabular-nums">
            {feitos}/{passos.length}
          </span>
          <button
            className="text-muted-foreground hover:text-foreground cursor-pointer text-xs"
            onClick={() => {
              setOculto(true);
              try {
                window.localStorage.setItem(CHAVE_COMECE_OCULTO, "1");
              } catch {
                // Sem armazenamento, oculta só até recarregar.
              }
            }}
            type="button"
          >
            {t("home.today.start.hide")}
          </button>
        </span>
      </div>
      <div aria-hidden className="bg-muted h-1 overflow-hidden rounded-full">
        <div
          className="ia-gradiente h-full rounded-full transition-[width] duration-500"
          style={{ width: `${(feitos / passos.length) * 100}%` }}
        />
      </div>
      <ol className="grid grid-cols-1 items-start gap-3 md:grid-cols-3">
        {passos.map((passo, indice) => (
          <li
            className={cn(
              "flex flex-col gap-3 rounded-xl border p-4 transition-colors",
              passo === proximo ? "ia-borda" : "border-border bg-background/40",
            )}
            data-feito={passo.feito}
            key={passo.id}
          >
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium",
                  passo.feito ? "ia-gradiente text-primary-foreground" : "border-border text-muted-foreground border",
                )}
              >
                {passo.feito ? <Check className="size-3.5" /> : indice + 1}
              </span>
              <span className={cn("text-sm font-medium", passo.feito && "text-muted-foreground")}>
                {t(`home.today.start.${passo.id}.title`)}
              </span>
            </div>
            {passo.feito ? null : (
              <>
                <span className="text-muted-foreground flex-1 text-xs leading-relaxed">
                  {t(`home.today.start.${passo.id}.hint`)}
                </span>
                <Button
                  className="cursor-pointer self-start"
                  onClick={passo.ir}
                  size="sm"
                  variant={passo === proximo ? "default" : "secondary"}
                >
                  {t(`home.today.start.${passo.id}.go`)}
                  <ChevronRight className="size-3.5" />
                </Button>
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
