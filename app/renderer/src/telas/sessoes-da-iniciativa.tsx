import { CircleStop, FileText, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BridgeError, call, read, type ReadResult } from "@/lib/bridge";
import { Cartao, quando, type Acoes } from "./sessoes";

type IniciativaDetalhada = NonNullable<ReadResult<"initiatives.detail">>;
type SessaoDoLocum = ReadResult<"sessions.list">[number];
type SessaoDoClaude = ReadResult<"claudeSessions.list">[number];

/** O mesmo ritmo da tela de sessões: o registro do Claude Code muda sozinho. */
const RELEITURA_MS = 15_000;

type Leitura =
  | { status: "loading" }
  | { status: "ready"; locum: SessaoDoLocum[]; claude: SessaoDoClaude[] }
  | { status: "error"; mensagem: string };

/** A conversa rodou na pasta de contexto, num repositório ou num worktree da iniciativa. */
function pertence(cwd: string, pastas: string[]): boolean {
  return pastas.some((pasta) => cwd === pasta || cwd.startsWith(`${pasta}/`));
}

/**
 * As sessões da iniciativa: as que o Locum abriu, com passagem e estado, e as
 * conversas do Claude Code que rodaram nas pastas dela. O Locum passa o próprio
 * id como `--session-id`, então a conversa de uma sessão aberta daqui é achada
 * pelo id; as outras, pela pasta.
 */
