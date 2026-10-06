import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { call, useRead } from "@/lib/bridge";
import { assinarEventosDoChat, type ChatEvent } from "@/lib/chat";
import { cn } from "@/lib/utils";
import { EscolhaDoModelo } from "./assistente-modelo";
import { useCurrentInitiative } from "./current-initiative";
import type { TelaProps } from "./rotas";
import { ArrowUp, ChevronDown, RotateCcw, Settings2, Sparkles, Square, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";

interface Fala {
  de: "user" | "assistant";
  texto: string;
  ferramentas: string[];
}

/**
 * Console em linguagem natural, por cima da tela em que voce esta.
 *
 * Painel e nao quinta aba de proposito: a pergunta que ele recebe quase sempre
 * e sobre o que esta na tela, e mandar a pessoa sair da tela para perguntar
 * sobre ela e perder o assunto no caminho.
 *
 * Aprovar nao esta aqui e nao vai estar. O assistente le diff, achado e log,
 * que sao conteudo de terceiro; o catalogo dele vive em `electron/chat-tools.ts`
 * e e escrito a mao pelo motivo da emenda 5 do ADR 0003.
 */
export function Assistente({ navegar }: Pick<TelaProps, "navegar">) {
  const [aberto, setAberto] = useState(false);
  // Sobe a cada troca de modelo para o painel reler o estado do chat: a
  // leitura não tem recarga, e a conversa precisa saber que agora há modelo.
  const [versao, setVersao] = useState(0);

  useEffect(() => {
    function ouvir(evento: KeyboardEvent) {
      if (evento.key.toLowerCase() === "j" && (evento.metaKey || evento.ctrlKey)) {
        evento.preventDefault();
        setAberto((v) => !v);
      }
      if (evento.key === "Escape") setAberto(false);
    }
    globalThis.addEventListener("keydown", ouvir);
    return () => globalThis.removeEventListener("keydown", ouvir);
  }, []);

  if (!aberto) return <BotaoFlutuante aoAbrir={() => setAberto(true)} />;

  return (
    <PainelDoAssistente
      aoFechar={() => setAberto(false)}
      aoTrocarModelo={() => setVersao((v) => v + 1)}
      key={versao}
      navegar={navegar}
    />
  );
}

/**
 * O painel aberto. O modelo fica no cabeçalho e troca ali mesmo: escolher
 * provedor e modelo é coisa de conversa, e mandar a pessoa para Configuração
 * no meio dela é perder o assunto.
 */
function PainelDoAssistente({
  navegar,
  aoFechar,
  aoTrocarModelo,
}: Pick<TelaProps, "navegar"> & { aoFechar: () => void; aoTrocarModelo: () => void }) {
  const { t } = useTranslation();
  const status = useRead("chat.status");
  const { slug: iniciativaAtual } = useCurrentInitiative();
  const [escolhendo, setEscolhendo] = useState(false);
  const modelo = status.status === "ready" ? status.data.modelo : null;

  return (
    <aside
      className="sem-arrasto border-border bg-popover/97 animate-in slide-in-from-right-4 fixed top-0 right-0 bottom-0 z-40 flex w-[420px] flex-col border-l shadow-[-24px_0_48px_-12px_rgba(0,0,0,0.5)] backdrop-blur-xl duration-200"
      data-locum-probe="assistente-painel"
    >
      <header className="border-border flex items-center gap-2 border-b px-4 py-3">
        <span className="ia-gradiente flex size-6 items-center justify-center rounded-md">
          <Sparkles className="text-primary-foreground size-3.5" aria-hidden />
        </span>
        <span className="flex-1 text-sm font-semibold tracking-[-0.01em]">{t("assistant.title")}</span>
        <button
          aria-expanded={escolhendo}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex max-w-[220px] cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[11px] focus-visible:ring-2 focus-visible:outline-none"
          onClick={() => setEscolhendo((v) => !v)}
          type="button"
        >
          <span className="truncate">{modelo ?? t("assistant.model.none")}</span>
          <ChevronDown className="size-3 shrink-0" aria-hidden />
        </button>
        <Button className="size-7 cursor-pointer" data-locum-fechar="" onClick={aoFechar} size="icon" variant="ghost">
          <X className="size-4" aria-hidden />
          <span className="sr-only">{t("assistant.close")}</span>
        </Button>
      </header>
      {escolhendo ? (
        <div className="border-border max-h-[50vh] overflow-y-auto border-b">
          <EscolhaDoModelo aoEscolher={aoTrocarModelo} />
        </div>
      ) : null}
      <Conversa
        foco
        iniciativa={iniciativaAtual ?? undefined}
        irParaModelos={() => {
          aoFechar();
          navegar("settings", "models");
        }}
      />
    </aside>
  );
}

/**
 * Uma conversa com o assistente: a geral, ou a de uma iniciativa. A mesma
 * conversa aparece no painel flutuante e na aba Chat da iniciativa, guardada
 * no processo principal; quem não mandou a mensagem relê as falas no fim.
 */
export function Conversa({
  iniciativa,
  irParaModelos,
  foco = false,
}: {
  iniciativa?: string;
  irParaModelos: () => void;
  foco?: boolean;
}) {
  const { t } = useTranslation();
  const [falas, setFalas] = useState<Fala[]>([]);
  const [rascunho, setRascunho] = useState("");
  const [respondendo, setRespondendo] = useState(false);
  const [resumido, setResumido] = useState(false);
  const status = useRead("chat.status");
  const campo = useRef<HTMLTextAreaElement>(null);
  const meu = useRef(false);
  const chave = iniciativa ?? "geral";
  const contexto = iniciativa ? { initiative: iniciativa } : undefined;

  useEffect(() => {
    if (foco) campo.current?.focus();
  }, [foco]);

  useEffect(() => {
    let vivo = true;
    setFalas([]);
    setResumido(false);
    void call("chat.history", iniciativa ? { initiative: iniciativa } : undefined).then((guardadas) => {
      if (vivo) setFalas(guardadas);
    });
    return () => {
      vivo = false;
    };
  }, [iniciativa]);

  // O fluxo chega pedaco a pedaco e cai sempre na ultima fala do assistente.
  useEffect(() => {
    return assinarEventosDoChat((evento: ChatEvent) => {
      if (evento.chave !== chave) return;
      if (!meu.current) {
        // Mensagem mandada por outra janela desta conversa: relê no fim.
        if (evento.tipo === "fim" || evento.tipo === "erro") {
          void call("chat.history", iniciativa ? { initiative: iniciativa } : undefined).then(setFalas);
        }
        return;
      }
      if (evento.tipo === "resumido") {
        setResumido(true);
        return;
      }
      setFalas((atual) => {
        const copia = [...atual];
        const ultima = copia.at(-1);
        if (!ultima || ultima.de !== "assistant") return copia;
        const nova = { ...ultima };
        if (evento.tipo === "texto") nova.texto += evento.delta;
        else if (evento.tipo === "ferramenta") nova.ferramentas = [...nova.ferramentas, evento.nome];
        else if (evento.tipo === "erro") nova.texto += `\n\n[${evento.mensagem}]`;
        copia[copia.length - 1] = nova;
        return copia;
      });

      if (evento.tipo === "fim" || evento.tipo === "erro") {
        meu.current = false;
        setRespondendo(false);
      }
    });
  }, [chave, iniciativa]);

  async function enviar() {
    const texto = rascunho.trim();
    if (!texto || respondendo) return;
    setRascunho("");
    setRespondendo(true);
    meu.current = true;
    setFalas((a) => [
      ...a,
      { de: "user", texto, ferramentas: [] },
      { de: "assistant", texto: "", ferramentas: [] },
    ]);
    await call("chat.send", texto, contexto);
  }

  async function recomecar() {
    await call("chat.reset", contexto);
    setFalas([]);
    setResumido(false);
  }

  const indisponivel = status.status === "ready" && !status.data.disponivel;

  return (
    <>
      <Conversation className="min-h-0 flex-1">
        <ConversationContent
          className={cn(
            "flex min-h-full flex-col gap-3 p-4",
            falas.length === 0 && "justify-center",
          )}
        >
          {falas.length === 0 && (
            <ConversationEmptyState>
              <span className="ia-gradiente flex size-12 items-center justify-center rounded-2xl shadow-[0_0_40px_-6px_var(--ia-2)]">
                <Sparkles className="text-primary-foreground size-5" aria-hidden />
              </span>
              <div className="mt-2 space-y-1.5">
                <h3 className="font-semibold text-base tracking-[-0.01em]">
                  {t(indisponivel ? "assistant.unavailable.title" : "assistant.empty.title")}
                </h3>
                <p className="text-muted-foreground mx-auto max-w-72 text-sm">
                  {indisponivel
                    ? (status.data.motivo ?? t("assistant.unavailable.body"))
                    : t(iniciativa ? "assistant.empty.bodyInitiative" : "assistant.empty.body")}
                </p>
              </div>
              {indisponivel && (
                <Button
                  className="mt-3 cursor-pointer"
                  data-locum-assistente-modelo
                  onClick={irParaModelos}
                  size="sm"
                >
                  <Settings2 className="size-3.5" aria-hidden />
                  {t("assistant.unavailable.go")}
                </Button>
              )}
            </ConversationEmptyState>
          )}

          {/* As falas continuam todas na tela; o aviso é sobre o que o modelo ainda enxerga. */}
          {resumido && (
            <p className="text-muted-foreground/80 border-border rounded-md border border-dashed px-3 py-2 text-xs">
              {t("assistant.summarized")}
            </p>
          )}

          {falas.map((fala, i) => (
            <Message from={fala.de} key={i}>
              <MessageContent>
                {fala.ferramentas.length > 0 && (
                  <p className="text-muted-foreground mb-1.5 flex flex-wrap items-center gap-1 text-xs">
                    <Wrench className="size-3" aria-hidden />
                    {fala.ferramentas.map(nomeCurto).join(", ")}
                  </p>
                )}
                {fala.de === "assistant" ? (
                  <div className="text-sm [&_pre]:text-xs">
                    <Streamdown>{fala.texto}</Streamdown>
                    {respondendo && i === falas.length - 1 && (
                      <span className="bg-foreground/70 ml-0.5 inline-block h-3.5 w-1.5 animate-pulse align-middle" />
                    )}
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap text-sm">{fala.texto}</p>
                )}
              </MessageContent>
            </Message>
          ))}
        </ConversationContent>
      </Conversation>

      <div className="border-border border-t p-3">
        <div
          className={cn(
            "border-border focus-within:border-primary/50 focus-within:shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_15%,transparent)] bg-card flex items-end gap-2 rounded-xl border px-3 py-2.5 transition-shadow duration-200",
            indisponivel && "opacity-60",
          )}
        >
          <textarea
            className="max-h-32 min-h-[20px] flex-1 resize-none bg-transparent text-sm outline-none"
            disabled={indisponivel}
            onChange={(e) => setRascunho(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void enviar();
              }
            }}
            placeholder={t(
              indisponivel ? "assistant.placeholderUnavailable" : "assistant.placeholder",
            )}
            ref={campo}
            rows={1}
            value={rascunho}
          />
          {respondendo ? (
            <Button
              className="size-7 cursor-pointer"
              onClick={() => void call("chat.cancel", contexto)}
              size="icon"
              variant="ghost"
            >
              <Square className="size-3.5" aria-hidden />
              <span className="sr-only">{t("assistant.stop")}</span>
            </Button>
          ) : (
            <Button
              className="size-7 cursor-pointer rounded-lg"
              disabled={indisponivel || rascunho.trim().length === 0}
              onClick={() => void enviar()}
              size="icon"
              variant={rascunho.trim().length === 0 ? "ghost" : "default"}
            >
              <ArrowUp className="size-3.5" aria-hidden />
              <span className="sr-only">{t("assistant.send")}</span>
            </Button>
          )}
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <p className="text-muted-foreground/70 flex-1 text-xs">{t("assistant.disclaimer")}</p>
          {falas.length > 0 && !respondendo && (
            <button
              className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-1 text-xs"
              onClick={() => void recomecar()}
              type="button"
            >
              <RotateCcw className="size-3" aria-hidden />
              {t("assistant.reset")}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/** `mcp__claude_ai_Microsoft_365__teams_list_chats` vira `teams_list_chats`. */
function nomeCurto(nome: string): string {
  return nome.replace(/^mcp__.+?__/, "");
}

function BotaoFlutuante({ aoAbrir }: { aoAbrir: () => void }) {
  const { t } = useTranslation();

  return (
    <button
      className="ia-borda bg-card/90 hover:bg-accent focus-visible:ring-ring fixed right-5 bottom-5 z-40 flex h-10 cursor-pointer items-center gap-2 rounded-full px-3.5 text-sm shadow-lg backdrop-blur transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none"
      onClick={aoAbrir}
      type="button"
    >
      <Sparkles className="text-primary size-4" aria-hidden />
      {t("assistant.title")}
      <kbd className="bg-muted rounded px-1 py-0.5 font-mono text-[10px]">
        {t("assistant.shortcut")}
      </kbd>
    </button>
  );
}
