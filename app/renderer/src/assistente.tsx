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
import { useCurrentInitiative } from "./current-initiative";
import { CornerDownLeft, MessageSquare, Square, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

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
export function Assistente() {
  const { t } = useTranslation();
  const [aberto, setAberto] = useState(false);
  const [falas, setFalas] = useState<Fala[]>([]);
  const [rascunho, setRascunho] = useState("");
  const [respondendo, setRespondendo] = useState(false);
  const [resumido, setResumido] = useState(false);
  const status = useRead("chat.status");
  const campo = useRef<HTMLTextAreaElement>(null);
  const { slug: iniciativaAtual } = useCurrentInitiative();

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

  useEffect(() => {
    if (aberto) campo.current?.focus();
  }, [aberto]);

  // O fluxo chega pedaco a pedaco e cai sempre na ultima fala do assistente.
  useEffect(() => {
    return assinarEventosDoChat((evento: ChatEvent) => {
      if (evento.tipo === "resumido") {
        setResumido(true);
        return;
      }
      setFalas((atual) => {
        const copia = [...atual];
        const ultima = copia.at(-1);
        if (!ultima || ultima.de !== "assistant") return copia;

        if (evento.tipo === "texto") ultima.texto += evento.delta;
        else if (evento.tipo === "ferramenta") ultima.ferramentas = [...ultima.ferramentas, evento.nome];
        else if (evento.tipo === "erro") ultima.texto += `\n\n[${evento.mensagem}]`;
        return copia;
      });

      if (evento.tipo === "fim" || evento.tipo === "erro") setRespondendo(false);
    });
  }, []);

  async function enviar() {
    const texto = rascunho.trim();
    if (!texto || respondendo) return;
    setRascunho("");
    setRespondendo(true);
    setFalas((a) => [
      ...a,
      { de: "user", texto, ferramentas: [] },
      { de: "assistant", texto: "", ferramentas: [] },
    ]);
    await call("chat.send", texto, iniciativaAtual ? { initiative: iniciativaAtual } : undefined);
  }

  if (!aberto) return <BotaoFlutuante aoAbrir={() => setAberto(true)} />;

  const indisponivel = status.status === "ready" && !status.data.disponivel;

  return (
    <aside
      className="sem-arrasto border-border bg-popover/97 animate-in slide-in-from-right-4 fixed top-0 right-0 bottom-0 z-40 flex w-[420px] flex-col border-l shadow-[-24px_0_48px_-12px_rgba(0,0,0,0.5)] backdrop-blur-xl duration-200"
      data-locum-probe="assistente-painel"
    >
      <header className="border-border flex items-center gap-2 border-b px-4 py-3">
        <MessageSquare className="text-muted-foreground size-4" aria-hidden />
        <span className="flex-1 text-sm font-medium">{t("assistant.title")}</span>
        {status.status === "ready" && status.data.modelo && (
          <span className="text-muted-foreground font-mono text-[11px]">{status.data.modelo}</span>
        )}
        <Button
          className="size-7 cursor-pointer"
          onClick={() => setAberto(false)}
          size="icon"
          variant="ghost"
        >
          <X className="size-4" aria-hidden />
          <span className="sr-only">{t("assistant.close")}</span>
        </Button>
      </header>

      <Conversation className="flex-1">
        <ConversationContent
          className={cn(
            "flex min-h-full flex-col gap-3 p-4",
            falas.length === 0 && "justify-center",
          )}
        >
          {falas.length === 0 && (
            <ConversationEmptyState
              description={
                indisponivel
                  ? (status.data.motivo ?? t("assistant.unavailable.body"))
                  : t("assistant.empty.body")
              }
              icon={<MessageSquare className="size-5" />}
              title={t(indisponivel ? "assistant.unavailable.title" : "assistant.empty.title")}
            />
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
                    {fala.ferramentas.join(", ")}
                  </p>
                )}
                <p className="whitespace-pre-wrap text-sm">
                  {fala.texto}
                  {respondendo && i === falas.length - 1 && (
                    <span className="bg-foreground/70 ml-0.5 inline-block h-3.5 w-1.5 animate-pulse align-middle" />
                  )}
                </p>
              </MessageContent>
            </Message>
          ))}
        </ConversationContent>
      </Conversation>

      <div className="border-border border-t p-3">
        <div
          className={cn(
            "border-border focus-within:border-ring bg-card flex items-end gap-2 rounded-lg border px-3 py-2 transition-colors duration-200",
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
              onClick={() => void call("chat.cancel")}
              size="icon"
              variant="ghost"
            >
              <Square className="size-3.5" aria-hidden />
              <span className="sr-only">{t("assistant.stop")}</span>
            </Button>
          ) : (
            <Button
              className="size-7 cursor-pointer"
              disabled={indisponivel || rascunho.trim().length === 0}
              onClick={() => void enviar()}
              size="icon"
              variant="ghost"
            >
              <CornerDownLeft className="size-3.5" aria-hidden />
              <span className="sr-only">{t("assistant.send")}</span>
            </Button>
          )}
        </div>
        <p className="text-muted-foreground/70 mt-1.5 text-xs">{t("assistant.disclaimer")}</p>
      </div>
    </aside>
  );
}

function BotaoFlutuante({ aoAbrir }: { aoAbrir: () => void }) {
  const { t } = useTranslation();

  return (
    <button
      className="border-border bg-card/90 hover:bg-accent focus-visible:ring-ring fixed right-5 bottom-5 z-40 flex h-10 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-sm shadow-lg backdrop-blur transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none"
      onClick={aoAbrir}
      type="button"
    >
      <MessageSquare className="size-4" aria-hidden />
      {t("assistant.title")}
      <kbd className="bg-muted rounded px-1 py-0.5 font-mono text-[10px]">
        {t("assistant.shortcut")}
      </kbd>
    </button>
  );
}
