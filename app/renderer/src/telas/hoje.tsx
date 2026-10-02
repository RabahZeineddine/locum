import { CalendarClock, Check, CheckCheck, ChevronRight, Inbox as InboxIcon, KeyRound, Sparkles, TerminalSquare } from "lucide-react";
import { useEffect, useMemo } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { read, useRead, type ReadResult } from "@/lib/bridge";
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

  return (
    <div className="flex max-w-5xl flex-col gap-8 pt-2">
      <header className="flex flex-col gap-2 pt-4">
        <span className="text-muted-foreground font-medium text-xs uppercase tracking-[0.08em]">
          {dataDeHoje(idioma)}
        </span>
        <h1 className="font-semibold text-[32px] leading-tight tracking-[-0.02em]">
          <span className="ia-texto">{t("home.today.title")}</span>
        </h1>
        <p className="text-muted-foreground text-[15px]">{t("home.today.lead")}</p>
      </header>

      <ComeceAqui agenda={agenda.data} navegar={navegar} />

      <section aria-labelledby="hoje-espera" className="flex flex-col gap-3">
        <h2
          className={cn(
            "font-semibold text-xs uppercase tracking-[0.06em]",
            fila.length > 0 ? "text-sev-medium" : "text-muted-foreground",
          )}
          data-estado={pendentes.status}
          data-locum-probe="hoje"
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section aria-labelledby="hoje-proximas" className="flex flex-col gap-3">
          <h2
            className="text-muted-foreground font-semibold text-xs uppercase tracking-[0.06em]"
            id="hoje-proximas"
          >
            {t("home.today.next.title")}
          </h2>
          {proximas.length === 0 ? (
            <Vazio
              icone={CalendarClock}
              texto={agenda.status === "loading" ? t("home.today.loading") : t("home.today.next.empty")}
            />
          ) : (
            <ul className="divide-border border-border superficie divide-y overflow-hidden rounded-xl border">
              {proximas.map((g) => (
                <li className="flex items-center gap-3.5 px-4 py-3" key={g.triggerId}>
                  <span className="text-primary w-20 shrink-0 font-mono text-xs tabular-nums">
                    {quandoRoda(t, idioma, g.nextDueAt)}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm">{nomeDoAgent.get(g.agentId) ?? g.agentId}</span>
                    {iniciativaDoAgent.get(g.agentId) && (
                      <span className="text-muted-foreground truncate text-xs">
                        {iniciativaDoAgent.get(g.agentId)}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="hoje-terminou" className="flex flex-col gap-3">
          <h2
            className="text-muted-foreground font-semibold text-xs uppercase tracking-[0.06em]"
            id="hoje-terminou"
          >
            {t("home.today.done.title")}
          </h2>
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
  const detalhe = [alvo.titulo ? alvo.principal : undefined, alvo.repo ?? alvo.detalhe, quando]
    .filter((parte): parte is string => Boolean(parte))
    .join(" · ");
  // Pendência sem pull request já traz o nome do agent no título; repetir em
  // cima só faz a linha dizer a mesma coisa duas vezes.
  const rotulo = iniciativa ?? (titulo.includes(pendencia.agentName) ? undefined : pendencia.agentName);

  return (
    <li className="ia-borda group flex items-center gap-4 rounded-xl px-5 py-4 shadow-[0_8px_30px_-16px_var(--ia-2)]">
      <span
        aria-hidden
        className="bg-primary/12 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg"
      >
        <Sparkles className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {rotulo && <span className="text-muted-foreground truncate text-xs">{rotulo}</span>}
        <span className="truncate font-medium text-[15px] tracking-tight">{titulo}</span>
        <span className="text-muted-foreground truncate text-sm">{detalhe}</span>
      </div>
      <Button className="shrink-0 cursor-pointer" onClick={() => navegar("inbox", pendencia.id)}>
        {alvo.somenteLeitura ? t("inbox.review") : t("home.today.waiting.open")}
      </Button>
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
  // Execução sem evento de pull request não tem título próprio; o nome do
  // agent é o que diz de que trabalho se tratou.
  const titulo = alvo?.pull
    ? `${t("common.pull", { number: alvo.pull })}${alvo.title ? ` ${alvo.title}` : ""}`
    : run.agentName;
  const quando = quandoTerminou(t, idioma, run.endedAt ?? run.createdAt);

  return (
    <li className="flex items-center gap-3.5 px-4 py-3">
      <Check aria-hidden className="text-chart-2 size-4 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm">{titulo}</span>
        <span className="text-muted-foreground truncate text-xs">
          {iniciativa ? `${iniciativa} · ${quando}` : quando}
        </span>
      </div>
      <button
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring shrink-0 cursor-pointer rounded px-1 text-sm transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none"
        data-locum-run={run.id}
        onClick={() => navegar("execucoes", run.id)}
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
      onClick={() => navegar("sessoes")}
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
      onClick={() => navegar("configuracao")}
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
function ComeceAqui({ agenda, navegar }: { agenda: Agenda[] | undefined; navegar: TelaProps["navegar"] }) {
  const { t } = useTranslation();
  const provedores = useRead("providers.list");
  const conexoes = useRead("connections.list");

  if (agenda === undefined || provedores.data === undefined || conexoes.data === undefined) return null;

  const passos: Passo[] = [
    {
      id: "model",
      feito: provedores.data.some((p) => p.available),
      ir: () => navegar("configuracao", "modelos"),
    },
    {
      id: "connection",
      feito: conexoes.data.some((c) => c.state === "connected" && c.id !== "claude-code"),
      ir: () => navegar("configuracao", "conexoes"),
    },
    {
      id: "trigger",
      feito: agenda.some((g) => g.enabled),
      ir: () => navegar("agents"),
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
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {feitos}/{passos.length}
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
