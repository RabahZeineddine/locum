import { Check, ChevronDown, CircleHelp, FileDiff, GitBranch, Play, RefreshCw, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { BridgeError, call, read, type ReadResult } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import type { TelaProps } from "../rotas";

type Sessao = ReadResult<"claudeSessions.list">[number];
type Estado = Sessao["state"];

/** O registro do Claude Code muda sozinho; a tela relê nesse ritmo enquanto está aberta. */
const RELEITURA_MS = 15_000;

/**
 * A cor e o rótulo de cada estado. Trabalhando pulsa porque é o único estado
 * que muda enquanto se olha; o resto é parado de propósito.
 */
const ESTILO: Record<Estado, { regua: string; ponto: string; texto: string }> = {
  working: { regua: "bg-primary", ponto: "bg-primary", texto: "text-primary" },
  waiting: { regua: "bg-sev-medium", ponto: "bg-sev-medium", texto: "text-sev-medium" },
  interrupted: { regua: "bg-sev-high", ponto: "bg-sev-high", texto: "text-sev-high" },
  unfinished: { regua: "bg-chart-5", ponto: "bg-chart-5", texto: "text-chart-5" },
  done: { regua: "bg-chart-2/60", ponto: "bg-chart-2", texto: "text-chart-2" },
};

type Leitura =
  | { status: "loading" }
  | { status: "ready"; sessoes: Sessao[] }
  | { status: "error"; mensagem: string };

/**
 * As conversas do Claude Code desta máquina e o que ficou pela metade.
 *
 * A tela existe porque sessão esquecida não avisa: o terminal fecha, a
 * conversa para no meio de uma edição, e o trabalho some até alguém tropeçar
 * nele. Aqui ela fica à vista até alguém retomar ou dizer que terminou.
 */
export function Sessoes(_props: TelaProps) {
  const { t, i18n } = useTranslation();
  const [leitura, setLeitura] = useState<Leitura>({ status: "loading" });
  const [relendo, setRelendo] = useState(false);
  const [verTerminadas, setVerTerminadas] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  const reler = useCallback(async () => {
    setRelendo(true);
    try {
      const sessoes = await read("claudeSessions.list");
      setLeitura({ status: "ready", sessoes });
    } catch (erro) {
      setLeitura({ status: "error", mensagem: erro instanceof BridgeError ? erro.message : String(erro) });
    } finally {
      setRelendo(false);
    }
  }, []);

  useEffect(() => {
    void reler();
    const id = window.setInterval(() => void reler(), RELEITURA_MS);
    return () => window.clearInterval(id);
  }, [reler]);

  const sessoes = leitura.status === "ready" ? leitura.sessoes : [];
  const grupos = useMemo(() => {
    const abertas = sessoes.filter((s) => s.state === "working" || s.state === "waiting");
    const pendentes = sessoes.filter((s) => s.state === "interrupted" || s.state === "unfinished");
    const terminadas = sessoes.filter((s) => s.state === "done");
    return { abertas, pendentes, terminadas };
  }, [sessoes]);

  const agir = async (acao: () => Promise<unknown>) => {
    setAviso(null);
    try {
      await acao();
      await reler();
    } catch (erro) {
      setAviso(erro instanceof Error ? erro.message : String(erro));
    }
  };

  const acoes: Acoes = {
    retomar: (s) => agir(() => call("claudeSessions.resume", s.id)),
    terminar: (s) => agir(() => call("claudeSessions.markDone", s.id, s.lastActivityAt)),
    reabrir: (s) => agir(() => call("claudeSessions.reopen", s.id)),
  };

  return (
    <div
      className="flex max-w-5xl flex-col gap-8 pt-4"
      data-estado={leitura.status}
      data-locum-probe="sessoes"
      data-sessoes={leitura.status === "ready" ? sessoes.length : -1}
    >
      <header className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-semibold text-[32px] leading-tight tracking-[-0.02em]">{t("claudeSessions.title")}</h1>
          <p className="text-muted-foreground max-w-2xl text-[15px]">{t("claudeSessions.lead")}</p>
        </div>
        <Button
          aria-label={t("claudeSessions.refresh")}
          className="shrink-0 cursor-pointer"
          disabled={relendo}
          onClick={() => void reler()}
          size="sm"
          variant="ghost"
        >
          <RefreshCw aria-hidden className={cn("size-4", relendo && "animate-spin")} />
          {t("claudeSessions.refresh")}
        </Button>
      </header>

      {leitura.status === "ready" && sessoes.length > 0 && (
        <Placar abertas={grupos.abertas} pendentes={grupos.pendentes} terminadas={grupos.terminadas} />
      )}

      {aviso && (
        <p className="border-destructive/40 bg-destructive/10 text-destructive rounded-lg border px-4 py-2.5 text-sm" role="alert">
          {aviso}
        </p>
      )}

      {leitura.status === "error" ? (
        <p className="text-muted-foreground text-sm">{t("claudeSessions.refused", { message: leitura.mensagem })}</p>
      ) : leitura.status === "loading" ? (
        <p className="text-muted-foreground text-sm">{t("claudeSessions.loading")}</p>
      ) : sessoes.length === 0 ? (
        <div className="border-border/60 text-muted-foreground rounded-xl border border-dashed p-6 text-sm">
          {t("claudeSessions.empty")}
        </div>
      ) : (
        <>
          <Grupo
            acoes={acoes}
            idioma={i18n.language}
            id="sessoes-pendentes"
            sessoes={grupos.pendentes}
            titulo={t("claudeSessions.groups.unfinished", { count: grupos.pendentes.length })}
            vazio={t("claudeSessions.groups.unfinishedEmpty")}
          />
          <Grupo
            acoes={acoes}
            idioma={i18n.language}
            id="sessoes-abertas"
            sessoes={grupos.abertas}
            titulo={t("claudeSessions.groups.open", { count: grupos.abertas.length })}
            vazio={t("claudeSessions.groups.openEmpty")}
          />
          {grupos.terminadas.length > 0 && (
            <section className="flex flex-col gap-3">
              <button
                aria-expanded={verTerminadas}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex cursor-pointer items-center gap-1.5 self-start rounded font-semibold text-xs uppercase tracking-[0.06em] transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none"
                onClick={() => setVerTerminadas((v) => !v)}
                type="button"
              >
                <ChevronDown
                  aria-hidden
                  className={cn("size-4 transition-transform duration-200", !verTerminadas && "-rotate-90")}
                />
                {t("claudeSessions.groups.done", { count: grupos.terminadas.length })}
              </button>
              {verTerminadas && (
                <ul className="flex flex-col gap-2.5">
                  {grupos.terminadas.map((s) => (
                    <Cartao acoes={acoes} idioma={i18n.language} key={s.id} sessao={s} />
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

interface Acoes {
  retomar: (s: Sessao) => Promise<void>;
  terminar: (s: Sessao) => Promise<void>;
  reabrir: (s: Sessao) => Promise<void>;
}

/** Três números de relance: o que roda, o que espera, o que ficou para trás. */
function Placar({ abertas, pendentes, terminadas }: { abertas: Sessao[]; pendentes: Sessao[]; terminadas: Sessao[] }) {
  const { t } = useTranslation();
  const trabalhando = abertas.filter((s) => s.state === "working").length;
  const esperando = abertas.length - trabalhando;
  const itens: { estado: Estado; valor: number; rotulo: string }[] = [
    { estado: "working", valor: trabalhando, rotulo: t("claudeSessions.state.working") },
    { estado: "waiting", valor: esperando, rotulo: t("claudeSessions.state.waiting") },
    { estado: "interrupted", valor: pendentes.length, rotulo: t("claudeSessions.tally.unfinished") },
    { estado: "done", valor: terminadas.length, rotulo: t("claudeSessions.tally.done") },
  ];
  return (
    <dl className="border-border superficie grid grid-cols-2 overflow-hidden rounded-xl border sm:grid-cols-4">
      {itens.map((item, i) => (
        <div
          className={cn("relative flex flex-col gap-1 px-5 py-4", i > 0 && "sm:border-border sm:border-l")}
          key={item.estado}
        >
          <dt className="text-muted-foreground flex items-center gap-2 text-xs">
            <Ponto estado={item.estado} vivo={item.estado === "working" && item.valor > 0} />
            {item.rotulo}
          </dt>
          <dd className={cn("font-semibold text-2xl tabular-nums tracking-tight", item.valor === 0 && "text-muted-foreground/60")}>
            {item.valor}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Grupo({
  acoes,
  id,
  idioma,
  sessoes,
  titulo,
  vazio,
}: {
  acoes: Acoes;
  id: string;
  idioma: string;
  sessoes: Sessao[];
  titulo: string;
  vazio: string;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 className="text-muted-foreground font-semibold text-xs uppercase tracking-[0.06em]" id={id}>
        {titulo}
      </h2>
      {sessoes.length === 0 ? (
        <p className="text-muted-foreground text-sm">{vazio}</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {sessoes.map((s) => (
            <Cartao acoes={acoes} idioma={idioma} key={s.id} sessao={s} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Ponto({ estado, vivo = false }: { estado: Estado; vivo?: boolean }) {
  return (
    <span aria-hidden className="relative flex size-2 shrink-0">
      {vivo && (
        <span
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:animate-none",
            ESTILO[estado].ponto,
          )}
        />
      )}
      <span className={cn("relative inline-flex size-2 rounded-full", ESTILO[estado].ponto)} />
    </span>
  );
}

/**
 * Uma conversa: onde rodava, a última coisa pedida, a última coisa
 * respondida, e o que fazer com ela. A régua à esquerda é o estado.
 */
function Cartao({ acoes, idioma, sessao }: { acoes: Acoes; idioma: string; sessao: Sessao }) {
  const { t } = useTranslation();
  const [ocupado, setOcupado] = useState(false);
  const estilo = ESTILO[sessao.state];
  const aberta = sessao.state === "working" || sessao.state === "waiting";

  const rodar = (acao: (s: Sessao) => Promise<void>) => async () => {
    setOcupado(true);
    try {
      await acao(sessao);
    } finally {
      setOcupado(false);
    }
  };

  return (
    <li
      className={cn(
        "border-border superficie group relative flex gap-5 overflow-hidden rounded-xl border py-4 pr-5 pl-6",
        sessao.state === "done" && "opacity-70",
      )}
      data-locum-sessao={sessao.id}
      data-locum-sessao-estado={sessao.state}
    >
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", estilo.regua)} />

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className={cn("flex items-center gap-1.5 font-medium", estilo.texto)}>
            <Ponto estado={sessao.state} vivo={sessao.state === "working"} />
            {t(`claudeSessions.state.${sessao.state}`)}
          </span>
          <span className="text-muted-foreground">{quando(idioma, sessao.lastActivityAt)}</span>
          {sessao.askedQuestion && sessao.state !== "done" && (
            <span className="text-sev-medium flex items-center gap-1">
              <CircleHelp aria-hidden className="size-3.5" />
              {t("claudeSessions.asked")}
            </span>
          )}
          {sessao.uncommitted !== null && sessao.uncommitted > 0 && (
            <span className="text-sev-high flex items-center gap-1">
              <FileDiff aria-hidden className="size-3.5" />
              {t("claudeSessions.uncommitted", { count: sessao.uncommitted })}
            </span>
          )}
        </div>

        <span className="truncate font-medium text-[15px] tracking-tight" title={sessao.title}>
          {sessao.title}
        </span>

        <span className="text-muted-foreground flex min-w-0 items-center gap-2 font-mono text-xs">
          <span className="truncate" title={sessao.cwd}>
            {pastaCurta(sessao.cwd)}
          </span>
          {sessao.branch && (
            <span className="flex shrink-0 items-center gap-1">
              <GitBranch aria-hidden className="size-3.5" />
              {sessao.branch}
            </span>
          )}
        </span>

        {(sessao.lastPrompt || sessao.lastReply) && (
          <div className="border-border/70 mt-1 flex flex-col gap-1.5 border-l pl-3 text-sm">
            {sessao.lastPrompt && <Fala quem={t("claudeSessions.you")} texto={sessao.lastPrompt} />}
            {sessao.lastReply && <Fala quem="Claude" texto={sessao.lastReply} />}
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-end justify-center gap-2">
        {aberta ? (
          <span className="text-muted-foreground max-w-36 text-right text-xs">{t("claudeSessions.openHint")}</span>
        ) : sessao.state === "done" ? (
          <Button
            className="cursor-pointer"
            data-locum-sessao-reabrir
            disabled={ocupado}
            onClick={rodar(acoes.reabrir)}
            size="sm"
            variant="ghost"
          >
            <RotateCcw aria-hidden className="size-4" />
            {t("claudeSessions.reopen")}
          </Button>
        ) : (
          <>
            <Button className="cursor-pointer" disabled={ocupado} onClick={rodar(acoes.retomar)} size="sm">
              <Play aria-hidden className="size-4" />
              {t("claudeSessions.resume")}
            </Button>
            <Button
              className="cursor-pointer"
              data-locum-sessao-terminar
              disabled={ocupado}
              onClick={rodar(acoes.terminar)}
              size="sm"
              variant="ghost"
            >
              <Check aria-hidden className="size-4" />
              {t("claudeSessions.markDone")}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

function Fala({ quem, texto }: { quem: string; texto: string }) {
  return (
    <p className="line-clamp-2 min-w-0">
      <span className="text-muted-foreground mr-1.5 text-xs">{quem}</span>
      <span className="text-foreground/85">{texto}</span>
    </p>
  );
}

/** A pasta com o diretório da pessoa abreviado, que é o jeito que ela digita. */
function pastaCurta(cwd: string): string {
  return cwd.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

/** "há 3 horas", "ontem". O Intl sabe dizer em cada idioma. */
export function quando(idioma: string, segundos: number): string {
  const rtf = new Intl.RelativeTimeFormat(idioma, { numeric: "auto" });
  const delta = segundos - Date.now() / 1000;
  const abs = Math.abs(delta);
  if (abs < 60) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(delta / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(delta / 3600), "hour");
  return rtf.format(Math.round(delta / 86_400), "day");
}