export function AbaSessoes({ iniciativa }: { iniciativa: IniciativaDetalhada }) {
  const { t, i18n } = useTranslation();
  const [leitura, setLeitura] = useState<Leitura>({ status: "loading" });
  const [aviso, setAviso] = useState<string | null>(null);
  const slug = iniciativa.slug;

  const reler = useCallback(async () => {
    try {
      const [locum, claude] = await Promise.all([read("sessions.list", slug), read("claudeSessions.list")]);
      setLeitura({ status: "ready", locum, claude });
    } catch (erro) {
      setLeitura({ status: "error", mensagem: erro instanceof BridgeError ? erro.message : String(erro) });
    }
  }, [slug]);

  useEffect(() => {
    void reler();
    const id = window.setInterval(() => void reler(), RELEITURA_MS);
    return () => window.clearInterval(id);
  }, [reler]);

  const pastas = useMemo(
    () => [
      iniciativa.contextPath,
      ...iniciativa.workspaces.flatMap((w) => (w.worktreePath ? [w.repoPath, w.worktreePath] : [w.repoPath])),
    ],
    [iniciativa],
  );

  const { conversaDe, outras } = useMemo(() => {
    if (leitura.status !== "ready") return { conversaDe: new Map<string, SessaoDoClaude>(), outras: [] };
    const doLocum = new Set(leitura.locum.map((s) => s.id));
    const conversaDe = new Map(leitura.claude.filter((c) => doLocum.has(c.id)).map((c) => [c.id, c]));
    const outras = leitura.claude.filter((c) => !doLocum.has(c.id) && pertence(c.cwd, pastas));
    return { conversaDe, outras };
  }, [leitura, pastas]);

  const agir = async (acao: () => Promise<string | null>) => {
    setAviso(null);
    try {
      setAviso(await acao());
      await reler();
    } catch (erro) {
      setAviso(erro instanceof Error ? erro.message : String(erro));
    }
  };

  const acoes: Acoes = {
    retomar: (s) => agir(() => call("claudeSessions.resume", s.id, slug).then(() => null)),
    terminar: (s) => agir(() => call("claudeSessions.markDone", s.id, s.lastActivityAt).then(() => null)),
    reabrir: (s) => agir(() => call("claudeSessions.reopen", s.id).then(() => null)),
  };

  if (leitura.status === "loading") {
    return <p className="text-muted-foreground text-sm">{t("initiatives.detail.sessions.loading")}</p>;
  }
  if (leitura.status === "error") {
    return (
      <p className="text-muted-foreground text-sm">
        {t("initiatives.detail.sessions.refused", { message: leitura.mensagem })}
      </p>
    );
  }

  return (
    <div
      className="space-y-6"
      data-locum-outras={outras.length}
      data-locum-probe="initiative-sessions"
      data-total={leitura.locum.length}
    >
      {aviso && <p className="text-muted-foreground text-xs">{aviso}</p>}

      <section className="space-y-2">
        <h2 className="text-sm font-medium">{t("initiatives.detail.sessions.locum")}</h2>
        {leitura.locum.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("initiatives.detail.sessions.locumEmpty")}</p>
        ) : (
          <ul className="divide-border border-border superficie divide-y overflow-hidden rounded-lg border">
            {leitura.locum.map((sessao) => (
              <LinhaDaSessao
                agir={agir}
                conversa={conversaDe.get(sessao.id)}
                idioma={i18n.language}
                key={sessao.id}
                sessao={sessao}
                slug={slug}
              />
            ))}
          </ul>
        )}
      </section>

      {outras.length > 0 && (
        <section className="space-y-2">
          <div>
            <h2 className="text-sm font-medium">{t("initiatives.detail.sessions.others")}</h2>
            <p className="text-muted-foreground text-xs">{t("initiatives.detail.sessions.othersHint")}</p>
          </div>
          <ul className="flex flex-col gap-3">
            {outras.map((sessao) => (
              <Cartao acoes={acoes} idioma={i18n.language} key={sessao.id} sessao={sessao} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function LinhaDaSessao({
  agir,
  conversa,
  idioma,
  sessao,
  slug,
}: {
  agir: (acao: () => Promise<string | null>) => Promise<void>;
  conversa: SessaoDoClaude | undefined;
  idioma: string;
  sessao: SessaoDoLocum;
  slug: string;
}) {
  const { t } = useTranslation();
  const [ocupado, setOcupado] = useState(false);
  // Com o processo do Claude vivo, a sessão não está largada: encerrar ou
  // retomar só vale depois que ele sai.
  const vivo = conversa?.pid != null;

  const rodar = (acao: () => Promise<string | null>) => async () => {
    setOcupado(true);
    try {
      await agir(acao);
    } finally {
      setOcupado(false);
    }
  };

  const lerPassagem = rodar(() =>
    call("sessions.readHandoff", slug, sessao.id).then((lida) =>
      lida === null
        ? t("initiatives.detail.actions.noHandoff")
        : t("initiatives.detail.sessions.proposed", { file: lida.file }),
    ),
  );
  const encerrar = rodar(() => call("sessions.close", sessao.id).then(() => t("initiatives.detail.sessions.closed")));
  const retomar = rodar(() => call("claudeSessions.resume", sessao.id, slug).then(() => null));

  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-sm"
      data-locum-sessao={sessao.id}
      data-locum-sessao-estado={sessao.status}
    >
      <Badge variant={sessao.status === "open" ? "secondary" : "outline"}>
        {t(`initiatives.detail.sessions.status.${sessao.status}`)}
      </Badge>
      <span>{quando(idioma, sessao.startedAt)}</span>
      <span className="text-muted-foreground text-xs">{t(`settings.sessionTerminal.${sessao.terminal}`)}</span>
      {conversa && (
        <span className="text-muted-foreground text-xs">
          {t("initiatives.detail.sessions.claude", { state: t(`claudeSessions.state.${conversa.state}`) })}
        </span>
      )}
      <span className="text-muted-foreground font-mono text-xs">
        {sessao.hasHandoff ? sessao.handoffPath : t("initiatives.detail.sessions.noHandoff")}
      </span>

      <span className="ml-auto flex gap-1.5">
        {sessao.status !== "read" && sessao.hasHandoff && (
          <Button className="cursor-pointer" disabled={ocupado} onClick={lerPassagem} size="sm" variant="secondary">
            <FileText className="size-3.5" />
            {t("initiatives.detail.sessions.readHandoff")}
          </Button>
        )}
        {conversa && !vivo && (
          <Button className="cursor-pointer" disabled={ocupado} onClick={retomar} size="sm" variant="ghost">
            <Play className="size-3.5" />
            {t("initiatives.detail.sessions.resume")}
          </Button>
        )}
        {sessao.status === "open" && !vivo && (
          <Button
            className="cursor-pointer"
            disabled={ocupado}
            onClick={encerrar}
            size="sm"
            title={t("initiatives.detail.sessions.closeHint")}
            variant="ghost"
          >
            <CircleStop className="size-3.5" />
            {t("initiatives.detail.sessions.close")}
          </Button>
        )}
      </span>
    </li>
  );
}
