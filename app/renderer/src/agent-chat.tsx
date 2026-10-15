import { Conversation, ConversationContent, ConversationEmptyState } from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useRead } from "@/lib/bridge";
import { chatDoAgent } from "@/lib/agent-chat";
import { cn } from "@/lib/utils";
import { AlertTriangle, ArrowUp, Bot, Check, RotateCcw, Square, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";
import {
  aplicarEvento,
  chaveDoAgent,
  type Cartao,
  type ConexaoSemServidor,
  type EventoDaConversa,
  type FalaDoAgent,
} from "../../src/agent-chat/tipos";

/**
 * A conversa com um agent da biblioteca, na aba Conversar do editor.
 *
 * O estado mora no processo principal: a tela pede o retrato ao montar e depois
 * só escuta o fluxo, descartando o que o retrato já contém. Trocar de tela no
 * meio de uma resposta, ou com um cartão à espera, volta onde estava.
 */
export function ChatDoAgent({ id, modelo, versao, naoSalvo }: { id: string; modelo: string; versao: number; naoSalvo: boolean }) {
  const { t } = useTranslation();
  const [falas, setFalas] = useState<FalaDoAgent[]>([]);
  const [respondendo, setRespondendo] = useState(false);
  const [resumido, setResumido] = useState(false);
  const [semServidor, setSemServidor] = useState<ConexaoSemServidor[]>([]);
  const [carregado, setCarregado] = useState(false);
  const [rascunho, setRascunho] = useState("");
  const [falha, setFalha] = useState<string | null>(null);
  const conexoes = useRead("connections.list");
  const campo = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let vivo = true;
    let seq: number | null = null;
    const guardados: EventoDaConversa[] = [];
    const aplicar = (evento: EventoDaConversa): void => {
      if (evento.tipo === "resumido") setResumido(true);
      if (evento.tipo === "fim") setRespondendo(false);
      setFalas((atual) => {
        const ultima = atual.at(-1);
        if (ultima?.de !== "assistant") return atual;
        return [...atual.slice(0, -1), aplicarEvento(ultima, evento)];
      });
    };
    setCarregado(false);
    setFalas([]);
    setFalha(null);
    const parar = chatDoAgent.assinar((evento) => {
      if (evento.chave !== chaveDoAgent(id)) return;
      // Antes do retrato chegar, guarda; depois, só vale o que veio depois dele.
      if (seq === null) guardados.push(evento);
      else if (evento.seq > seq) aplicar(evento);
    });
    chatDoAgent.estado(id).then(
      (estado) => {
        if (!vivo) return;
        seq = estado.seq;
        setFalas(estado.falas);
        setRespondendo(estado.respondendo);
        setResumido(estado.resumido);
        setSemServidor(estado.semServidor);
        setCarregado(true);
        for (const evento of guardados) if (evento.seq > estado.seq) aplicar(evento);
      },
      (erro: unknown) => {
        if (vivo) setFalha(erro instanceof Error ? erro.message : String(erro));
      },
    );
    return () => {
      vivo = false;
      parar();
    };
  }, [id]);

  const aguardando = falas.some((f) => f.cartoes.some((c) => c.estado === "pendente"));
  const nomes = new Map((conexoes.data ?? []).map((c) => [c.id, c.name]));

  async function enviar(): Promise<void> {
    const texto = rascunho.trim();
    if (texto === "" || respondendo || aguardando) return;
    setRascunho("");
    setRespondendo(true);
    setFalha(null);
    setFalas((a) => [...a, { de: "user", texto, ferramentas: [], cartoes: [] }, { de: "assistant", texto: "", ferramentas: [], cartoes: [] }]);
    try {
      await chatDoAgent.enviar(id, texto);
    } catch (erro) {
      setRespondendo(false);
      setFalha(erro instanceof Error ? erro.message : String(erro));
    }
  }

  async function decidir(cartao: Cartao, decisao: "executar" | "recusar"): Promise<void> {
    setFalha(null);
    try {
      await chatDoAgent.decidir(id, cartao.id, decisao);
    } catch (erro) {
      setFalha(erro instanceof Error ? erro.message : String(erro));
    }
  }

  async function recomecar(): Promise<void> {
    await chatDoAgent.limpar(id);
    setFalas([]);
    setResumido(false);
    setRespondendo(false);
  }

  return (
    <div className="border-border flex h-[640px] flex-col rounded-lg border" data-locum-agent-chat="">
      <div className="border-border flex items-center gap-2 border-b px-3 py-2">
        <Bot className="text-muted-foreground size-4" aria-hidden />
        <span className="text-sm font-medium">{t("agentChat.title")}</span>
        <span className="text-muted-foreground truncate font-mono text-[11px]">{modelo}</span>
        <Badge variant="outline">{t("agentChat.version", { version: versao })}</Badge>
        {falas.length > 0 && !respondendo ? (
          <button
            className="text-muted-foreground hover:text-foreground ml-auto flex cursor-pointer items-center gap-1 text-xs"
            data-locum-agent-chat-limpar=""
            onClick={() => void recomecar()}
            type="button"
          >
            <RotateCcw className="size-3" aria-hidden />
            {t("agentChat.reset")}
          </button>
        ) : null}
      </div>

      {semServidor.length === 0 && !naoSalvo ? null : (
        <div className="border-border flex flex-col gap-1 border-b px-3 py-2 text-xs" data-locum-agent-chat-avisos="">
          {semServidor.map((c) => (
            <p className="flex items-start gap-1.5 text-amber-400" key={c.connectionId}>
              <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
              {t("agentChat.noServer", { connection: nomes.get(c.connectionId) ?? c.connectionId, reason: c.motivo })}
            </p>
          ))}
          {naoSalvo ? <p className="text-muted-foreground">{t("agentChat.unsaved")}</p> : null}
        </div>
      )}

      <Conversation className="min-h-0 flex-1">
        <ConversationContent className={cn("flex min-h-full flex-col gap-3 p-4", falas.length === 0 && "justify-center")}>
          {falas.length === 0 && carregado ? (
            <ConversationEmptyState>
              <div className="space-y-1.5">
                <h3 className="text-base font-semibold">{t("agentChat.empty.title")}</h3>
                <p className="text-muted-foreground mx-auto max-w-80 text-sm">{t("agentChat.empty.body")}</p>
              </div>
            </ConversationEmptyState>
          ) : null}
          {resumido ? (
            <p className="text-muted-foreground/80 border-border rounded-md border border-dashed px-3 py-2 text-xs">{t("assistant.summarized")}</p>
          ) : null}
          {falas.map((fala, i) => (
            <Message from={fala.de} key={i}>
              <MessageContent>
                {fala.ferramentas.length > 0 ? (
                  <p className="text-muted-foreground mb-1.5 flex flex-wrap items-center gap-1 text-xs">
                    <Wrench className="size-3" aria-hidden />
                    {fala.ferramentas.map(nomeCurto).join(", ")}
                  </p>
                ) : null}
                {fala.de === "assistant" ? (
                  <div className="text-sm [&_pre]:text-xs" data-locum-agent-chat-resposta="">
                    <Streamdown>{fala.texto}</Streamdown>
                    {respondendo && i === falas.length - 1 && fala.cartoes.every((c) => c.estado !== "pendente") ? (
                      <span className="bg-foreground/70 ml-0.5 inline-block h-3.5 w-1.5 animate-pulse align-middle" />
                    ) : null}
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap text-sm">{fala.texto}</p>
                )}
                {fala.cartoes.map((cartao) => (
                  <CartaoDeEscrita
                    cartao={cartao}
                    decidir={(d) => void decidir(cartao, d)}
                    key={cartao.id}
                    nomeDaConexao={nomes.get(cartao.servidor)}
                  />
                ))}
              </MessageContent>
            </Message>
          ))}
        </ConversationContent>
      </Conversation>

      {falha === null ? null : (
        <p className="text-sev-critical border-border border-t px-3 py-2 text-xs" data-locum-agent-chat-erro="">
          {falha}
        </p>
      )}
      <div className="border-border border-t p-3">
        <div className="border-border bg-card focus-within:border-primary/50 flex items-end gap-2 rounded-xl border px-3 py-2.5">
          <textarea
            aria-label={t("agentChat.title")}
            className="max-h-32 min-h-[20px] flex-1 resize-none bg-transparent text-sm outline-none"
            disabled={!carregado || aguardando}
            onChange={(e) => setRascunho(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void enviar();
              }
            }}
            placeholder={t(aguardando ? "agentChat.placeholderPending" : "agentChat.placeholder")}
            ref={campo}
            rows={1}
            value={rascunho}
          />
          {respondendo ? (
            <Button className="size-7 cursor-pointer" data-locum-agent-chat-parar="" onClick={() => void chatDoAgent.cancelar(id)} size="icon" variant="ghost">
              <Square className="size-3.5" aria-hidden />
              <span className="sr-only">{t("assistant.stop")}</span>
            </Button>
          ) : (
            <Button
              className="size-7 cursor-pointer rounded-lg"
              data-locum-agent-chat-enviar=""
              disabled={!carregado || aguardando || rascunho.trim() === ""}
              onClick={() => void enviar()}
              size="icon"
              variant={rascunho.trim() === "" ? "ghost" : "default"}
            >
              <ArrowUp className="size-3.5" aria-hidden />
              <span className="sr-only">{t("assistant.send")}</span>
            </Button>
          )}
        </div>
        <p className="text-muted-foreground/70 mt-1.5 text-xs">{t("agentChat.note")}</p>
      </div>
    </div>
  );
}

