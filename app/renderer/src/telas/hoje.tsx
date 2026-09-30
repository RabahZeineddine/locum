import { Check, ChevronRight } from "lucide-react";
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
      <header className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-sm">{dataDeHoje(idioma)}</span>
        <h1 className="font-semibold text-2xl tracking-tight">{t("home.today.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("home.today.lead")}</p>
      </header>

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
          <div className="border-border/60 text-muted-foreground rounded-xl border border-dashed p-5 text-sm">
            {t("home.today.waiting.empty")}
          </div>
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section aria-labelledby="hoje-proximas" className="flex flex-col gap-3">
          <h2
            className="text-muted-foreground font-semibold text-xs uppercase tracking-[0.06em]"
            id="hoje-proximas"
          >
            {t("home.today.next.title")}
          </h2>
          {proximas.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {agenda.status === "loading" ? t("home.today.loading") : t("home.today.next.empty")}
            </p>
          ) : (
            <ul className="divide-border border-border bg-card divide-y overflow-hidden rounded-xl border">
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
            <p className="text-muted-foreground text-sm">
              {terminadas.status === "loading" ? t("home.today.loading") : t("home.today.done.empty")}
            </p>
          ) : (
            <ul className="divide-border border-border bg-card divide-y overflow-hidden rounded-xl border">
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

  return (
    <li className="border-border bg-card flex items-center gap-5 rounded-xl border px-5 py-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-muted-foreground truncate text-xs">{iniciativa ?? pendencia.agentName}</span>
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
