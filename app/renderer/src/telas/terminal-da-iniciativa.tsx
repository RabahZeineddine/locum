import { Button } from "@/components/ui/button";
import { call } from "@/lib/bridge";
import { assinarEventosDoTerminal } from "@/lib/terminal";
import { cn } from "@/lib/utils";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Maximize2, Minimize2, Plus, SquareTerminal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

type Aberto = Awaited<ReturnType<typeof call<"terminal.list">>>[number];

/**
 * Os terminais embutidos da iniciativa: cada um é uma sessão do Claude Code
 * na pasta dela, aberta pelo mesmo script da sessão no Terminal de fora. O
 * processo vive no processo principal; trocar de aba ou de tela não o encerra.
 */
export function AbaTerminal({ slug, focar, titulo }: { slug: string | null; focar?: string; titulo?: string }) {
  const { t } = useTranslation();
  const [cheia, setCheia] = useState(lerTelaCheia);
  const alternarTelaCheia = useCallback(() => {
    setCheia((atual) => {
      gravarTelaCheia(!atual);
      return !atual;
    });
  }, []);

  // ⌘⇧F alterna sem tirar a mão do teclado; Esc fica com o Claude Code, que
  // usa a tecla para interromper.
  useEffect(() => {
    const tecla = (e: KeyboardEvent): void => {
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        alternarTelaCheia();
      }
    };
    window.addEventListener("keydown", tecla, true);
    return () => window.removeEventListener("keydown", tecla, true);
  }, [alternarTelaCheia]);
  const [disponivel, setDisponivel] = useState<boolean | null>(null);
  const [terminais, setTerminais] = useState<Aberto[]>([]);
  const [ativo, setAtivo] = useState<string | null>(focar ?? null);
  const [erro, setErro] = useState<string | null>(null);
  const [abrindo, setAbrindo] = useState(false);

  const reler = useCallback(async () => {
    const lista = await call("terminal.list", slug);
    setTerminais(lista);
    setAtivo((atual) => (atual !== null && lista.some((x) => x.id === atual) ? atual : (lista.at(-1)?.id ?? null)));
  }, [slug]);

  useEffect(() => {
    void call("terminal.available").then(setDisponivel);
    void reler();
  }, [reler]);

  useEffect(() => {
    if (focar) setAtivo(focar);
  }, [focar]);

  useEffect(
    () =>
      assinarEventosDoTerminal((evento) => {
        if (evento.tipo === "aberto" && evento.iniciativa === slug) {
          void reler().then(() => setAtivo(evento.id));
        } else if (evento.tipo === "fim") {
          void reler();
        }
      }),
    [slug, reler],
  );

  async function nova() {
    setErro(null);
    setAbrindo(true);
    if (slug === null) return;
    try {
      await call("terminal.openSession", slug);
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setAbrindo(false);
    }
  }

  async function fechar(id: string) {
    await call("terminal.close", id);
    await reler();
  }

  if (disponivel === false) {
    return <p className="text-muted-foreground text-sm">{t("initiatives.detail.terminal.unavailable")}</p>;
  }

  const atual = terminais.find((x) => x.id === ativo);

  const barra = (
    <div className="flex flex-wrap items-center gap-2">
      {cheia && titulo ? <span className="mr-2 text-sm font-medium">{titulo}</span> : null}
      {terminais.map((x) => (
        <span
          className={cn(
            "border-border flex h-8 items-center gap-1.5 rounded-md border pr-1 pl-2.5 text-xs",
            x.id === ativo ? "bg-muted text-foreground" : "text-muted-foreground",
          )}
          key={x.id}
        >
          <button className="flex cursor-pointer items-center gap-1.5" onClick={() => setAtivo(x.id)} type="button">
            <span className={cn("size-1.5 rounded-full", x.vivo ? "bg-emerald-400" : "bg-muted-foreground/50")} />
            <span className="max-w-48 truncate">{x.titulo}</span>
          </button>
          <button
            aria-label={t("initiatives.detail.terminal.close")}
            className="hover:bg-accent cursor-pointer rounded p-0.5"
            onClick={() => void fechar(x.id)}
            type="button"
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      {slug !== null && (
        <Button className="cursor-pointer" disabled={abrindo} onClick={() => void nova()} size="sm" variant="outline">
          <Plus className="size-3.5" aria-hidden />
          {t("initiatives.detail.terminal.new")}
        </Button>
      )}
      <Button
        aria-label={t(cheia ? "initiatives.detail.terminal.exitFull" : "initiatives.detail.terminal.full")}
        className="ml-auto cursor-pointer"
        data-locum-terminal-cheio={cheia ? "sim" : "nao"}
        onClick={alternarTelaCheia}
        size="sm"
        title={t("initiatives.detail.terminal.fullHint")}
        variant="ghost"
      >
        {cheia ? <Minimize2 className="size-3.5" aria-hidden /> : <Maximize2 className="size-3.5" aria-hidden />}
        {t(cheia ? "initiatives.detail.terminal.exitFull" : "initiatives.detail.terminal.full")}
      </Button>
    </div>
  );

  const corpo = (
    <>
      {erro && <p className="text-sev-critical text-xs">{erro}</p>}
      {atual === undefined ? (
        <div
          className={cn(
            "border-border text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-sm",
            cheia ? "min-h-0 flex-1" : "h-[calc(100vh-330px)] min-h-[360px]",
          )}
        >
          <SquareTerminal className="size-5" aria-hidden />
          <p className="max-w-md text-center">{t("initiatives.detail.terminal.empty")}</p>
        </div>
      ) : (
        <TelaDoTerminal cheia={cheia} key={atual.id} terminal={atual} />
      )}
    </>
  );

  if (cheia) {
    // Cobre a janela inteira, menos a faixa dos botões do macOS, que fica
    // como região de arrasto.
    return (
      <div
        className="bg-background fixed inset-0 z-[45] flex flex-col gap-3 px-4 pb-4"
        data-locum-probe="initiative-terminal"
        data-total={terminais.length}
      >
        <div className="regiao-de-arrasto h-9 shrink-0" />
        {barra}
        {corpo}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-locum-probe="initiative-terminal" data-total={terminais.length}>
      {barra}
      {corpo}
    </div>
  );
}

const CHAVE_TELA_CHEIA = "locum.terminal.telaCheia";

function lerTelaCheia(): boolean {
  try {
    return localStorage.getItem(CHAVE_TELA_CHEIA) === "1";
  } catch {
    return false;
  }
}

function gravarTelaCheia(valor: boolean): void {
  try {
    localStorage.setItem(CHAVE_TELA_CHEIA, valor ? "1" : "0");
  } catch {
    // Sem armazenamento, a escolha vale só até fechar a tela.
  }
}

/** Um xterm ligado a um terminal do processo principal: escreve o que já saiu e segue o fluxo. */
function TelaDoTerminal({ cheia, terminal }: { cheia: boolean; terminal: Aberto }) {
  const { t } = useTranslation();
  const caixa = useRef<HTMLDivElement>(null);
  const [vivo, setVivo] = useState(terminal.vivo);

  useEffect(() => {
    const elemento = caixa.current;
    if (elemento === null) return;
    const xterm = new XTerm({
      cursorBlink: true,
      fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 5000,
      allowProposedApi: false,
      theme: {
        background: "#0f1115",
        foreground: "#e6e6e9",
        cursor: "#c4b5fd",
        selectionBackground: "#3b3f4a",
      },
    });
    const ajuste = new FitAddon();
    xterm.loadAddon(ajuste);
    xterm.open(elemento);

    let vivoAqui = true;
    let pendentes: string[] | null = [];
    const sair = assinarEventosDoTerminal((evento) => {
      if (evento.id !== terminal.id) return;
      if (evento.tipo === "dados") {
        if (pendentes !== null) pendentes.push(evento.dados);
        else xterm.write(evento.dados);
      } else if (evento.tipo === "fim") {
        setVivo(false);
      }
    });
    // O que saiu antes desta tela abrir vem do buffer; o que chega enquanto
    // ele é lido espera na fila, para nada sair fora de ordem.
    void call("terminal.buffer", terminal.id).then((anterior) => {
      if (!vivoAqui) return;
      xterm.write(anterior);
      for (const d of pendentes ?? []) xterm.write(d);
      pendentes = null;
    });

    const entrada = xterm.onData((dados) => void call("terminal.write", terminal.id, dados));
    const medir = () => {
      try {
        ajuste.fit();
        void call("terminal.resize", terminal.id, xterm.cols, xterm.rows);
      } catch {
        // Medir com a caixa escondida dá zero; a próxima medida corrige.
      }
    };
    const observador = new ResizeObserver(medir);
    observador.observe(elemento);
    medir();
    xterm.focus();

    return () => {
      vivoAqui = false;
      observador.disconnect();
      entrada.dispose();
      sair();
      xterm.dispose();
    };
  }, [terminal.id]);

  return (
    <div className={cn("flex flex-col gap-1.5", cheia && "min-h-0 flex-1")}>
      <div
        className={cn(
          "border-border overflow-hidden rounded-lg border bg-[#0f1115] p-2",
          cheia ? "min-h-0 flex-1" : "h-[calc(100vh-330px)] min-h-[360px]",
        )}
        data-locum-terminal={terminal.id}
        ref={caixa}
      />
      <p className="text-muted-foreground truncate font-mono text-[11px]">
        {vivo ? terminal.cwd : t("initiatives.detail.terminal.ended", { code: terminal.codigo ?? "?" })}
      </p>
    </div>
  );
}