/** A chamada de escrita que o agent quer fazer, à espera do clique de quem conversa. */
function CartaoDeEscrita({ cartao, decidir, nomeDaConexao }: { cartao: Cartao; decidir: (d: "executar" | "recusar") => void; nomeDaConexao: string | undefined }) {
  const { t } = useTranslation();
  const pendente = cartao.estado === "pendente";
  return (
    <div
      className={cn("border-border bg-muted/30 flex flex-col gap-2 rounded-lg border p-3", pendente && "border-amber-400/50")}
      data-estado={cartao.estado}
      data-locum-agent-cartao={cartao.ferramenta}
    >
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle className="size-3.5 text-amber-400" aria-hidden />
        <span className="text-xs font-medium">{t("agentChat.card.title")}</span>
        <span className="font-mono text-xs">
          {nomeDaConexao ?? cartao.servidor} · {cartao.ferramenta}
        </span>
        {pendente ? null : (
          <Badge className="ml-auto" variant="outline">
            {t(`agentChat.card.state.${cartao.estado}`)}
          </Badge>
        )}
      </div>
      <pre className="bg-background/60 max-h-48 overflow-auto rounded-md p-2 font-mono text-[11px] leading-relaxed" data-locum-agent-cartao-argumentos="">
        {JSON.stringify(cartao.argumentos, null, 2)}
      </pre>
      {cartao.estado === "expirado" ? <p className="text-muted-foreground text-xs">{t("agentChat.card.expiredHint")}</p> : null}
      {cartao.resultado === undefined ? null : (
        <p className="text-muted-foreground text-xs break-words" data-locum-agent-cartao-resultado="">
          {t("agentChat.card.result")}: {cartao.resultado}
        </p>
      )}
      {pendente ? (
        <div className="flex gap-2">
          <Button className="cursor-pointer" data-locum-agent-cartao-executar="" onClick={() => decidir("executar")} size="sm">
            <Check className="size-3.5" aria-hidden />
            {t("agentChat.card.run")}
          </Button>
          <Button className="cursor-pointer" data-locum-agent-cartao-recusar="" onClick={() => decidir("recusar")} size="sm" variant="outline">
            <X className="size-3.5" aria-hidden />
            {t("agentChat.card.refuse")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** `mcp__claude_ai_Microsoft_365__teams_list_chats` vira `teams_list_chats`. */
function nomeCurto(nome: string): string {
  return nome.replace(/^mcp__.+?__/, "");
}
